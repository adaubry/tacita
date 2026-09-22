import type { Session } from "@tacita/client-core";
import { mentionCandidates, messageText } from "@tacita/messaging";

/**
 * REQ-UI-18 / REQ-UIX-40 — le pont entre le service worker réveillé par un push et la
 * seule chose capable de lire un message chiffré : l'application elle-même.
 *
 * Le payload porte les identifiants et l'expéditeur, jamais de contenu (REQ-PSH-02,
 * amendée E-12). Le SW ne sait pas déchiffrer — les clés Megolm vivent dans le magasin
 * crypto du SDK, ouvert par l'onglet. Il demande donc l'aperçu ici, et affiche « Nouveau
 * message de X » quand personne ne peut répondre. **Rien de ce qui transite par ce module n'est journalisé ni mis en cache**
 * (interdit n°8) : il n'y a pas un seul `console.` dans ce fichier, et c'est un test qui
 * le garde.
 */

/** Le nom du canal, partagé avec `public/sw.js`. Changer l'un sans l'autre coupe le pont. */
export const CANAL_PUSH = "tacita:push";

export interface PayloadPush {
  event_id: string;
  room_id: string;
}

export interface ApercuNotification {
  titre: string;
  corps: string;
}

/**
 * REQ-UI-18 — l'événement désigné par le push, **déchiffré localement** puis réduit à ce
 * qu'une notification affiche.
 *
 * `undefined` veut dire « pas d'aperçu » et couvre les trois cas de REQ-UIX-40 : clés
 * absentes (déchiffrement en échec), événement pas encore reçu par ce client, message
 * sans corps affichable. Aucun n'est une erreur bruyante — la notification générique est
 * le comportement attendu, pas un repli honteux.
 */
export function apercuDuPush(session: Session, payload: PayloadPush): ApercuNotification | undefined {
  const salon = session.client.getRoom(payload.room_id);
  const evenement = salon?.findEventById(payload.event_id);
  if (!evenement || evenement.isDecryptionFailure()) return undefined;

  const corps = messageText(evenement);
  if (!corps) return undefined;

  const auteur = evenement.getSender() ?? "";
  // Le libellé vient de l'annuaire du paquet 05, comme dans la timeline (M-D) : deux
  // sources de noms d'affichage finiraient par ne pas dire la même chose.
  const nom =
    mentionCandidates(session, payload.room_id).find((candidat) => candidat.id === auteur)?.label ??
    auteur;

  return { titre: nom, corps };
}

/**
 * Ferme les notifications d'une conversation qu'on regarde, et remet le badge au compte.
 * Sans ça, elles s'empilaient dans le centre de notifications d'iOS même après lecture.
 *
 * Le tag de chaque notification **est** son `room_id` (`public/sw.js`) : c'est ce qui
 * permet de ne fermer que celles de ce salon. Même règle de badge que le worker —
 * conversations en attente, pas messages non lus.
 *
 * `getRegistration` et non `ready` : hors production aucun worker n'est enregistré, et
 * `ready` ne résoudrait jamais. Tout échec est silencieux — c'est du ménage d'affichage.
 */
export async function effacerNotifications(roomId: string): Promise<void> {
  const navigateur = globalThis.navigator as
    | (Navigator & { setAppBadge?(n: number): Promise<void>; clearAppBadge?(): Promise<void> })
    | undefined;
  const registration = await navigateur?.serviceWorker?.getRegistration?.();
  if (!registration?.getNotifications) return;

  for (const notification of await registration.getNotifications({ tag: roomId })) {
    notification.close();
  }
  const restantes = await registration.getNotifications();
  await (restantes.length > 0 ? navigateur?.setAppBadge?.(restantes.length) : navigateur?.clearAppBadge?.());
}

/**
 * Écoute les demandes du service worker et y répond. Branché une fois la session prête,
 * pour toute la durée de vie de l'onglet.
 *
 * Le SW joint un `MessagePort` : la réponse repart par lui et par lui seul, donc aucun
 * contenu déchiffré ne traîne dans un `postMessage` diffusé à tous les clients.
 */
export function brancherNotifications(session: Session): () => void {
  const worker = globalThis.navigator?.serviceWorker;
  if (!worker) return () => {};

  const surMessage = (evenement: MessageEvent) => {
    const donnees = evenement.data as ({ type?: string } & PayloadPush) | null;
    const port = evenement.ports[0];
    if (donnees?.type !== CANAL_PUSH || !port) return;

    try {
      port.postMessage(apercuDuPush(session, donnees) ?? null);
    } catch {
      // Salon inconnu du store, session en cours de fermeture : le SW attend une
      // réponse, et l'absence de réponse le ferait patienter jusqu'à son délai.
      port.postMessage(null);
    }
  };

  worker.addEventListener("message", surMessage);
  return () => worker.removeEventListener("message", surMessage);
}
