/**
 * Les préférences locales, en IndexedDB — jamais localStorage.
 *
 * `lireCle` / `ecrireCle` sont la primitive ; le reste sont des accès nommés (thème,
 * fond d'écran, refus d'éducation iOS, mode masqué). Asynchrone par nature : au tout
 * premier rendu, la valeur n'est pas encore là, et un bref passage par le thème par
 * défaut est attendu.
 */
import type { ThemeMode } from "../components/foundation/primitives";

const BASE = "tacita-ui";
const STORE = "preferences";
const VERSION = 1;

/**
 * Les préférences d'interface vivent en **IndexedDB** (interdit n°2 : localStorage est
 * fermé aux données utilisateur, et un réglage en est une — il dit quelque chose de la
 * personne, et sa petite taille ne lui vaut pas d'exception).
 *
 * Une seule base pour toutes : le thème et le refus de l'écran d'éducation
 * iOS n'ont aucune raison d'avoir chacun la leur.
 *
 * Ce store ne contient **jamais de contenu déchiffré** : que des choix d'affichage.
 */
const ouvrir = (indexedDB: IDBFactory, base: string, store: string): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const requete = indexedDB.open(base, VERSION);
    requete.onupgradeneeded = () => requete.result.createObjectStore(store);
    requete.onsuccess = () => resolve(requete.result);
    requete.onerror = () => reject(requete.error);
  });

/**
 * Le couple lecture/écriture générique. Il prend la base et le store en paramètre parce
 * que **toutes les données locales n'ont pas la même nature** : les préférences sont des
 * choix d'affichage, les notes de M-G disent quelque chose d'une personne. Les mélanger
 * dans un store dont la docstring promet « aucun contenu » rendrait cette promesse fausse.
 */
export async function lireCle(
  indexedDB: IDBFactory,
  cle: string,
  nomBase = BASE,
  store = STORE,
): Promise<unknown> {
  const connexion = await ouvrir(indexedDB, nomBase, store);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const requete = connexion.transaction(store, "readonly").objectStore(store).get(cle);
      requete.onsuccess = () => resolve(requete.result);
      requete.onerror = () => reject(requete.error);
    });
  } finally {
    connexion.close();
  }
}

export async function ecrireCle(
  indexedDB: IDBFactory,
  cle: string,
  valeur: unknown,
  nomBase = BASE,
  store = STORE,
): Promise<void> {
  const connexion = await ouvrir(indexedDB, nomBase, store);
  try {
    await new Promise<void>((resolve, reject) => {
      // Le `onsuccess` de la requête précède le commit de la transaction, qui peut
      // encore avorter : on attend `oncomplete`, sinon un réglage « enregistré » peut ne
      // pas l'être. Même motif que packages/search/src/snapshot.ts.
      const transaction = connexion.transaction(store, "readwrite");
      transaction.objectStore(store).put(valeur, cle);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error("transaction IndexedDB avortée"));
    });
  } finally {
    connexion.close();
  }
}

/** Vide un store entier. : ce que la déconnexion doit pouvoir effacer. */
export async function viderStore(
  indexedDB: IDBFactory,
  nomBase: string,
  store: string,
): Promise<void> {
  const connexion = await ouvrir(indexedDB, nomBase, store);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = connexion.transaction(store, "readwrite");
      transaction.objectStore(store).clear();
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error ?? new Error("transaction IndexedDB avortée"));
    });
  } finally {
    connexion.close();
  }
}

const estMode = (valeur: unknown): valeur is ThemeMode =>
  valeur === "system" || valeur === "light" || valeur === "dark";

/**
 * Un drapeau booléen d'appareil : sa lecture et son écriture, sur une clé fixe.
 *
 * Quatre paires suivaient exactement cette forme, chacune recopiant sa clé en double. La
 * comparaison à `true` n'est pas une coquetterie : elle absorbe une base vide comme une
 * valeur abîmée, et c'est elle qui fait que le défaut de chaque drapeau est `false`.
 *
 * Les deux drapeaux qui ne se retirent jamais (un refus, une question posée) n'en prennent
 * que la lecture : leur écriture ne porte pas de booléen, et lui en inventer un pour
 * rentrer dans le moule aurait offert une remise à zéro qui n'existe pas.
 */
const drapeau = (cle: string) =>
  [
    async (indexedDB: IDBFactory) => (await lireCle(indexedDB, cle)) === true,
    (indexedDB: IDBFactory, valeur: boolean) => ecrireCle(indexedDB, cle, valeur),
  ] as const;

/** une valeur inattendue est ignorée, pas propagée : on retombe au défaut. */
export async function lireTheme(indexedDB: IDBFactory): Promise<ThemeMode | undefined> {
  const valeur = await lireCle(indexedDB, "theme");
  return estMode(valeur) ? valeur : undefined;
}

export const ecrireTheme = (indexedDB: IDBFactory, mode: ThemeMode) =>
  ecrireCle(indexedDB, "theme", mode);

/**
 * l'écran d'éducation iOS n'est **jamais** re-présenté après un refus
 * explicite. Insister est le plus court chemin vers un utilisateur qui n'écoute plus.
 */
const [lireRefusEducationIOS] = drapeau("education-ios-refusee");
export { lireRefusEducationIOS };

/** Le refus ne se retire pas : l'écrire, c'est le poser — d'où l'absence de paramètre. */
export const ecrireRefusEducationIOS = (indexedDB: IDBFactory) =>
  ecrireCle(indexedDB, "education-ios-refusee", true);

/**
 * **la proposition d'activer les notifications n'est faite qu'une fois.**
 *
 * Elle n'était mémorisée nulle part : l'abonnement de `messaging` rappelait le
 * déclencheur à chaque `/sync`, et la feuille revenait indéfiniment — y compris après
 * une activation réussie, l'effet ayant lu la permission une seule fois au montage.
 * « Plus tard » ne voulait donc rien dire, et il n'existait aucun moyen de s'en
 * débarrasser.
 *
 * La marque est posée **à l'affichage**, pas à la réponse : une feuille montrée est une
 * question posée, quelle qu'ait été la suite. Le rattrapage existe et il est nommé dans
 * la feuille elle-même — Profil › Réglages › Notifications, qui est le second point
 * d'entrée voulu par l'exigence.
 */
const [lireDemandePushFaite] = drapeau("push-demande-faite");
export { lireDemandePushFaite };

/** Une question posée ne se dépose pas : l'écrire, c'est la marquer faite. */
export const ecrireDemandePushFaite = (indexedDB: IDBFactory) =>
  ecrireCle(indexedDB, "push-demande-faite", true);

/*
 * `recuperation-faite` vivait ici — une trace « cet appareil a déjà mené ce compte au
 * bout de l'étape », posée pour que la porte ne se referme pas hors ligne.
 * Elle est **supprimée** : `recoveryState()` lit désormais le magasin crypto,
 * ce qui répond sans réseau et n'a donc plus rien à mémoriser. Et surtout la trace ne
 * savait rien du `device_id` : après une déconnexion/reconnexion dans le même navigateur,
 * elle laissait passer un appareil neuf, non signé, que D-08 rend muet et sourd.
 */

/**
 * le mode masqué. **Un réglage d'appareil**, pas de compte :
 * le rendre synchronisé le poserait en account data, que le serveur lit en clair.
 *
 * Le défaut est `false` : les reçus normaux. Un mode masqué activé par défaut donnerait
 * un produit qui ne montre jamais « lu » sans que personne l'ait demandé.
 */
export const [lireModeMasque, ecrireModeMasque] = drapeau("mode-masque");

/**
 * Garder le clavier ouvert après l'envoi d'un message. Les avis sont partagés — d'où un
 * réglage, et d'appareil : un clavier se règle sur le téléphone qui l'affiche. Le défaut
 * est `false`, le comportement d'avant le réglage.
 */
export const [lireGarderClavier, ecrireGarderClavier] = drapeau("garder-clavier");

/**
 * le fond d'écran d'une conversation, **sur cet appareil**.
 *
 * Non synchronisé, et le libellé de l'écran le dit — un fond retrouvé sur un seul
 * téléphone n'est pas un bug si on l'a annoncé. Une clé par salon, pour que la remise à
 * zéro d'une conversation n'emporte pas les autres.
 *
 * **Des octets et un type MIME, pas un `Blob`.** Un vrai IndexedDB sait garder un blob ;
 * le `fake-indexeddb` de la suite de tests ne le rend pas — il en fait un objet vide, et
 * un fond d'écran devenu intestable serait un fond d'écran non prouvé. La conversion
 * coûte une ligne de chaque côté, et l'appelant continue de voir un `Blob`.
 */
const cleFond = (roomId: string) => `fond-ecran:${roomId}`;

interface FondEnregistre {
  octets: ArrayBuffer;
  type: string;
}

export async function lireFondEcran(
  indexedDB: IDBFactory,
  roomId: string,
): Promise<Blob | undefined> {
  const valeur = (await lireCle(indexedDB, cleFond(roomId))) as FondEnregistre | undefined;
  return valeur?.octets ? new Blob([valeur.octets], { type: valeur.type }) : undefined;
}

export const ecrireFondEcran = async (indexedDB: IDBFactory, roomId: string, image: Blob) =>
  ecrireCle(indexedDB, cleFond(roomId), {
    octets: await image.arrayBuffer(),
    type: image.type,
  } satisfies FondEnregistre);

/** La réinitialisation exigée par : la clé retombe à `undefined`. */
export const effacerFondEcran = (indexedDB: IDBFactory, roomId: string) =>
  ecrireCle(indexedDB, cleFond(roomId), undefined);

/**
 * **le parcours d'accueil est en cours sur cet appareil.**
 *
 * Il n'existe qu'un seul instant où « ce compte vient d'être créé » est une information
 * disponible : `recoveryState()` vaut `creation`, et il ne le vaut qu'une fois
 * dans la vie du compte. Passée l'étape de la clé, ce signal a disparu — un rechargement
 * au milieu du parcours retomberait alors sur une application vide, sans conversation et
 * sans avoir jamais proposé quoi que ce soit.
 *
 * Cette marque est donc ce qui rend le parcours **reprenable**, et rien d'autre : elle
 * est posée à son ouverture, retirée à sa fin. Sur l'appareil, parce qu'un parcours
 * d'accueil est un geste d'appareil — un second appareil ne le rejoue pas, il déverrouille
 * (`RecoveryUnlock`).
 */
export const [lireOnboardingEnCours, ecrireOnboardingEnCours] = drapeau("onboarding-en-cours");
