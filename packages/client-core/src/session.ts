/**
 * La session Matrix : l'ouvrir, la restaurer, la fermer — et tout ce qui en dépend.
 *
 * Quatre responsabilités, dans l'ordre où on les lit :
 *
 *  1. Identifiants — `openSession` (identifiant + mot de passe) et `restoreSession`
 *     (jeton relu depuis IndexedDB). Le mot de passe ne survit pas à l'appel.
 *  2. Crypto et récupération — amorçage vodozemac, secret storage dérivé du mot de
 *     passe, `recoveryState()` en trois cas, `setupRecoveryKey`, `unlockRecovery`.
 *  3. Persistance — le store du SDK n'écrit que toutes les cinq minutes ; on force
 *     l'écriture quand la page s'en va, sinon une session courte ne laisse rien.
 *  4. Lectures — timeline dans l'ordre du flux /sync, liste des appareils.
 *
 * Aucun autre paquet n'importe matrix-js-sdk pour la session : tous reçoivent la
 * `Session` construite ici.
 */
import {
  createClient,
  HttpApiEvent,
  IndexedDBStore,
  type MatrixClient,
  type MatrixEvent,
} from "matrix-js-sdk";
// La racine du SDK n'exporte pas les classes de `crypto-api` (seulement des types) et
// ce mode est une *valeur*, pas un type : le sous-chemin est le seul accès. Module
// léger, aucun wasm tiré avec lui.
// ponytail: casse si le SDK réorganise ses chemins ; repasser à la racine le jour où
// elle réexporte crypto-api.
import {
  decodeRecoveryKey,
  deriveRecoveryKeyFromPassphrase,
  encodeRecoveryKey,
  OnlySignedDevicesIsolationMode,
} from "matrix-js-sdk/lib/crypto-api";
import { Method } from "matrix-js-sdk/lib/http-api/method";

import { createLogger } from "./logger";

/** Types dérivés du SDK : pas de réimport de sous-chemins internes. */
export type CryptoApi = NonNullable<ReturnType<MatrixClient["getCrypto"]>>;
export type RecoveryKey = Awaited<ReturnType<CryptoApi["createRecoveryKeyFromPassphrase"]>>;

export interface SessionConfig {
  /** Homeserver Synapse, derrière le proxy TLS. */
  homeserverUrl: string;
  /**
   * **identifiant et mot de passe**, réécrit.
   *
   * Le module recevait ici un `loginToken` émis par un fournisseur OIDC externe, et se
   * targuait de ne connaître aucun secret utilisateur. Keycloak supprimé, l'identité est
   * portée par Synapse : le mot de passe traverse donc ce module. Il n'y est **jamais
   * conservé** — ni en mémoire après l'appel, ni en IndexedDB, où seuls l'`access_token`
   * et l'identité d'appareil sont écrits (`StoredCredentials`).
   *
   * `identifiant` est le localpart (`alice`), pas l'identifiant complet : c'est ce que
   * l'écran de connexion demande, et `m.login.password` l'accepte tel quel via un
   * `identifier` de type `m.id.user`.
   */
  identifiant: string;
  motDePasse: string;
  /** surchargeable en test ; `globalThis.indexedDB` en navigateur. */
  indexedDB?: IDBFactory;
}

/** ce qu'il faut pour rouvrir la session, et rien de plus. */
interface StoredCredentials {
  accessToken: string;
  userId: string;
  deviceId: string;
}

/**
 * l'état de la clé de récupération **du point de vue de cet appareil-ci**,
 * en trois cas et pas deux. C'est la distinction qui manquait : un booléen « clé requise »
 * confond « ce compte n'a pas de clé » et « ce compte en a une, que cet appareil n'a pas
 * reçue ». Le second est le cas normal de toute reconnexion — chaque `m.login.token`
 * donne un `device_id` neuf — et le traiter comme le premier proposait de *créer* une clé
 * à quelqu'un qui en a déjà une, donc d'écraser sa sauvegarde.
 *
 * - `prete` — cet appareil est signé par l'identité de son propriétaire ; il peut chiffrer.
 * - `creation` — le compte n'a aucune sauvegarde : c'est l'inscription.
 * - `deverrouillage` — la sauvegarde existe ; cet appareil attend la clé (`unlockRecovery`).
 */
export type RecoveryState = "prete" | "creation" | "deverrouillage";

/** Les deux cas de `setupRecoveryKey`. Voir le membre de `Session` pour le contrat. */
/**
 * un appareil connecté au compte, tel que l'écran de réglages le montre.
 *
 * `derniereActivite` est en millisecondes, et **peut manquer** : Synapse ne la connaît
 * que si l'appareil a parlé depuis qu'il la retient. L'écran doit donc savoir ne rien
 * afficher plutôt qu'inventer une date — un « jamais vu » lu comme « inactif » ferait
 * révoquer le mauvais appareil.
 */
export interface Appareil {
  id: string;
  nom?: string;
  derniereActivite?: number;
  /** Celui d'où l'on regarde. Il ne se révoque pas ici : c'est la déconnexion. */
  courant: boolean;
}

export interface SetupRecoveryOptions {
  reinitialiser?: boolean;
  /**
   * **le mot de passe, quand le serveur le redemande pour remplacer une
   * identité** (réécrit).
   *
   * Deux choses ont changé le même jour, et il faut les tenir séparées. **Le premier
   * dépôt d'identité ne demande plus rien** : relu dans le servlet de la v1.155.0, une
   * mise en place initiale passe sans UIA est éteinte, l'inscription ne rencontre
   * aucune épreuve. **Le remplacement, lui, en demande une**, et c'est désormais
   * `m.login.password` puisque Keycloak est parti.
   *
   * Ce rappel n'est appelé que dans ce second cas, et **seulement si le module n'a pas
   * déjà le mot de passe** : une session ouverte par identifiant et mot de passe le porte
   * en mémoire, et redemander ce qu'on vient de recevoir serait un geste de plus
   * pour rien. Il ne sert donc qu'après un rechargement de page, où la session est
   * restaurée depuis le disque et où plus personne ne connaît le mot de passe.
   *
   * Absent quand il est nécessaire, un 401 remonte tel quel à l'appelant.
   */
  demanderMotDePasse?: () => Promise<string>;
}

/**
 * Le défi UIA `m.login.password` d'une erreur, s'il y en a un — l'identifiant de session
 * à rejouer avec le mot de passe.
 *
 * **Réécrit.** Cette fonction cherchait `m.login.sso`, et c'était juste tant
 * que Keycloak portait l'identité. D-12 l'a supprimé le matin même ; Synapse propose
 * désormais `m.login.password`, que ce client ne reconnaissait pas. Conséquence mesurée :
 * la réinitialisation de clé — le seul recours d'une clé perdue — remontait un 401 brut
 * sans même appeler l'écran de confirmation. Une porte de secours fermée en silence.
 *
 * Lu en canard plutôt que par `instanceof MatrixError` : la suite mocke `matrix-js-sdk`
 * et n'exporte que ce que le module utilise vraiment. On ne fait ici que lire
 * la forme documentée de la réponse 401.
 *
 * Un flow à plusieurs étapes est ignoré volontairement : rejouer la session après le seul
 * mot de passe ne l'achèverait pas, et faire comme si serait une garantie qu'on n'offre pas.
 */
function defiMotDePasse(erreur: unknown): string | undefined {
  const { httpStatus, data } = (erreur ?? {}) as {
    httpStatus?: number;
    data?: { session?: string; flows?: { stages?: string[] }[] };
  };
  if (httpStatus !== 401) return undefined;
  const parMotDePasse = data?.flows?.some(
    (flow) => flow.stages?.length === 1 && flow.stages[0] === "m.login.password",
  );
  return parMotDePasse ? data?.session : undefined;
}

/**
 * Le dictionnaire d'authentification que Synapse attend pour franchir un stage
 * `m.login.password`. Écrit une fois : trois appels le rejouent (dépôt d'identité,
 * révocation d'appareil, et ce qui viendra), et trois copies dériveraient.
 */
function authMotDePasse(userId: string, motDePasse: string, session: string) {
  return {
    type: "m.login.password",
    identifier: { type: "m.id.user", user: userId },
    password: motDePasse,
    session,
  };
}

/**
 * **Le plancher de longueur du mot de passe, écrit une seule fois pour tout le dépôt.**
 *
 * Il vivait à deux endroits qui ne se lisaient pas — le module Synapse et l'écran de
 * changement — et à aucun des deux qui compte : la création de compte n'en avait aucun.
 * Mesuré, un compte s'est créé avec le mot de passe « a ». Depuis, ce
 * mot de passe **est** la clé qui déchiffre tout l'historique.
 *
 * Le garde opposable est celui de Synapse (`password_config.policy`) ; cette constante-ci
 * rend la faute immédiate à l'écran, et un test d'infra vérifie que les deux disent le
 * même nombre — sans quoi l'un des deux mentirait à l'utilisateur.
 */
export const LONGUEUR_MINIMALE_MOT_DE_PASSE = 12;

export interface OrderedTimeline {
  /**
   * ordre canonique du flux /sync, tel que le SDK l'a accumulé.
   * Aucun tri par `origin_server_ts` : l'horodatage est indicatif seulement.
   */
  events(): MatrixEvent[];
  /**
   * **remonte l'historique d'un cran, au serveur.**
   *
   * Sans elle, ce qu'un salon affiche est exactement ce que /sync a laissé dans
   * l'accumulateur du store, c'est-à-dire une fenêtre courte et **glissante** : les
   * messages plus vieux que cette fenêtre sortent du store et rien n'allait plus les
   * chercher. Signalé par les utilisateurs — « quelques jours après, mes anciens
   * messages ne se chargeaient plus » —, et c'était exact : rien dans le dépôt
   * n'appelait `/messages`.
   *
   * Rend `true` s'il reste de l'historique en amont, `false` quand on a atteint le
   * début du salon — c'est ce qui permet à l'UI de cesser de demander.
   *
   * L'ordre reste celui du flux : les événements arrivent **en tête** de la timeline
   * du SDK, dans l'ordre que le serveur donne. Rien n'est trié ici (interdit n°6).
   */
  paginate(limit?: number): Promise<boolean>;
}

export interface Session {
  /** Accès contrôlé pour les autres packages : eux n'importent pas matrix-js-sdk. */
  readonly client: MatrixClient;
  timeline(roomId: string): OrderedTimeline;
  /**
   * état de chiffrement du salon, en **prédicat** : il rend `false`,
   * il ne lève jamais. Les gardes d'envoi de `@tacita/messaging` et 07 s'appuient dessus.
   *
   * `false` tant que l'état est inconnu — avant le premier `/sync` abouti, ou si la
   * crypto n'est pas là. C'est le sens qu'on veut : dans le doute, on n'envoie pas.
   * Aucune mémorisation ici ; une garde qui ment est pire que pas de garde.
   */
  isEncrypted(roomId: string): Promise<boolean>;
  /**
   * l'état de la porte d'onboarding. Voir {@link RecoveryState}
   * pour ce que chaque valeur engage.
   *
   * La question qu'il pose est **locale** : cet appareil porte-t-il la signature de son
   * propriétaire ? Le magasin crypto y répond sans réseau, et c'est ce qui rend la porte
   * juste hors ligne. L'ancienne source — « une version de sauvegarde est-elle active ? » —
   * ne le pouvait pas : le SDK ne la connaît qu'après l'avoir relue au serveur.
   */
  recoveryState(): Promise<RecoveryState>;
  /**
   * l'inscription : une clé neuve, la sauvegarde amorcée, le cross-signing
   * en place. Rend la clé **une seule fois**, à afficher ; elle n'est jamais
   * persistée.
   *
   * `reinitialiser` est le cas « j'ai perdu ma clé » : il remplace le secret storage et
   * l'identité cross-signing existants. **Il est destructif** — l'historique chiffré sous
   * l'ancienne sauvegarde devient définitivement illisible — et l'UI doit le dire avant
   * de l'appeler. Sans lui, une clé perdue est un compte mort sans recours.
   *
   * Ce cas-là **exige `confirmerIdentite`** : le serveur réclame une ré-authentification
   * SSO pour remplacer une identité, et sans rappel l'appel échoue sur un 401.
   */
  setupRecoveryKey(options?: SetupRecoveryOptions): Promise<RecoveryKey>;
  /**
   * **la deuxième connexion.** Déverrouille le secret storage avec la clé
   * que l'utilisateur a conservée, signe cet appareil de son identité cross-signing (sans
   * quoi D-08 le laisse muet *et* sourd), et rebranche la sauvegarde de clés.
   *
   * Lève, et c'est normatif : sur une clé malformée, sur une clé qui ne correspond pas au
   * secret storage du compte, sur un compte qui n'en a pas. Une saisie fausse acceptée en
   * silence débloquerait l'UI devant un client qui ne déchiffrera rien (interdit n°13).
   */
  unlockRecovery(encodedKey: string): Promise<void>;
  /**
   * **les appareils connectés au compte**, celui d'où l'on regarde compris.
   *
   * Sans cette liste, une fuite de jeton n'a aucune réponse : les jetons de ce
   * déploiement n'expirent pas, et le changement de mot de passe ne déconnecte
   * volontairement personne (pour ne pas faire perdre leur historique aux autres
   * appareils). Voir sans pouvoir agir ne servirait à rien non plus — d'où
   * {@link Session.revoquerAppareils}, qui vient avec.
   */
  appareils(): Promise<Appareil[]>;
  /**
   * **révoque des appareils**, donc leurs jetons d'accès.
   *
   * Le serveur exige une ré-authentification, et c'est heureux : c'est le geste qu'un
   * intrus retournerait contre le titulaire. Le mot de passe de la session courante est
   * utilisé s'il est connu ; sinon l'appelant le fournit — après un rechargement
   * de page, plus personne ne l'a.
   *
   * Lève si le serveur refuse : une révocation qu'on croit faite et qui ne l'est pas est
   * pire que pas de bouton du tout (interdit n°13).
   */
  revoquerAppareils(ids: string[], motDePasse?: string): Promise<void>;
  /**
   * / D-08 — `true` quand cet utilisateur a **changé d'identité** depuis
   * qu'on l'a vue pour la première fois. Ses anciennes signatures ne valent alors plus
   * rien, et l'UI doit exiger une confirmation explicite avant tout nouvel
   * envoi vers lui — pas un avertissement ignorable.
   *
   * Le membre existe pour que le shard n'ait **rien à dériver lui-même** : `CLAUDE.md`
   * lui interdit toute logique métier, et lire `needsUserApproval` sur le crypto en
   * serait.
   */
  identityResetOf(userId: string): Promise<boolean>;
  /**
   * / D-08 — la confirmation explicite que l'exigence demande à l'UI, rendue
   * effective : elle épingle la nouvelle identité de cet utilisateur comme authentique,
   * et les envois vers lui repartent.
   *
   * Le pendant de `identityResetOf`. Sans lui, le shard détecterait la réinitialisation
   * sans pouvoir la lever autrement qu'en appelant le crypto lui-même — de la logique
   * métier dans `apps/web`, que `CLAUDE.md` interdit.
   *
   * **Lève**, contrairement à `identityResetOf` : sur notre propre identifiant, ou sur
   * un utilisateur dont on n'a aucune identité. Une confirmation qui échoue en silence
   * ferait débloquer l'UI alors que le chiffrement refusera toujours.
   */
  confirmIdentityOf(userId: string): Promise<void>;
  /** un package déclare ici comment effacer ses propres stores. */
  registerWipe(name: string, wipe: () => Promise<void> | void): void;
  logout(): Promise<void>;
}

const CREDENTIALS_DB = "tacita-session";
const CREDENTIALS_STORE = "credentials";
const CREDENTIALS_KEY = "current";

/**
 * les credentials en IndexedDB, seul stockage autorisé (interdit n°2).
 *
 * Ils y sont **en clair** : `initRustCrypto` tourne sans clé de pickle, donc l'état
 * crypto voisin — clés Megolm comprises — l'est déjà. Chiffrer le seul jeton en
 * laissant les clés à côté présenterait une garantie que le module n'offre pas
 * (interdit n°13). Limite et conditions pour la relever : README.md, à consigner en
 * `DECISIONS.md` avant toute implémentation.
 *
 * ponytail: troisième copie du motif open/commit IndexedDB (avec outbox et search).
 * Le factoriser ici et l'exporter le jour où C3 et C4 sont tous deux sur main —
 * refactorer à cheval sur deux branches coûterait plus que la duplication.
 */
async function openCredentials(indexedDB: IDBFactory) {
  const request = indexedDB.open(CREDENTIALS_DB, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(CREDENTIALS_STORE);
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  // On attend `oncomplete` et non `onsuccess` : le succès d'une requête précède le
  // commit, qui peut encore avorter. Un jeton annoncé écrit mais absent au
  // rechargement renverrait l'utilisateur vers l'OIDC sans raison visible.
  const commit = (mutate: (store: IDBObjectStore) => void): Promise<void> =>
    new Promise((resolve, reject) => {
      const transaction = db.transaction(CREDENTIALS_STORE, "readwrite");
      mutate(transaction.objectStore(CREDENTIALS_STORE));
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error("transaction IndexedDB avortée"));
    });

  return {
    read: () =>
      new Promise<StoredCredentials | undefined>((resolve, reject) => {
        const query = db
          .transaction(CREDENTIALS_STORE, "readonly")
          .objectStore(CREDENTIALS_STORE)
          .get(CREDENTIALS_KEY);
        query.onsuccess = () => resolve(query.result as StoredCredentials | undefined);
        query.onerror = () => reject(query.error);
      }),
    write: (credentials: StoredCredentials) =>
      commit((store) => {
        store.put(credentials, CREDENTIALS_KEY);
      }),
    clear: () =>
      commit((store) => {
        store.clear();
      }),
  };
}

/** Le magasin, pas les credentials : `saved.read()`, pas `saved.accessToken`. */
type CredentialStore = Awaited<ReturnType<typeof openCredentials>>;

/**
 * **Une connexion remplace l'appareil précédent de ce navigateur, elle ne l'abandonne pas.**
 *
 * Chaque connexion crée un appareil Matrix neuf. Quand `restoreSession` échoue sans que
 * le jeton ait été refusé (store crypto illisible, wasm absent), il rend `null` *sans*
 * effacer — et l'utilisateur se reconnecte. L'ancien appareil gardait alors un jeton
 * valide pour toujours, et son pusher avec : un compte en accumulait un par reprise
 * ratée, chacun capable de lire ses notifications.
 *
 * Seul l'appareil dont ce navigateur détient le jeton est visé, avec ce jeton-là : aucun
 * mot de passe à redemander, aucun moyen de toucher le téléphone ou l'ordinateur d'à
 * côté. Un échec (jeton déjà mort, réseau) ne fait jamais échouer la connexion.
 */
async function remplacerAppareil(
  saved: CredentialStore,
  credentials: StoredCredentials,
  homeserverUrl: string,
): Promise<void> {
  const precedent = await saved.read().catch(() => undefined);
  await saved.write(credentials);
  if (
    !precedent ||
    precedent.userId !== credentials.userId ||
    precedent.deviceId === credentials.deviceId
  ) {
    return;
  }
  await createClient({
    baseUrl: homeserverUrl,
    accessToken: precedent.accessToken,
    userId: precedent.userId,
    deviceId: precedent.deviceId,
  })
    .logout()
    .catch(() => {});
}

function requireCrypto(client: MatrixClient): CryptoApi {
  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("crypto non initialisée : aucune session ne doit exister sans E2EE");
  }
  return crypto;
}

/** Type de l'argument, dérivé du SDK plutôt que réimporté. */
type DeviceIsolationMode = Parameters<CryptoApi["setDeviceIsolationMode"]>[0];

/**
 * — les clés Megolm ne sont partagées qu'avec les appareils que
 * leur propriétaire a signés de son identité cross-signing. Le mode est posé puis
 * verrouillé : toute tentative de le desserrer lève, plutôt que d'échouer en silence.
 *
 * Ce que ce mode déclenche dans le SDK, vérifié sur la version épinglée (42.0.0) :
 * `CollectStrategy.identityBasedStrategy()` au chiffrement — la confiance portée sur
 * l'identité, mot pour mot ce que D-08 décide — et `TrustRequirement.CrossSignedOrLegacy`
 * au déchiffrement, donc un événement venu d'un appareil non signé reste illisible.
 *
 * Le verrou ne porte **plus** sur `globalBlacklistUnverifiedDevices` : la doc du SDK
 * dit « Ignored when deviceIsolationMode is OnlySignedDevicesIsolationMode ». L'ancien
 * verrou protégeait donc un drapeau devenu sans effet, et le drapeau lui-même exigeait
 * des appareils *vérifiés* — la rédaction que D-08 a écartée. Corollaire : l'override
 * par salon (`Room.setBlacklistUnverifiedDevices`) ne mord plus non plus.
 */
function lockSignedDevicesOnly(crypto: CryptoApi): void {
  crypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
  Object.defineProperty(crypto, "setDeviceIsolationMode", {
    value: (mode: DeviceIsolationMode) => {
      if (!(mode instanceof OnlySignedDevicesIsolationMode)) {
        throw new Error(" : le mode d'isolation des appareils est verrouillé");
      }
    },
    configurable: false,
    writable: false,
    enumerable: true,
  });
}

/**
 * Queue commune aux deux entrées : la seule différence entre une première connexion
 * et une reprise est l'origine des credentials.
 */
async function buildSession(
  credentials: StoredCredentials,
  config: Omit<SessionConfig, "identifiant" | "motDePasse">,
  saved: CredentialStore,
  /**
   * **le mot de passe du compte, s'il vient d'être saisi**, et rien d'autre n'en
   * est fait : il sert de phrase de passe à la clé de récupération (`setupRecoveryKey`).
   *
   * Il vit dans cette fermeture le temps de la session et **n'est jamais écrit** — ni en
   * IndexedDB, où `StoredCredentials` ne porte que le jeton et l'appareil, ni dans un
   * log. `restoreSession` n'en a pas et n'en a pas besoin : au rechargement, l'appareil
   * est déjà signé.
   */
  phraseDePasse?: string,
): Promise<Session> {
  const log = createLogger();

  // IndexedDB est le seul store de persistance : historique consultable
  // hors ligne. localStorage/sessionStorage ne sont jamais touchés.
  const store = new IndexedDBStore({
    indexedDB: config.indexedDB ?? globalThis.indexedDB,
    dbName: "tacita",
  });

  /**
   * la clé de récupération que `setupRecoveryKey()` vient de générer.
   * Le SDK ne la conserve pas : il rappelle l'application chaque fois qu'il doit
   * déverrouiller le secret storage pour y écrire. Sans ce rappel,
   * `bootstrapSecretStorage` lève « No getSecretStorageKey callback supplied » et
   * **aucune inscription ne peut aboutir**.
   *
   * Elle ne vit qu'en mémoire, le temps de la session : la persister reviendrait à
   * garder la clé qui déverrouille tout à côté de ce qu'elle protège, et
   * `client-core/README.md` promet qu'elle n'est jamais persistée.
   */
  let recoveryKey: RecoveryKey | undefined;

  const client = createClient({
    baseUrl: config.homeserverUrl,
    accessToken: credentials.accessToken,
    userId: credentials.userId,
    deviceId: credentials.deviceId,
    store,
    cryptoCallbacks: {
      getSecretStorageKey: async ({ keys }) => {
        // Rien à rendre tant qu'aucune clé n'a été générée dans cette session : le
        // SDK bascule alors sur son propre chemin d'erreur, ce qui est correct.
        const privateKey = recoveryKey?.privateKey;
        const [keyId] = Object.keys(keys);
        return privateKey && keyId ? [keyId, privateKey] : null;
      },
    },
  });

  // `startup()` **après** l'affectation au client, jamais avant : le SDK lève
  // « must be called after assigning it to the client » quand il relit un store
  // existant. Sur une base vierge l'ordre inverse passe — c'est pourquoi ni la
  // suite sur mocks ni un premier lancement ne le voyaient, et pourquoi seule la
  // reprise de session échouait, à chaque fois.
  await store.startup();

  // vodozemac via le SDK (`initRustCrypto`), libolm interdit.
  // la crypto est prête avant que quoi que ce soit puisse être envoyé :
  // le client n'est rendu à l'appelant qu'après cette étape, donc aucun contenu ne
  // peut sortir en clair. Olm pour la négociation entre appareils, Megolm pour les
  // salons, rotation des sessions : gérés nativement par le SDK, rien à réécrire.
  // `cryptoDatabasePrefix` dérivé du `device_id` plutôt que le défaut fixe du SDK :
  // le magasin de clés appartient à un appareil, pas à un navigateur. Au rechargement
  // le `device_id` est le même, donc les clés sont retrouvées ; deux identités dans le
  // même profil ne se marchent plus dessus. Sans ça, le SDK refuse d'ouvrir un magasin
  // qui appartient à quelqu'un d'autre — « the account in the store doesn't match the
  // account in the constructor ».
  await client.initRustCrypto({
    useIndexedDB: true,
    cryptoDatabasePrefix: `matrix-js-sdk-${credentials.deviceId}`,
  });
  lockSignedDevicesOnly(requireCrypto(client));

  // ouvre la boucle /sync, du long-polling HTTP.
  await client.startClient({ initialSyncLimit: 20 });

  /*
   * **forcer l'écriture du store quand la page s'en va.**
   *
   * `IndexedDBStore` du SDK n'écrit son accumulateur de sync qu'une fois toutes les cinq
   * minutes (`WRITE_DELAY_MS`). Tout ce qui est arrivé depuis la dernière écriture n'est
   * nulle part sur disque : mesuré au navigateur, une conversation rouverte
   * hors ligne après rechargement était vide, alors que les messages venaient d'être lus
   * à l'écran. Une session de moins de cinq minutes ne laissait aucune trace.
   *
   * Les deux événements, et pas seulement `pagehide` : sur mobile, une application mise
   * en arrière-plan puis tuée par le système ne voit jamais `pagehide`.
   */
  const persister = () => {
    void client.store.save(true).catch(() => log.warn("écriture du store SDK échouée"));
  };
  const surVisibilite = () => {
    if (globalThis.document?.visibilityState === "hidden") persister();
  };
  globalThis.addEventListener?.("pagehide", persister);
  globalThis.document?.addEventListener("visibilitychange", surVisibilite);

  const wipes = new Map<string, () => Promise<void> | void>();

  return {
    client,

    timeline(roomId) {
      return {
        events: () => client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? [],

        /*
         * `scrollback` plutôt que `paginateEventTimeline` : il porte déjà le jeton de
         * pagination du salon, insère les événements dans la timeline vive — celle que
         * `events()` lit —, et **déduplique les appels concurrents** (le SDK rend la
         * même promesse tant qu'une requête est en vol). Un défilement qui déclenche
         * deux demandes n'en fait donc qu'une.
         *
         * `oldState.paginationToken` à `null` est le signal documenté du SDK pour
         * « début du salon atteint ». On le relit **après** la requête, sinon on
         * répondrait sur l'état d'avant.
         */
        async paginate(limit = 50) {
          const room = client.getRoom(roomId);
          if (!room) return false;
          await client.scrollback(room, limit);
          return room.oldState.paginationToken !== null;
        },
      };
    },

    // prédicat, pas assertion : un salon dont on ne sait rien est traité
    // comme non chiffré. Le SDK peut lever si l'état n'est pas encore chargé, d'où le
    // `catch` — c'est le seul endroit où une exception vaut « je ne sais pas ».
    async isEncrypted(roomId) {
      try {
        return (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) ?? false;
      } catch {
        return false;
      }
    },

    async recoveryState() {
      const crypto = requireCrypto(client);

      /*
       * La seule question qui décide vraiment : **cet appareil peut-il chiffrer ?**
       * `signedByOwner` dit qu'il porte la signature de l'identité cross-signing de son
       * propriétaire, ce que D-08 exige pour qu'il reçoive et envoie des clés Megolm.
       * C'est une lecture du magasin crypto local — aucun réseau, donc juste hors ligne,
       * là où « une sauvegarde est-elle active ? » rendait `true` à tort et refermait la
       * porte sur un appareil parfaitement configuré (mesuré au navigateur).
       */
      const appareil = await crypto.getDeviceVerificationStatus(
        credentials.userId,
        credentials.deviceId,
      );
      if (appareil?.signedByOwner) return "prete";

      /*
       * Non signé. Reste à savoir laquelle des deux étapes il lui faut, et **seul le
       * serveur le sait** : l'identité du compte ne vit pas ici.
       *
       * **La question est « ce compte a-t-il une identité cross-signing ? », et surtout
       * pas « a-t-il une sauvegarde ? »** (corrigé). Les deux ne vont pas
       * ensemble : `setupRecoveryKey` provisionne le secret storage *et la sauvegarde*
       * avant de déposer l'identité, et ce dépôt est la seule requête du flux qui puisse
       * échouer sur une UIA. Une inscription interrompue à cet endroit laisse donc un
       * compte avec une sauvegarde et **sans identité** — état qu'`getKeyBackupInfo`
       * lisait comme `deverrouillage`, en proposant de déverrouiller avec une clé qui
       * n'ouvre rien : il n'y a aucune identité à redescendre. Le parcours d'inscription
       * devenait inatteignable pour de bon, et c'est le défaut remonté par l'utilisateur.
       *
       * `userHasCrossSigningKeys()` interroge `/keys/query` pour l'utilisateur local :
       * c'est exactement la chose dont dépend `unlockRecovery`, donc la seule qui puisse
       * décider entre les deux écrans.
       *
       * Injoignable, on répond `deverrouillage`. Ce n'est pas neutre et c'est délibéré :
       * des deux erreurs possibles, celle-là ne coûte qu'un écran inutile à un compte
       * neuf, quand `creation` proposerait d'écraser l'identité d'un compte qui en a
       * une. La création reste atteignable depuis l'écran de saisie, elle n'est pas
       * perdue — seulement placée derrière un geste explicite.
       */
      try {
        return (await crypto.userHasCrossSigningKeys()) ? "deverrouillage" : "creation";
      } catch {
        return "deverrouillage";
      }
    },

    async setupRecoveryKey({ reinitialiser = false, demanderMotDePasse }: SetupRecoveryOptions = {}) {
      const crypto = requireCrypto(client);
      let generated: RecoveryKey | undefined;

      /*
       * **Le secret storage d'abord, le cross-signing ensuite** — l'ordre inverse ne
       * survit pas à `reinitialiser`. `resetCrossSigning` réexporte les nouvelles clés
       * d'identité vers le secret storage *courant* : lancé en premier, il les chiffrerait
       * avec l'ancienne clé 4S, celle que l'utilisateur vient précisément de perdre, et
       * `getSecretStorageKey` n'aurait rien à rendre. L'inscription, elle, s'accommode des
       * deux ordres — un seul chemin suffit donc aux deux cas.
       */
      await crypto.bootstrapSecretStorage({
        setupNewKeyBackup: true,
        /*
         * **`true` dans les deux cas, et c'est ce qui rend l'inscription rejouable**
         * (corrigé).
         *
         * Relu dans le SDK épinglé (`rust-crypto.js`, v42.0.0) :
         * `isNewSecretStorageKeyNeeded = setupNewSecretStorage || !hasAESKey()`, et
         * `createSecretStorageKey` n'est appelé que si ce booléen est vrai. Avec `false`,
         * une seconde tentative sur un compte qui porte déjà un secret storage — celui
         * qu'une première tentative interrompue vient d'écrire — ne passait plus par
         * notre fabrique : `generated` restait vide et la fonction levait « secret storage
         * déjà initialisé », **à chaque essai, définitivement**. Le seul moyen de sortir
         * était le chemin « j'ai perdu ma clé », c'est-à-dire une réinitialisation
         * proposée à quelqu'un qui n'avait jamais eu de clé.
         *
         * Le remplacer est sans perte : on n'arrive ici que sur `creation` (aucune
         * identité cross-signing, cf. `recoveryState`) ou sur une réinitialisation
         * explicite. Dans les deux cas, un secret storage antérieur ne protège rien
         * qu'on n'ait déjà décidé de refaire — il ne chiffre que des clés d'identité qui
         * n'existent pas.
         */
        setupNewSecretStorage: true,
        createSecretStorageKey: async () => {
          /*
           * **D-15 — la clé est dérivée du mot de passe du compte**, et c'est ce qui rend
           * une deuxième connexion possible sans rien redemander : au prochain login, le
           * mot de passe qu'on vient de taper redonne la même clé (le descripteur porte
           * le sel et le nombre d'itérations, spec Matrix « Secret storage »).
           *
           * Sans phrase de passe — `restoreSession`, ou un compte réinitialisé sans que
           * le mot de passe soit en main — la clé reste aléatoire : c'est le comportement
           * d'avant, et il n'ouvre aucune connexion silencieuse. La clé rendue est la
           * même dans les deux cas, et c'est celle qu'on affiche.
           */
          generated = await crypto.createRecoveryKeyFromPassphrase(phraseDePasse);
          // Publiée aussitôt pour `getSecretStorageKey` : le SDK la redemande dans
          // la foulée, à l'intérieur de ce même `bootstrapSecretStorage`.
          recoveryKey = generated;
          return generated;
        },
      });

      if (!generated) {
        // Le SDK n'a pas appelé notre fabrique. Contractuellement impossible depuis que
        // `setupNewSecretStorage` vaut `true`, et gardé quand même : on ne peut pas rendre
        // une clé qu'on n'a pas générée, et en inventer une serait pire.
        throw new Error("aucune clé de récupération générée : secret storage déjà initialisé");
      }

      await crypto.bootstrapCrossSigning({
        setupNewCrossSigning: reinitialiser,
        /*
         * Le dépôt de l'identité est la seule requête de tout le flux qui puisse demander
         * une UIA. On tente d'abord sans, puis on rejoue avec la session : c'est le seul
         * ordre qui marche des deux côtés du MSC3967.
         *
         * **Le 401 arrive aussi à l'inscription** — corrigé. Le commentaire
         * qui vivait ici affirmait « le 401 n'arrive donc qu'en réinitialisation », et le
         * test qui le prouvait donnait un `envoyer` qui ne lève jamais : une hypothèse
         * validée contre un substitut qui la confirme par construction (règle 3). Contre
         * le vrai Synapse, MSC3967 étant éteint, l'inscription prend le 401 comme le
         * reste. Ce n'est pas une panne, c'est la question posée — mais elle est posée
         * plus tôt que ce que le produit croyait.
         */
        authUploadDeviceSigningKeys: async (envoyer) => {
          try {
            return await envoyer(null);
          } catch (erreur) {
            /*
             * **On tente d'abord sans, et c'est le seul ordre qui marche des deux côtés.**
             * Un premier dépôt d'identité passe sans épreuve (v1.155.0) ; un remplacement
             * en prend une. Deviner lequel des deux cas on est en train de vivre coûterait
             * une requête de plus pour une réponse que le serveur donne de toute façon.
             */
            const sessionUia = defiMotDePasse(erreur);
            if (sessionUia === undefined) throw erreur;

            // Le mot de passe de la session courante d'abord : le redemander à
            // quelqu'un qui vient de le taper serait un geste que rien ne justifie.
            const motDePasse = phraseDePasse ?? (await demanderMotDePasse?.());
            if (!motDePasse) throw erreur;

            return await envoyer(authMotDePasse(credentials.userId, motDePasse, sessionUia));
          }
        },
      });

      await relireIdentite(crypto);
      return generated;
    },

    async unlockRecovery(encodedKey) {
      const crypto = requireCrypto(client);

      // `decodeRecoveryKey` ne retire que les espaces ; une clé collée depuis un
      // gestionnaire de mots de passe traîne souvent un retour à la ligne. Il vérifie
      // ensuite préfixe, longueur et parité — une faute de frappe lève ici, avant tout
      // appel réseau.
      const privateKey = decodeRecoveryKey(encodedKey.replace(/\s+/g, ""));

      const cle = await client.secretStorage.getKey();
      if (!cle) throw new Error("ce compte n'a pas de clé de récupération à déverrouiller");
      const [, description] = cle;
      if (!(await client.secretStorage.checkKey(privateKey, description))) {
        // Une clé bien formée mais qui n'est pas celle du compte. Vérifié **avant**
        // d'amorcer quoi que ce soit : à moitié bootstrapé, l'appareil resterait dans un
        // état que rien ne sait rattraper.
        throw new Error("clé de récupération incorrecte");
      }

      // Publiée pour `getSecretStorageKey` : tout ce qui suit relit le secret storage.
      recoveryKey = { privateKey, encodedPrivateKey: encodedKey };

      /*
       * **L'identité publique d'abord, la signature ensuite** (corrigé,
       * mesuré contre un vrai Synapse).
       *
       * Sans ça, `bootstrapCrossSigning` importe les clés privées du secret storage,
       * ne trouve **aucune identité publique** en magasin local et ne signe rien :
       * « No public identity found while importing cross-signing keys, a /keys/query
       * needs to be done » (matrix-sdk-crypto). L'appel *réussit*, l'appareil reste non
       * signé, et la porte se rouvre juste derrière — un déverrouillage qui ne
       * déverrouille pas, et qui ne le dit pas.
       *
       * Le second paramètre `true` est exactement ce `/keys/query` : il force le
       * téléchargement pour l'utilisateur local au lieu d'attendre qu'un tour de `/sync`
       * l'amène. C'est une course qui ne se voyait pas depuis un écran — quelqu'un qui
       * tape sa clé met plus de temps que le premier sync — et qui devient systématique
       * dès qu'un appel enchaîne (`connexionParCle`).
       */
      await crypto.userHasCrossSigningKeys(undefined, true);

      // Importe l'identité cross-signing depuis le secret storage **et signe cet
      // appareil** : c'est ce geste-là qui le sort du silence de D-08. Aucune UIA en jeu,
      // les clés d'identité existent déjà côté serveur — on ne fait que les redescendre.
      await crypto.bootstrapCrossSigning({});

      await relireIdentite(crypto);

      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await crypto.checkKeyBackupAndEnable();

      // ponytail: pas de `restoreKeyBackup()` intégral — le SDK doc l'annonce à plusieurs
      // heures sur un gros compte, et la clé de sauvegarde étant désormais en magasin, il
      // va rechercher les clés manquantes message par message, à la première non-déchiffre.
      // Le jour où une restauration en tâche de fond est demandée, c'est un écran avec une
      // progression qu'il faut, pas un `await` de plus ici.
    },

    async appareils() {
      const { devices } = await client.getDevices();
      return devices.map((appareil) => ({
        id: appareil.device_id,
        nom: appareil.display_name ?? undefined,
        derniereActivite: appareil.last_seen_ts ?? undefined,
        courant: appareil.device_id === credentials.deviceId,
      }));
    },

    async revoquerAppareils(ids, motDePasse) {
      if (ids.length === 0) return;

      /*
       * Même patron que le dépôt d'identité : on tente sans, et le serveur dit ce qu'il
       * veut. Envoyer le mot de passe d'emblée l'exposerait sur un chemin qui ne le
       * demande pas forcément — un compte d'appli, un serveur configuré autrement.
       */
      try {
        await client.deleteMultipleDevices(ids);
        return;
      } catch (erreur) {
        const sessionUia = defiMotDePasse(erreur);
        if (sessionUia === undefined) throw erreur;

        const secret = motDePasse ?? phraseDePasse;
        if (!secret) throw erreur;

        await client.deleteMultipleDevices(
          ids,
          authMotDePasse(credentials.userId, secret, sessionUia),
        );
      }
    },

    async identityResetOf(userId) {
      try {
        const statut = await requireCrypto(client).getUserVerificationStatus(userId);
        return statut.needsUserApproval;
      } catch {
        // Prédicat, comme `isEncrypted` : il ne remonte jamais d'exception à l'UI.
        //
        // Le repli est `false` — permissif — et c'est délibéré : **la protection ne
        // dépend pas de ce prédicat**. Si l'identité a réellement changé,
        // `OnlySignedDevicesIsolationMode` fait lever le chiffrement au moment de
        // l'envoi, que l'UI ait affiché son dialogue ou non. Ce membre sert à
        // *expliquer* le blocage, pas à le produire.
        //
        // Replier sur `true` bloquerait tout envoi vers cet utilisateur à la moindre
        // panne passagère du crypto — un déni de service pour un gain nul.
        return false;
      }
    },

    confirmIdentityOf(userId) {
      // `pinCurrentUserIdentity` — « accepting it as genuine » côté SDK. C'est le geste
      // qui rend effective la confirmation exigée par ; sans lui, l'UI
      // pourrait détecter la réinitialisation sans jamais la lever.
      //
      // **Ce n'est pas un prédicat, et il ne rattrape rien.** Une confirmation qui
      // échoue en silence laisserait l'UI débloquer l'envoi alors que le crypto
      // refusera toujours. Le SDK lève dans deux cas — sur notre propre identifiant, et
      // sur un utilisateur dont on n'a aucune identité — et l'UI doit les voir.
      return requireCrypto(client).pinCurrentUserIdentity(userId);
    },

    registerWipe(name, wipe) {
      wipes.set(name, wipe);
    },

    // déconnexion = wipe complet : stores SDK + tout store applicatif
    // enregistré. L'effacement local ne dépend d'aucune réussite réseau, et l'échec
    // d'un store n'empêche pas les autres d'être effacés.
    async logout() {
      // Les écouteurs de persistance meurent avec la session : sans cela, une session
      // suivante dans la même page ferait écrire un store déjà effacé.
      globalThis.removeEventListener?.("pagehide", persister);
      globalThis.document?.removeEventListener("visibilitychange", surVisibilite);

      // les credentials partent en premier : si tout le reste échoue,
      // mieux vaut une session locale morte qu'un jeton qui survit à la déconnexion.
      try {
        await saved.clear();
      } catch {
        log.error("effacement des credentials échoué");
      }

      try {
        await client.logout(true);
      } catch {
        log.warn("révocation du jeton côté serveur échouée, wipe local poursuivi");
      }

      for (const [name, wipe] of wipes) {
        try {
          await wipe();
        } catch {
          log.error("wipe d'un store applicatif échoué", { store: name });
        }
      }

      await client.clearStores();
    },
  };
}

/**
 * **Relit l'identité de l'utilisateur au serveur, et c'est ce qui rend `recoveryState()`
 * juste** (ajouté, mesuré contre un vrai Synapse).
 *
 * `bootstrapCrossSigning` dépose ou importe l'identité et signe l'appareil ; le magasin
 * crypto local, lui, garde la vue qu'il avait avant. `getDeviceVerificationStatus` — la
 * source de `recoveryState` — répond alors « non signé » sur un appareil qui vient de
 * l'être, et la porte se referme derrière quelqu'un qui vient de tout faire correctement.
 * C'est le défaut remonté : « je me connecte et on me demande ma clé ».
 *
 * Le second paramètre `true` force le `/keys/query` au lieu d'attendre qu'un tour de
 * `/sync` l'amène. Le booléen rendu ne nous intéresse pas — c'est l'effet de bord qui est
 * demandé, et le nommer ici évite qu'on le prenne un jour pour un appel superflu.
 */
async function relireIdentite(crypto: CryptoApi): Promise<void> {
  await crypto.userHasCrossSigningKeys(undefined, true);
}

export async function initSession(config: SessionConfig): Promise<Session> {
  /*
   * `loginWithPassword` est déprécié dans le SDK pour la même raison que
   * `loginWithToken` l'était : il pose les credentials sur un client déjà construit, dont
   * la crypto n'a pas démarré avec la bonne identité d'appareil. On fait la requête sur un
   * client jetable, puis on construit le client définitif avec les credentials complets.
   *
   * `m.id.user` et non l'identifiant complet : Synapse accepte les deux, mais l'écran de
   * connexion demande un nom d'utilisateur, et le compléter ici en `@nom:serveur` ferait
   * échouer quiconque a tapé son identifiant entier.
   */
  const auth = createClient({ baseUrl: config.homeserverUrl });
  const login = await auth.loginRequest({
    type: "m.login.password",
    identifier: { type: "m.id.user", user: config.identifiant },
    password: config.motDePasse,
  });

  if (!login.device_id) {
    // Sans identité d'appareil, aucune session Megolm ne peut être établie : mieux
    // vaut échouer ici que rendre un client qui n'enverra jamais rien de chiffré.
    throw new Error("le homeserver n'a pas attribué de device_id : session refusée");
  }

  const credentials: StoredCredentials = {
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
  };

  const saved = await openCredentials(config.indexedDB ?? globalThis.indexedDB);
  await remplacerAppareil(saved, credentials, config.homeserverUrl);
  const session = await buildSession(credentials, config, saved, config.motDePasse);

  /*
   * **D-15 — la deuxième connexion entre, elle ne bute pas sur un mur.**
   *
   * Chaque connexion donne un `device_id` neuf, donc un appareil non signé, donc — avant
   * ce jour — l'écran « Entrez votre clé de récupération » à quelqu'un qui venait de
   * donner son mot de passe. C'est le défaut remonté, et ce n'était pas un
   * défaut d'écran : sans la clé, cet appareil ne peut réellement rien déchiffrer ni
   * rien envoyer. Le mur était honnête, c'est sa nécessité qui ne l'était pas.
   *
   * La clé étant dérivée du mot de passe, le mot de passe qu'on vient d'utiliser
   * la redonne. `unlockRecovery` fait le reste — exactement le même chemin que l'écran
   * de saisie, pour ne pas tenir deux déverrouillages en phase.
   */
  await deverrouillerAvecMotDePasse(session, config.motDePasse);
  return session;
}

/**
 * rejoue la dérivation de la clé de récupération à partir du mot de passe.
 *
 * Silencieux dans les deux sens : il ne demande rien, et **il ne fait échouer aucune
 * connexion**. Trois cas normaux n'aboutissent pas, et aucun n'est une erreur — un compte
 * qui n'a pas encore de clé (l'inscription va la créer), une clé aléatoire d'avant D-15,
 * et un mot de passe changé depuis (D-12 ne re-dérive pas la clé). Dans les trois,
 * l'écran de saisie reste le chemin, et il marche.
 */
async function deverrouillerAvecMotDePasse(session: Session, motDePasse: string): Promise<void> {
  try {
    const cle = await session.client.secretStorage.getKey();
    if (!cle) return;

    const [, description] = cle;
    const phrase = description?.passphrase;
    if (!phrase?.salt || !phrase.iterations) return;

    const derivee = await deriveRecoveryKeyFromPassphrase(
      motDePasse,
      phrase.salt,
      phrase.iterations,
    );
    // Ré-encodée pour repasser par `unlockRecovery` : il vérifie la clé contre le
    // descripteur, signe l'appareil et rebranche la sauvegarde. Refaire ces trois gestes
    // ici ferait un second chemin de déverrouillage à tenir en phase.
    const encodee = encodeRecoveryKey(derivee);
    // `encodeRecoveryKey` rend `undefined` si l'entrée n'a pas la bonne taille. Ça ne
    // devrait pas arriver après une dérivation, et on ne devine pas : sans clé lisible,
    // on laisse l'écran de saisie faire son travail.
    if (!encodee) return;
    await session.unlockRecovery(encodee);
  } catch {
    createLogger().warn("déverrouillage par mot de passe impossible, la clé sera demandée");
  }
}

/**
 * / D-14 — **la porte de secours : ouvrir une session avec la clé de
 * récupération, quand le mot de passe est perdu.**
 *
 * C'est une mesure exceptionnelle et le produit la présente comme telle. Elle
 * existe parce que D-12 a fermé la seule autre issue : sans e-mail, sans SSO, et avec
 * `POST /account/password` bloqué au proxy, un mot de passe oublié faisait un compte mort
 * — et la clé de récupération, que l'utilisateur a pourtant en main, n'y pouvait rien.
 *
 * **Ce qu'elle coûte, et qui est le fond de D-14** : la clé cesse d'être un secret qui
 * déchiffre pour devenir un secret qui *ouvre*. Avant, la détenir sans session ne donnait
 * rien ; désormais elle donne le compte entier. Un facteur, pas deux.
 *
 * Le serveur ne rend **pas** un jeton d'accès : il rend un jeton de connexion à usage
 * unique, échangé ici par le chemin natif `m.login.token`. Synapse crée l'appareil,
 * applique ses limites et journalise la connexion comme n'importe quelle autre.
 */
export async function connexionParCle(
  config: Omit<SessionConfig, "motDePasse"> & { cleRecuperation: string },
): Promise<Session> {
  const auth = createClient({ baseUrl: config.homeserverUrl });

  let privateKey: Uint8Array;
  try {
    // Même normalisation qu'`unlockRecovery`. Une clé malformée est refusée ici, sans
    // aller-retour — et avec le même `errcode` que le refus du serveur : pour la personne
    // qui tape, « mal recopiée » et « pas celle de ce compte » se corrigent pareil, et
    // c'est ce qui classe une erreur (règle 2).
    privateKey = decodeRecoveryKey(config.cleRecuperation.replace(/\s+/g, ""));
  } catch {
    throw Object.assign(new Error("clé de récupération invalide"), { errcode: "M_FORBIDDEN" });
  }

  const reponse = (await auth.http.requestOtherUrl(
    Method.Post,
    new URL("/_synapse/client/tacita/login_recovery", config.homeserverUrl).toString(),
    { user: config.identifiant, recovery_key: encodeBase64(privateKey) },
  )) as { login_token?: string };

  if (!reponse.login_token) {
    // Le module ne rend jamais 200 sans jeton ; s'il le faisait, poursuivre donnerait un
    // `/login` sans jeton et une erreur qui ne dirait pas d'où elle vient.
    throw new Error("le serveur n'a pas rendu de jeton de connexion");
  }

  const login = await auth.loginRequest({
    type: "m.login.token",
    token: reponse.login_token,
  });

  if (!login.device_id) {
    // Même refus qu'`initSession`, même motif : sans identité d'appareil, aucune session
    // Megolm ne s'établit et le client n'enverra jamais rien de chiffré.
    throw new Error("le homeserver n'a pas attribué de device_id : session refusée");
  }

  const credentials: StoredCredentials = {
    accessToken: login.access_token,
    userId: login.user_id,
    deviceId: login.device_id,
  };

  const saved = await openCredentials(config.indexedDB ?? globalThis.indexedDB);
  await remplacerAppareil(saved, credentials, config.homeserverUrl);
  const session = await buildSession(credentials, config, saved);

  /*
   * **Et on déverrouille dans la foulée.** Cet appareil est neuf, donc non signé : sans
   * ce geste, la porte redemanderait aussitôt la clé qu'on vient de taper.
   * Deux saisies du même secret à trente secondes d'intervalle, ce serait l'écran qui
   * demande à l'utilisateur de compenser une couture interne.
   */
  try {
    await session.unlockRecovery(config.cleRecuperation);
  } catch {
    /*
     * ponytail: le serveur vient de valider cette clé contre le descripteur du compte —
     * un échec ici est une anomalie locale, pas une clé fausse. La session est ouverte et
     * `RecoveryUnlock` sait déjà demander la clé : on ne fait pas échouer une connexion
     * réussie pour une étape qui a son propre écran. Le jour où ce cas se produit
     * vraiment, c'est un état à remonter, pas un `throw` à ajouter ici.
     */
    createLogger().warn("session ouverte par clé, déverrouillage local à reprendre");
  }

  return session;
}

/**
 * rouvre la session précédente sans réseau : c'est ce qui rend
 * exploitables l'historique hors ligne, la file d'envoi réhydratée
 * et l'index de recherche persisté, qui survivent tous à un
 * rechargement mais qu'aucun chemin ne savait rouvrir.
 *
 * `null` n'est pas une erreur : c'est « aucune session locale, passe par l'OIDC »
 * Le jeton n'est pas validé ici — le valider demanderait le réseau, ce que
 * cette fonction existe précisément pour éviter. Un jeton révoqué se manifeste par un
 * `M_UNKNOWN_TOKEN` au premier appel, que le shard UI route vers l'OIDC.
 */
export async function restoreSession(
  config: Omit<SessionConfig, "identifiant" | "motDePasse">,
): Promise<Session | null> {
  const saved = await openCredentials(config.indexedDB ?? globalThis.indexedDB);
  const credentials = await saved.read();
  if (!credentials) return null;

  try {
    const session = await buildSession(credentials, config, saved);

    /*
     * **valider le jeton avant de rendre la session.**
     *
     * Mesuré au navigateur : jeton révoqué côté serveur, page rechargée,
     * et l'application se rouvrait entièrement — liste des conversations comprise. Les
     * credentials locaux suffisaient à démarrer, et plus rien ne demandait au serveur
     * s'ils valaient encore quelque chose. C'était écrit en commentaire ici comme une
     * limite assumée ; c'en était une trop grande.
     *
     * `whoami` est la question exacte, et sa réponse distingue les deux cas qui comptent :
     * un `M_UNKNOWN_TOKEN` est un refus, tout le reste est un serveur qu'on n'atteint pas.
     * Traiter le second comme le premier jetterait dehors quelqu'un qui a seulement perdu
     * le réseau — ce que promet précisément de ne pas faire.
     */
    try {
      await session.client.whoami();
    } catch (error) {
      // `errcode` **et** `httpStatus` : selon le chemin d'erreur, le SDK expose l'un ou
      // l'autre, et un jeton refusé sous une forme qu'on ne reconnaît pas est un jeton
      // qu'on garde — exactement le défaut qu'on est en train de fermer.
      const { errcode, httpStatus } = error as { errcode?: string; httpStatus?: number };
      if (errcode === "M_UNKNOWN_TOKEN" || httpStatus === 401) {
        createLogger().warn("jeton refusé au démarrage, retour à l'OIDC");
        await saved.clear().catch(() => {});
        return null;
      }
      // Réseau absent : la session locale reste valable, c'est tout l'intérêt du hors-ligne.
    }

    return session;
  } catch (error) {
    // Restauration impossible : store crypto corrompu, wasm qui n'a pas chargé,
    // IndexedDB à moitié évincée. On rend `null` sans effacer — un échec de
    // chargement est souvent passager, et l'effacer forcerait un OIDC qui exige le
    // réseau, précisément ce que l'utilisateur hors ligne n'a pas. Si la panne est
    // définitive, l'OIDC réécrira ces credentials de toute façon : les détruire
    // ici n'achèterait rien et coûterait la tentative suivante.
    //
    // Mais un `null` muet est indiagnosticable : côté appelant il ne se distingue
    // pas d'un premier lancement. On journalise la raison — c'est un message
    // d'erreur technique, jamais du contenu déchiffré.
    createLogger().error("reprise de session impossible, retour à l'OIDC", {
      raison: error instanceof Error ? error.message : "erreur inconnue",
    });
    return null;
  }
}

/**
 * **un jeton révoqué doit sortir de la session, pas la hanter.**
 *
 * Mesuré au navigateur : jeton révoqué côté serveur, page rechargée —
 * l'application se rouvrait normalement et continuait de rendre une session morte. Rien
 * ne levait : `restoreSession` relit des credentials locaux qu'aucun appel n'a encore
 * démentis, et le refus du serveur arrive plus tard, dans la boucle /sync.
 *
 * `HttpApiEvent.SessionLoggedOut` est **le** signal du SDK pour ça, et il ne se déclenche
 * que sur un refus explicite du jeton (`M_UNKNOWN_TOKEN`). Un réseau absent ne l'émet
 * pas : c'est exactement la distinction qui manquait, et sans elle on jetait dehors
 * quelqu'un qui n'avait perdu que sa connexion.
 *
 * Le wipe reste celui de : ce n'est pas à l'appelant de le réinventer.
 */
export function onSessionInvalidee(session: Session, rappel: () => void): () => void {
  const surRefus = (): void => {
    createLogger().warn("jeton refusé par le serveur, session locale effacée");
    void session.logout().catch(() => {});
    rappel();
  };
  session.client.on(HttpApiEvent.SessionLoggedOut, surRefus);
  return () => {
    session.client.off(HttpApiEvent.SessionLoggedOut, surRefus);
  };
}

/**
 * **créer un compte**, un identifiant et un mot de passe.
 *
 * `registration_requires_token` a été retiré du serveur : il n'y a plus de code
 * d'invitation à saisir, et donc plus rien à demander hors de l'app. Ce que ça expose est
 * assumé — le client n'a rien à en compenser.
 *
 * L'UIA reste : le protocole veut une première requête sans `auth`, qui prend un 401
 * portant la `session`, puis un rejeu par stage. On ne devine pas la session — on la lit
 * dans le défi, comme `defiSso` le fait pour le SSO. Aujourd'hui le flow servi est
 * `[[m.login.dummy]]` ; la boucle est écrite pour le flow, pas pour ce cas-là.
 *
 * Rend une session ouverte : Synapse connecte le compte qu'il vient de créer, et repasser
 * par `initSession` demanderait le mot de passe une seconde fois pour rien.
 */
export async function creerCompte(config: SessionConfig): Promise<Session> {
  const auth = createClient({ baseUrl: config.homeserverUrl });

  const demande = (authDict?: Record<string, unknown>) =>
    auth.registerRequest({
      username: config.identifiant,
      password: config.motDePasse,
      ...(authDict ? { auth: authDict } : {}),
    });

  /*
   * **L'UIA d'inscription a plusieurs étapes, et il faut les franchir toutes.**
   *
   * Relu dans l'image déployée (`synapse/rest/client/register.py`,
   * `_calculate_registration_flows`, v1.155.0) : sans e-mail ni MSISDN configurés, la
   * liste de base vaut `[[m.login.dummy]]`, et `registration_requires_token` la
   * **préfixait** d'un jeton. Le garde retiré, il ne reste que `m.login.dummy` —
   * mais la boucle ne le suppose pas : elle lit les flows que le serveur annonce.
   *
   * Une version antérieure ne franchissait qu'une étape et tenait le 401 suivant pour une
   * panne : aucune inscription n'aboutissait. Le défaut n'était visible ni à la
   * compilation, ni sous Vitest — seule la lecture du serveur le donnait. C'est pourquoi
   * on ne remplace pas cette boucle par un `dummy` en dur : le jour où le serveur ajoute
   * une étape, elle la franchit au lieu de mentir.
   *
   * Elle rejoue tant que le serveur redemande, et s'arrête au premier stage qu'on ne sait
   * pas franchir plutôt que de boucler : un flow qui exigerait un e-mail doit échouer
   * franchement, pas tourner.
   */
  let etat = await premiereReponse(demande);
  for (let tour = 0; "defi" in etat && tour < ETAPES_UIA_MAX; tour++) {
    const { defi, erreur } = etat;
    const suivant = prochainStage(defi);
    if (!suivant) throw inscriptionImpossible(erreur);
    etat = await premiereReponse(() => demande({ type: suivant, session: defi.session }));
  }

  if ("defi" in etat) throw inscriptionImpossible(etat.erreur);
  const inscription = etat;

  if (!inscription.access_token || !inscription.device_id) {
    // `inhibit_login` n'est pas demandé : sans jeton ni appareil, le compte existe mais
    // rien ne peut chiffrer, et le taire donnerait une inscription en apparence réussie.
    throw new Error("le homeserver a créé le compte sans session : connexion refusée");
  }

  const credentials: StoredCredentials = {
    accessToken: inscription.access_token,
    userId: inscription.user_id,
    deviceId: inscription.device_id,
  };
  const saved = await openCredentials(config.indexedDB ?? globalThis.indexedDB);
  await saved.write(credentials);
  // D-15 — le mot de passe accompagne la session : c'est de lui que `setupRecoveryKey`
  // dérivera la clé, à l'étape suivante du parcours d'accueil.
  return buildSession(credentials, config, saved, config.motDePasse);
}

/**
 * Règle 2 — **un défi qu'on ne sait pas franchir n'est pas une panne de réseau.**
 *
 * Trouvé en montant la pile, juste après D-13 : le serveur tournait encore
 * sur la configuration d'avant, redemandait `m.login.registration_token`, et l'écran
 * affichait « Le serveur n'a pas répondu. Réessayez. » — il avait répondu, très
 * précisément, et réessayer ne pouvait rien donner. La cause : le 401 d'une UIA ne porte
 * pas d'`errcode` (son corps est le dictionnaire de flows), donc il tombait dans le
 * fourre-tout réseau de l'écran.
 *
 * L'`errcode` est ici parce que c'est la forme que l'écran sait déjà classer, et il est
 * relu là-bas (`Connexion.tsx`) : une valeur posée à une jonction que personne ne relit
 * est indétectable (règle 7).
 */
function inscriptionImpossible(cause: unknown): Error {
  return Object.assign(
    new Error("inscription : le serveur exige une étape que ce client ne sait pas franchir"),
    { errcode: "TACITA_INSCRIPTION_IMPOSSIBLE", cause },
  );
}

/** Garde-fou de boucle : au-delà, c'est un flow qu'on ne sait pas franchir. */
const ETAPES_UIA_MAX = 4;

/** Les stages que cette fonction sait franchir — ceux qui ne demandent rien à saisir. */
const STAGES_CONNUS = ["m.login.dummy"] as const;

interface DefiUia {
  session?: string;
  flows?: { stages?: string[] }[];
  completed?: string[];
}

/**
 * Le prochain stage à franchir : le premier d'un flow entièrement à notre portée et qui
 * n'est pas déjà fait.
 *
 * « Entièrement à notre portée » et pas « premier stage connu » : un flow qui commence par
 * un stage qu'on sait faire et finit par un e-mail nous ferait avancer dans un cul-de-sac,
 * en laissant croire que ça progresse.
 */
function prochainStage(defi: DefiUia): string | undefined {
  const faits = new Set(defi.completed ?? []);
  for (const flow of defi.flows ?? []) {
    const stages = flow.stages ?? [];
    if (!stages.every((stage) => (STAGES_CONNUS as readonly string[]).includes(stage))) continue;
    const reste = stages.find((stage) => !faits.has(stage));
    if (reste) return reste;
  }
  return undefined;
}

type EtapeUia =
  | Awaited<ReturnType<MatrixClient["registerRequest"]>>
  | { defi: DefiUia; erreur: unknown };

/** Un appel d'inscription : soit il aboutit, soit il rend le défi que le serveur oppose. */
async function premiereReponse(
  appel: () => Promise<Awaited<ReturnType<MatrixClient["registerRequest"]>>>,
): Promise<EtapeUia> {
  try {
    return await appel();
  } catch (erreur) {
    const { httpStatus, data } = (erreur ?? {}) as { httpStatus?: number; data?: DefiUia };
    if (httpStatus !== 401 || !data?.session) throw erreur;
    return { defi: data, erreur };
  }
}



/**
 * **changer son mot de passe, la clé de récupération à l'appui.**
 *
 * Le garde est **serveur** : `POST /_matrix/client/v3/account/password` est fermé au proxy,
 * et `/_synapse/client/tacita/password` est le seul chemin restant. La vérification faite
 * ici, avant l'appel, ne le remplace pas — elle rend la faute de frappe immédiate, sans
 * aller-retour ni envoi inutile de la clé.
 *
 * **Ce que cet appel expose, et qui est écrit dans D-12** : la clé part en clair vers le
 * serveur. Elle n'ouvre pas un message, elle ouvre le magasin. C'est la contrepartie
 * assumée du fait que le garde soit opposable à tout client, et non une règle de notre
 * seule interface.
 *
 * Lève `Error("clé de récupération incorrecte")` — même message que `unlockRecovery`, même
 * cause — ou remonte l'erreur du serveur telle quelle pour tout le reste.
 */
export async function changerMotDePasse(
  session: Session,
  options: { cleRecuperation: string; nouveau: string },
): Promise<void> {
  const client = session.client;

  // Même normalisation que `unlockRecovery` : `decodeRecoveryKey` ne retire que les
  // espaces, et une clé collée depuis un gestionnaire traîne souvent un retour à la ligne.
  const privateKey = decodeRecoveryKey(options.cleRecuperation.replace(/\s+/g, ""));

  const cle = await client.secretStorage.getKey();
  if (!cle) throw new Error("ce compte n'a pas de clé de récupération");
  const [, description] = cle;
  if (!(await client.secretStorage.checkKey(privateKey, description))) {
    // Refusée localement : la clé ne part pas sur le réseau. Ce n'est pas le garde — le
    // garde est côté serveur — c'est ce qui évite de l'exposer pour rien.
    throw new Error("clé de récupération incorrecte");
  }

  const reponse = await client.http.requestOtherUrl(
    Method.Post,
    new URL("/_synapse/client/tacita/password", client.baseUrl).toString(),
    {
      recovery_key: encodeBase64(privateKey),
      new_password: options.nouveau,
    },
    { headers: { Authorization: `Bearer ${client.getAccessToken() ?? ""}` } },
  );
  void reponse;
}

/** Base64 standard, padding compris : c'est ce que `b64decode(validate=True)` attend. */
function encodeBase64(octets: Uint8Array): string {
  let binaire = "";
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return btoa(binaire);
}
