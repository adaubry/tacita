/**
 * La liste des conversations telle que l'accueil la montre.
 *
 * Rassemble par salon le dernier message, le compte de non-lus et l'interlocuteur.
 * L'ordre est celui du flux /sync, jamais `origin_server_ts`.
 */
import type { Session } from "@tacita/client-core";
import {
  ClientEvent,
  EventType,
  KnownMembership,
  NotificationCountType,
  RoomEvent,
  type Room,
} from "matrix-js-sdk";

import { messages, messageText } from "./messages";
import { createDirectMessage } from "./rooms";

/**
 * l'épingle est le tag natif `m.favourite`. Rien n'est inventé par-dessus :
 * les tags sont de l'account data de salon, donc synchronisés entre les appareils sans
 * qu'aucun store maison n'ait à l'être. Le serveur les voit — c'est une métadonnée de
 * plus, au même titre que l'appartenance au salon (honnêteté produit).
 */
export const FAVOURITE_TAG = "m.favourite";

/** une conversation telle que le shard UI en a besoin. */
export interface Conversation {
  roomId: string;
  /** Nom du salon tel que le SDK le calcule ; en DM, c'est celui de l'autre. */
  name: string;
  direct: boolean;
  /** L'autre membre, en DM seulement. La règle d'avatar du shard en dépend. */
  peerId?: string;
  /** Dernier message texte, tel quel. La troncature est un choix de rendu. */
  preview: string;
  /**
   * `msgtype` du dernier message, quand il n'est pas du texte.
   *
   * **Sans lui, l'accueil affichait le nom du fichier** — `vocal-1793145337523.webm` —,
   * parce que c'est ce que Matrix met dans le `body` d'une pièce jointe. Un nom de
   * fichier n'est pas un aperçu : il ne dit ni ce que c'est, ni qui l'a envoyé, et il
   * expose un détail que personne n'a choisi de montrer.
   *
   * Le paquet rend le **fait** (`m.audio`), jamais la phrase : nommer un média est du
   * vocabulaire d'interface, et il est déjà écrit une fois dans le shard.
   */
  previewMsgtype?: string;
  /** Le dernier message vient de nous. L'UI en tire « Vous » plutôt qu'un nom. */
  previewDeMoi: boolean;
  /**
   * Nom d'affichage de l'expéditeur du dernier message.
   *
   * Nécessaire **à cause des groupes** : en tête-à-tête il vaut le nom du salon, mais
   * dans un groupe le salon s'appelle « Équipe » et l'expéditeur s'appelle autrement.
   * S'en passer ferait dire « Équipe vous a envoyé un message vocal ».
   */
  previewAuteur?: string;
  /** Horodatage du dernier message, `0` si le salon n'en a aucun. */
  timestamp: number;
  /** Compteur natif de notifications non lues. */
  unread: number;
  /** Au moins une mention non lue. Elle prime sur le compteur, côté rendu. */
  mention: boolean;
  pinned: boolean;
  /**
   * **L'avatar du salon, en `mxc://`** (30/08/2026, plainte : « la photo de profil d'un
   * utilisateur ne s'affiche pas dans l'accueil »).
   *
   * Il manquait purement et simplement : `ConversationAvatar` sait résoudre un `mxc://`
   * par un fetch authentifié, mais aucun appelant de la liste ne pouvait lui en donner un
   * — le contrat ne le portait pas. Toutes les conversations de l'accueil, de la recherche
   * et des informations de salon retombaient donc sur les initiales, y compris pour des
   * comptes qui ont bien une photo.
   *
   * En DM, c'est l'avatar du correspondant et non celui du salon : un DM n'a pas d'avatar
   * de salon, et `getAvatarFallbackMember()` est ce que le SDK expose pour retrouver
   * l'autre membre.
   */
  avatarUrl?: string;
}

/** une invitation en attente : la « demande d'ami » de D-09. */
export interface Invitation {
  roomId: string;
  name: string;
  /** L'invitant, quand le SDK le connaît (invitation de DM). */
  from?: string;
}

/**
 * `m.direct` est l'account data qui dit quels salons sont des DM, et avec qui. C'est la
 * seule source : `is_direct` n'est qu'un drapeau de création, il ne survit pas dans
 * l'état du salon.
 */
function directPeers(session: Session): Map<string, string> {
  const content = session.client.getAccountData(EventType.Direct)?.getContent() ?? {};
  const peers = new Map<string, string>();
  for (const [userId, roomIds] of Object.entries(content)) {
    if (!Array.isArray(roomIds)) continue;
    for (const roomId of roomIds as string[]) peers.set(roomId, userId);
  }
  return peers;
}

/**
 * **inscrit un salon dans `m.direct`.** Personne d'autre ne le fait.
 *
 * `createRoom({ is_direct: true })` ne pose ce drapeau que dans l'invitation envoyée : le
 * serveur n'écrit **pas** l'account data `m.direct` du créateur, et le SDK non plus. Sans
 * cette écriture, un DM créé par l'app n'est un DM pour personne — mesuré avec deux
 * navigateurs contre un vrai Synapse, où un DM s'affichait « 2 membres,
 * c'est le début de ce groupe ».
 *
 * Cinq choses en dépendaient, toutes cassées en silence : le libellé et l'avatar du DM,
 * la liste d'amis (vide, elle filtre sur `peerId`), « retirer un ami » (ne trouvait aucun
 * salon), et surtout la déduplication de sans `m.direct`, `openDirectMessage`
 * recréait un salon **à chaque fois**, ce que l'exigence interdit explicitement.
 *
 * Lecture-modification-écriture : l'account data est un document unique pour tous les
 * correspondants, l'écraser effacerait les autres DM (même motif que `ignoreUser`).
 */
export async function registerDirect(
  session: Session,
  userId: string,
  roomId: string,
): Promise<void> {
  const contenu = { ...(session.client.getAccountData(EventType.Direct)?.getContent() ?? {}) };
  const existants: string[] = Array.isArray(contenu[userId]) ? [...contenu[userId]] : [];
  if (existants.includes(roomId)) return;

  await session.client.setAccountData(EventType.Direct, {
    ...contenu,
    [userId]: [...existants, roomId],
  });
}

/**
 * l'avatar à montrer pour ce salon. En DM, celui de l'autre : un salon
 * de deux personnes n'a pas d'avatar de salon, et en afficher un vide reviendrait à
 * effacer la photo du correspondant. En groupe, celui du salon, et rien d'autre — le
 * premier membre venu ne représente pas le groupe.
 *
 * `undefined` plutôt que chaîne vide : `ConversationAvatar` retombe alors sur les
 * initiales, ce qui est le comportement voulu quand il n'y a pas d'image.
 */
function avatarDe(room: Room, peerId: string | undefined): string | undefined {
  if (peerId !== undefined) {
    return room.getMember(peerId)?.getMxcAvatarUrl() ?? undefined;
  }
  return room.getMxcAvatarUrl() ?? undefined;
}

function describe(session: Session, room: Room, peers: Map<string, string>): Conversation {
  // le dernier message est le dernier du flux /sync, pas le plus récemment
  // horodaté. Aucun tri n'est introduit ici.
  const last = messages(session, room.roomId).at(-1);
  const peerId = peers.get(room.roomId);

  const expediteur = last?.getSender();
  // `m.text` n'est pas remonté : c'est le cas par défaut, et le rendre explicite
  // obligerait chaque lecteur à le réécarter.
  const msgtype = last?.getContent().msgtype as string | undefined;

  return {
    roomId: room.roomId,
    name: room.name,
    direct: peerId !== undefined,
    peerId,
    preview: last ? messageText(last) : "",
    previewMsgtype: msgtype === "m.text" ? undefined : msgtype,
    previewDeMoi: expediteur !== undefined && expediteur === session.client.getUserId(),
    // `name` du membre et non l'identifiant : c'est le nom que l'écran affiche partout
    // ailleurs. Le repli sur l'identifiant est exact, et vaut mieux qu'une ligne vide.
    previewAuteur: expediteur ? (room.getMember(expediteur)?.name ?? expediteur) : undefined,
    timestamp: last?.getTs() ?? 0,
    unread: room.getUnreadNotificationCount(NotificationCountType.Total),
    mention: room.getUnreadNotificationCount(NotificationCountType.Highlight) > 0,
    pinned: FAVOURITE_TAG in room.tags,
    avatarUrl: avatarDe(room, peerId),
  };
}

/**
 * les conversations rejointes, la plus récente d'abord.
 *
 * **Sur l'ordre.** L'interdit de tri par `origin_server_ts`
 * porte sur l'ordre des messages *dans* une timeline, où le flux /sync fait autorité et
 * où l'horodatage est un mensonge possible du serveur. Une **liste de salons**, elle,
 * n'a pas d'ordre dans /sync : `getRooms()` rend l'ordre d'insertion du store, qui n'est
 * ni la récence ni rien de stable. La récence du dernier message est le seul signal
 * disponible côté client, et il est ici *le seul* endroit du dépôt où il sert de clé de
 * tri — jamais à l'intérieur d'un salon. Décision et alternatives écartées :
 * Escalade E-09.
 */
export function conversations(session: Session): Conversation[] {
  const peers = directPeers(session);
  return session.client
    .getRooms()
    .filter((room) => room.getMyMembership() === KnownMembership.Join)
    .map((room) => describe(session, room, peers))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * les invitations en attente. D-09 : une demande d'ami **est** une
 * invitation de salon DM native ; il n'y a pas d'autre objet à lire.
 */
export function invitations(session: Session): Invitation[] {
  return session.client
    .getRooms()
    .filter((room) => room.getMyMembership() === KnownMembership.Invite)
    .map((room) => ({ roomId: room.roomId, name: room.name, from: room.getDMInviter() }));
}

/**
 * épingler et désépingler. `{}` en métadonnée : l'ordre des favoris se
 * porte par un champ `order` que rien ne lit chez nous, et l'inventer serait un tri de
 * plus à maintenir.
 */
export function setFavourite(session: Session, roomId: string, pinned: boolean): Promise<object> {
  return pinned
    ? session.client.setRoomTag(roomId, FAVOURITE_TAG, {})
    : session.client.deleteRoomTag(roomId, FAVOURITE_TAG);
}

/**
 * le DM avec cet utilisateur, existant ou créé. **Jamais un second.**
 *
 * La règle vit ici et pas dans l'UI : deux écrans peuvent ouvrir une conversation
 * (accueil, profil), et une déduplication recopiée dérive. Un DM quitté ne compte pas —
 * il reste listé dans `m.direct` alors qu'on n'y est plus.
 */
export async function openDirectMessage(session: Session, userId: string): Promise<string> {
  for (const [roomId, peerId] of directPeers(session)) {
    if (peerId !== userId) continue;
    if (session.client.getRoom(roomId)?.getMyMembership() === KnownMembership.Join) return roomId;
  }

  /*
   * **Une invitation reçue de cette personne compte** (30/08/2026, plainte : « la
   * duplication d'une demande d'ami crée une deuxième conversation »).
   *
   * La boucle ci-dessus ne reconnaissait que les salons **rejoints**. Or quand quelqu'un
   * vous a déjà envoyé une demande et que vous l'ajoutez de votre côté — depuis son profil,
   * ou par un lien —, son salon est en `invite` et non en `join` : il était donc ignoré, et
   * un second DM était créé. Les deux personnes se retrouvaient avec deux conversations,
   * dont une morte.
   *
   * On rejoint l'invitation en attente plutôt que d'en fabriquer une autre : c'est le même
   * geste que « Accepter » dans l'écran des demandes, et il rend le même salon.
   *
   * `m.direct` n'est pas fiable ici — le serveur ne l'écrit pas toujours chez l'invité —,
   * donc on interroge `getDMInviter()`, qui lit le `is_direct` de l'invitation elle-même.
   */
  const invitation = session.client
    .getRooms()
    .find(
      (room) =>
        room.getMyMembership() === KnownMembership.Invite && room.getDMInviter() === userId,
    );
  if (invitation) {
    await session.client.joinRoom(invitation.roomId);
    await registerDirect(session, userId, invitation.roomId);
    return invitation.roomId;
  }
  const { room_id } = await createDirectMessage(session, userId);
  // Sans cette ligne, la boucle ci-dessus ne retrouvera jamais ce salon et un second
  // sera créé au prochain appel — ce que interdit.
  await registerDirect(session, userId, room_id);
  return room_id;
}

/**
 * signal de changement de la liste, branché sur l'émetteur du SDK comme
 * `subscribe()` : aucun store ni bus maison par-dessus.
 *
 * Cinq événements, parce que cinq choses changent la liste : l'apparition d'un salon
 * (invitation reçue), un message (aperçu et récence), un tag (épingle), un reçu (les
 * compteurs de non-lus retombent quand on lit ailleurs) et l'appartenance (invitation
 * acceptée, salon quitté). En manquer un donne une liste qui se fige jusqu'au prochain
 * message — le défaut le plus difficile à voir en revue, et le premier des cinq a
 * effectivement manqué jusqu'au 07/08/2026.
 *
 * `RoomEvent.UnreadNotifications` serait le signal direct des badges, mais le
 * `MatrixClient` **ne le réémet pas** (il n'est pas dans son union `RoomEvents`, vérifié
 * sur la version épinglée 42.0.0) : s'y abonner ne lèverait pas, ça ne ferait rien.
 * `Receipt` couvre le même besoin par le chemin que le client émet réellement.
 */
export function subscribeConversations(session: Session, listener: () => void): () => void {
  const notifier = (): void => listener();

  /**
   * `ClientEvent.Room` — **l'apparition d'un salon**, et non un changement dans un salon
   * déjà connu. C'est le signal d'une invitation reçue : le salon n'existait pas encore
   * côté client, donc aucun de ses propres événements n'a pu être réémis à temps.
   *
   * Mesuré contre un vrai Synapse, avec deux navigateurs : sans lui, une
   * demande d'ami n'apparaissait **qu'après rechargement complet de la page**. Le serveur
   * la livrait bien — elle était dans le `/sync` de l'invité — mais rien dans l'app ne
   * disait qu'il fallait relire. C'est le parcours d'entrée du produit : on ne
   * peut pas commencer une conversation sans que l'autre voie la demande.
   *
   * `MyMembership` ne suffit pas et reste nécessaire : il porte l'acceptation et le
   * départ, sur des salons déjà connus.
   */
  session.client.on(ClientEvent.Room, notifier);
  session.client.on(RoomEvent.Timeline, notifier);
  session.client.on(RoomEvent.Tags, notifier);
  session.client.on(RoomEvent.Receipt, notifier);
  session.client.on(RoomEvent.MyMembership, notifier);

  return () => {
    session.client.off(ClientEvent.Room, notifier);
    session.client.off(RoomEvent.Timeline, notifier);
    session.client.off(RoomEvent.Tags, notifier);
    session.client.off(RoomEvent.Receipt, notifier);
    session.client.off(RoomEvent.MyMembership, notifier);
  };
}
