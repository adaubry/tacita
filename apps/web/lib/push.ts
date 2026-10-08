/**
 * Les notifications, côté client : l'abonnement, l'état, et l'aperçu local.
 *
 *  1. `apercuLocal` — le contenu d'une notification quand l'application est ouverte.
 *     Fenêtre fermée, le service worker n'a aucune clé Megolm et ne peut rien dire de
 *     plus que « Nouveau message » : c'est par conception.
 *  2. `estIOS`, `estInstallee`, `etatPushLocal` — ce que cet appareil permet.
 *  3. `brancherPush` / `DiagnosticPush` — l'abonnement, et le diagnostic des trois
 *     maillons quand il manque, plutôt qu'un « ça ne marche pas ».
 */
import type { Session } from "@tacita/client-core";
import { mentionCandidates, messages as listerMessages, messageText } from "@tacita/messaging";

import { PUSH_CONFIG_URL, PUSH_NOTIFY_URL } from "./config";

/**
 * la chaîne Web Push côté client, de bout en bout.
 *
 * Le service worker n'a **aucun accès aux clés Megolm** : elles vivent dans le store
 * crypto Rust d'une fenêtre. C'est donc lui qui demande l'aperçu à une fenêtre ouverte,
 * par ce protocole — un message, une réponse, rien de conservé nulle part.
 *
 * Limite assumée, écrite dans les limites connues (M-H) : sans fenêtre ouverte, la
 * notification reste générique. Faire mieux demanderait la crypto Rust dans le service
 * worker ; ce n'est pas un contournement à improviser.
 */
export const TYPE_APERCU = "tacita-apercu";

export interface Apercu {
  expediteur: string;
  texte: string;
}

/**
 * L'aperçu d'un événement, **déchiffré ici** — c'est-à-dire lu dans la timeline que le
 * SDK a déjà déchiffrée pour cette fenêtre.
 *
 * `null` dès que quoi que ce soit manque : événement pas encore synchronisé, clé absente,
 * message sans corps. : l'appelant affiche alors une notification générique,
 * sans erreur bruyante — un échec de déchiffrement est un cas de fonctionnement normal
 * sur un client chiffré, pas une panne.
 */
export function apercuLocal(session: Session, roomId: string, eventId?: string): Apercu | null {
  try {
    const evenement = listerMessages(session, roomId).find(
      (candidat) => candidat.getId() === eventId,
    );
    const texte = evenement ? messageText(evenement) : "";
    if (!evenement || !texte) return null;

    const auteur = evenement.getSender() ?? "";
    // Le même annuaire que la conversation : pas d'accès SDK ici.
    const nom = mentionCandidates(session, roomId).find((c) => c.id === auteur)?.label ?? auteur;
    return { expediteur: nom, texte };
  } catch {
    return null;
  }
}

/**
 * sur iOS, le Web Push n'existe **que** pour une PWA installée à l'écran
 * d'accueil. Hors standalone, `Notification` n'existe même pas dans Safari : sans cette
 * distinction, l'écran des réglages annonce « ce navigateur ne gère pas les
 * notifications » à quelqu'un dont le navigateur les gère très bien — il lui manque un
 * geste, et c'est le seul message qui l'aide.
 *
 * Ces deux prédicats vivaient dans `components/onboarding/IosPushEducation.tsx`. Ils
 * sont ici parce que l'état de l'abonnement en dépend, et qu'un module de `lib/` ne
 * remonte pas vers un composant.
 *
 * `standalone` sur `navigator` est une extension Safari, absente du type standard.
 */
/**
 * Ferme les notifications d'une conversation qu'on regarde, et remet le badge au compte.
 * Sans ça, elles s'empilaient dans le centre de notifications d'iOS même après lecture.
 *
 * Le `tag` de chaque notification **est** son `roomId` (`public/sw.js`) : c'est ce qui
 * permet de ne fermer que celles de ce salon. Même règle de badge que le worker —
 * conversations en attente, pas messages non lus. `getRegistration` et non `ready` : sans
 * worker enregistré (développement), `ready` ne résoudrait jamais.
 */
export async function effacerNotifications(roomId: string): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration();
  if (!registration) return;

  for (const notification of await registration.getNotifications({ tag: roomId })) {
    notification.close();
  }
  const restantes = (await registration.getNotifications()).length;
  await (restantes > 0 ? navigator.setAppBadge?.(restantes) : navigator.clearAppBadge?.());
}

export const estIOS = (userAgent: string) =>
  /iPad|iPhone|iPod/.test(userAgent) ||
  // iPadOS 13+ se présente comme un Macintosh dès qu'il est en « site pour ordinateur »,
  // ce qui est son défaut sur grand écran. Sans cette seconde branche, un iPad dans
  // Safari s'entend répondre « ce navigateur ne gère pas les notifications » — faux, et
  // sans issue, alors qu'il lui manque exactement le même geste qu'à un iPhone. Le
  // pointeur tactile est le seul signal qui reste : un Mac en rend 0.
  (/Macintosh/.test(userAgent) && (globalThis.navigator?.maxTouchPoints ?? 0) > 1);

export const estInstallee = (): boolean =>
  globalThis.matchMedia?.("(display-mode: standalone)").matches === true ||
  (globalThis.navigator as Navigator & { standalone?: boolean }).standalone === true;

/**
 * Les six états de l'abonnement, et le seul vocabulaire que l'interface emploie.
 *
 * Ils sont **ordonnés par cause** et non par gravité : chacun nomme le geste qui manque,
 * parce que c'est la seule chose qu'un écran de réglages puisse dire d'utile.
 *
 * - `indisponible` — ce navigateur n'a ni `Notification` ni service worker ;
 * - `ios-a-installer` — iPhone hors écran d'accueil : rien n'est possible avant l'ajout ;
 * - `refuse` — permission refusée ; elle ne se redemande pas, elle se lève dans le
 *   navigateur ;
 * - `possible` — permission jamais demandée : un geste suffit ;
 * - `a-reparer` — permission accordée et pourtant **rien ne notifie** : abonnement du
 *   navigateur absent, ou pusher jamais enregistré sur le compte. C'est l'état qui
 *   n'existait pas, et son absence est ce qui faisait afficher « Notifications
 *   activées » à quelqu'un qui n'en recevait aucune (interdit n°13) ;
 * - `abonne` — les trois maillons sont en place.
 */
export type EtatPush =
  | "indisponible"
  | "ios-a-installer"
  | "refuse"
  | "possible"
  | "a-reparer"
  | "abonne";

/**
 * L'état lisible **sans réseau ni session**, au premier rendu des réglages.
 *
 * `accordee` n'est pas un `EtatPush` : c'est le cas où seule une vérification en ligne
 * peut trancher entre `abonne` et `a-reparer`. Le dire ici évite de promettre l'un ou
 * l'autre avant d'avoir regardé.
 */
export function etatPushLocal(): Exclude<EtatPush, "abonne" | "a-reparer"> | "accordee" {
  // L'ordre compte : sur iPhone hors standalone, `Notification` est absent, et le
  // diagnostic « navigateur incapable » y serait faux **et** décourageant.
  if (typeof navigator !== "undefined" && estIOS(navigator.userAgent) && !estInstallee()) {
    return "ios-a-installer";
  }
  if (typeof Notification === "undefined" || !("serviceWorker" in globalThis.navigator)) {
    return "indisponible";
  }
  if (Notification.permission === "denied") return "refuse";
  if (Notification.permission === "default") return "possible";
  return "accordee";
}

/**
 * Les trois maillons de la chaîne, séparément.
 *
 * C'est **le** livrable de cet écran, et pas un confort de développeur : la chaîne
 * traverse un navigateur, un service worker, un service push tiers, Synapse et une
 * passerelle. Un seul booléen « activé » ne dit pas lequel a lâché, et c'est exactement
 * ce qui rendait la panne muette — permission accordée, aucun abonnement, aucun pusher,
 * et l'écran qui répondait « Notifications activées ».
 */
export interface DiagnosticPush {
  etat: EtatPush;
  /** L'utilisateur a accordé la permission à ce navigateur. */
  permission: boolean;
  /** Le navigateur a une `PushSubscription` vivante, chiffrée avec **notre** clé VAPID. */
  abonnement: boolean;
  /** Synapse connaît ce pusher : c'est lui qui appellera la passerelle. */
  pusher: boolean;
}

const APP_ID = "org.tacita.web";

/** la clé publique VAPID, servie par la passerelle. */
async function cleVapid(): Promise<string> {
  const reponse = await fetch(PUSH_CONFIG_URL);
  if (!reponse.ok) throw new Error("passerelle push indisponible");
  const { vapid_public_key } = (await reponse.json()) as { vapid_public_key?: string };
  if (!vapid_public_key) throw new Error("passerelle push sans clé VAPID");
  return vapid_public_key;
}

/** base64url → octets : ce que `pushManager.subscribe` attend comme clé serveur. */
function octetsDeBase64Url(valeur: string): Uint8Array {
  const base64 = valeur.replaceAll("-", "+").replaceAll("_", "/");
  const binaire = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binaire, (caractere) => caractere.charCodeAt(0));
}

/**
 * Le service worker **actif**, ou `null` — jamais une attente sans fin.
 *
 * `navigator.serviceWorker.ready` ne rejette pas : sans enregistrement, elle attend pour
 * toujours. C'était le défaut exact du bouton « Activer les notifications » — un appui,
 * une promesse jamais résolue, aucun message, rien. Un état terminal vaut mieux qu'un
 * spinner éternel, même quand il dit non.
 *
 * L'enregistrement est retenté ici, à la demande : si celui du démarrage a échoué
 * c'est le moment où quelqu'un demande explicitement des notifications qui
 * mérite une seconde chance. Hors production on ne l'enregistre pas — même règle que
 * `app/register-sw.tsx`, et pour la même raison.
 */
const DELAI_SW_MS = 10_000;

async function serviceWorkerActif(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;

  const existant = await navigator.serviceWorker.getRegistration().catch(() => undefined);
  const enregistrement =
    existant ??
    (process.env.NODE_ENV === "production"
      ? await navigator.serviceWorker.register("/sw.js").catch(() => null)
      : null);

  if (!enregistrement) return null;
  if (enregistrement.active) return enregistrement;

  // L'installation est en cours : on l'attend, mais bornée.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resoudre) => setTimeout(() => resoudre(null), DELAI_SW_MS)),
  ]);
}

/**
 * Une subscription créée avec une **autre** clé VAPID est indéchiffrable par notre
 * passerelle : le service push répond 403 et rien n'arrive, sans que rien ne le dise.
 * Le cas se produit dès qu'un déploiement régénère ses clés.
 *
 * `true` quand la clé n'est pas lisible : certains navigateurs n'exposent pas
 * `options.applicationServerKey`. Y répondre « différente » ferait se réabonner à chaque
 * ouverture, donc changerait d'endpoint à chaque fois, donc laisserait derrière un pusher
 * mort à chaque fois. Dans le doute, on garde.
 */
function memeCleVapid(abonnement: PushSubscription, cle: Uint8Array): boolean {
  const posee = abonnement.options?.applicationServerKey;
  if (!posee) return true;
  const octets = new Uint8Array(posee);
  return octets.length === cle.length && octets.every((octet, i) => octet === cle[i]);
}

/**
 * met la chaîne en état, et **rend ce qu'elle vaut vraiment**.
 *
 * Idempotente, sans effet de bord visible, appelable à chaque ouverture de l'app : c'est
 * elle qui répare toute seule les trois pannes qu'on ne peut pas empêcher — la
 * subscription que le navigateur fait tourner, le pusher que Synapse a supprimé après un
 * 410, et la clé VAPID régénérée au déploiement. Elle ne demande **jamais** la
 * permission : c'est le rôle de
 * {@link demanderEtBrancher}, qui a le geste de l'utilisateur pour elle.
 *
 * Le pusher n'est réécrit que s'il manque. Sa présence est relue après écriture : une
 * promesse résolue ne prouve que l'acceptation du POST, et fait de Synapse
 * l'appelant de la passerelle — un pusher absent du compte, c'est une chaîne coupée à
 * l'endroit précis où personne ne regarde.
 */
export async function brancherPush(session: Session): Promise<DiagnosticPush> {
  const local = etatPushLocal();
  if (local !== "accordee") {
    return { etat: local, permission: false, abonnement: false, pusher: false };
  }

  const echec = (): DiagnosticPush => ({
    etat: "a-reparer",
    permission: true,
    abonnement: false,
    pusher: false,
  });

  try {
    const enregistrement = await serviceWorkerActif();
    if (!enregistrement) return echec();

    // Les deux en parallèle : la clé sert à valider l'abonnement existant, la liste des
    // pushers à savoir s'il y a quoi que ce soit à écrire.
    const [cleBrute, pushers] = await Promise.all([
      cleVapid(),
      session.client.getPushers().then(({ pushers }) => pushers),
    ]);
    const cle = octetsDeBase64Url(cleBrute);

    let abonnement = await enregistrement.pushManager.getSubscription();
    if (abonnement && !memeCleVapid(abonnement, cle)) {
      await abonnement.unsubscribe().catch(() => false);
      abonnement = null;
    }
    abonnement ??= await enregistrement.pushManager.subscribe({
      // Exigé par les navigateurs : tout réveil push doit produire une notification
      // visible. C'est aussi ce que nous faisons — y compris quand elle est générique.
      userVisibleOnly: true,
      applicationServerKey: cle as BufferSource,
    });

    const { endpoint, keys } = abonnement.toJSON() as {
      endpoint: string;
      keys?: { p256dh?: string; auth?: string };
    };
    // Sans ces deux clés, la passerelle ne peut chiffrer aucun push et rejette le pusher
    // l'enregistrer serait enregistrer une panne.
    if (!keys?.p256dh || !keys.auth) return { ...echec(), abonnement: false };

    // Un pusher encore en `event_id_only` compte comme absent : ce format retire aussi
    // l'expéditeur, et le réécrire ici suffit à migrer les appareils déjà abonnés.
    const deja = pushers.some(
      (pusher) =>
        pusher.pushkey === endpoint && pusher.app_id === APP_ID && pusher.data.format !== "event_id_only",
    );
    if (deja) return { etat: "abonne", permission: true, abonnement: true, pusher: true };

    await session.client.setPusher({
      kind: "http",
      app_id: APP_ID,
      pushkey: endpoint,
      app_display_name: "Tacita",
      device_display_name: session.client.getDeviceId() ?? "web",
      lang: "fr",
      // La spec Matrix laisse `data` libre ; le type du SDK ne connaît que `url`, `format`
      // et `brand`. Les clés de la subscription y sont indispensables — c'est là que la
      // passerelle les relit, et sans elles aucun push ne peut être chiffré.
      // **Pas** de `format: "event_id_only"` : il retire aussi l'expéditeur, seul repli
      // possible quand l'app est fermée. Synapse envoie donc l'événement complet à la
      // passerelle — contenu **chiffré**, jamais du clair — qui n'en relaie au navigateur
      // que les identifiants et l'expéditeur.
      data: {
        url: PUSH_NOTIFY_URL,
        p256dh: keys.p256dh,
        auth: keys.auth,
      } as { url: string },
      append: false,
    });

    // Relu au serveur : c'est la seule preuve que Synapse appellera la passerelle.
    const { pushers: apres } = await session.client.getPushers();
    const pusher = apres.some((p) => p.pushkey === endpoint && p.app_id === APP_ID);
    return {
      etat: pusher ? "abonne" : "a-reparer",
      permission: true,
      abonnement: true,
      pusher,
    };
  } catch {
    // Passerelle injoignable, service push en panne, réseau coupé : l'état le dit, et
    // l'écran des réglages propose de réessayer. Rien n'est journalisé (interdit n°8).
    return echec();
  }
}

/**
 * l'abonnement complet, **depuis un geste de l'utilisateur**.
 *
 * `Notification.requestPermission()` n'a d'effet que dans un gestionnaire d'événement :
 * appelée ailleurs, elle rend `denied` sur mobile sans rien afficher. Tous les appelants
 * de cette fonction sont donc des `onClick`, et aucun `await` ne la précède.
 */
export async function demanderEtBrancher(session: Session): Promise<DiagnosticPush> {
  const local = etatPushLocal();
  if (local !== "possible" && local !== "accordee") {
    return { etat: local, permission: false, abonnement: false, pusher: false };
  }

  if (Notification.permission === "default") {
    const reponse = await Notification.requestPermission().catch(() => "denied" as const);
    if (reponse !== "granted") {
      // Un refus est un choix, pas une erreur : l'état le porte, personne ne lève. Et
      // l'invite **fermée sans répondre** rend `default` : c'est encore `possible`, pas
      // un refus — le dire faux fermerait la porte que l'utilisateur a seulement laissée
      // entrouverte. La réponse fait foi, pas `Notification.permission` relu après coup :
      // les deux disent la même chose dans un navigateur, et seule la première existe
      // partout au moment où on en a besoin.
      return {
        etat: reponse === "denied" ? "refuse" : "possible",
        permission: false,
        abonnement: false,
        pusher: false,
      };
    }
  }

  return brancherPush(session);
}
