/**
 * Les salons : création, appartenance, état, droits.
 *
 * Les power levels sont lus tels quels, en nombres — aucun rôle nommé n'existe
 * dans ce produit.
 */
import type { Session } from "@tacita/client-core";
import {
  ConditionKind,
  EventType,
  JoinRule as SdkJoinRule,
  KnownMembership,
  Preset,
  PushRuleActionName,
  PushRuleKind,
  type EmptyObject,
  type IPushRule,
  type ISendEventResponse,
  type RoomMember,
} from "matrix-js-sdk";

/** Algorithme Megolm imposé par la spec Matrix pour un salon chiffré. */
const encryptionState = {
  type: EventType.RoomEncryption,
  state_key: "",
  content: { algorithm: "m.megolm.v1.aes-sha2" },
};

/**
 * garde unique de tout ce que ce package envoie. Le chiffrement est
 * déjà garanti côté serveur (`encryption_enabled_by_default_for_room_type`),
 * mais un envoi en clair est une fuite irréversible : on vérifie côté client avant
 * chaque écriture plutôt que de faire confiance à une config distante.
 */
export async function assertEncrypted(session: Session, roomId: string): Promise<void> {
  // Le prédicat vit dans la Session () : la file d'envoi de la
  // `@tacita/outbox` a besoin de la même garde, et deux copies d'un contrôle de sécurité
  // dérivent. Ici on lève, parce que c'est ce que les appelants de ce package
  // attendent ; l'outbox, elle, consulte le prédicat directement.
  if (!(await session.isEncrypted(roomId))) {
    throw new Error(`salon ${roomId} non chiffré : envoi refusé`);
  }
}

/** DM : salon à 2, `is_direct`, chiffré dès la création. */
export function createDirectMessage(session: Session, userId: string): Promise<{ room_id: string }> {
  return session.client.createRoom({
    is_direct: true,
    invite: [userId],
    preset: Preset.TrustedPrivateChat,
    initial_state: [encryptionState],
  });
}

/** group chat, chiffré dès la création lui aussi. */
export function createGroupChat(
  session: Session,
  name: string,
  invite: string[] = [],
): Promise<{ room_id: string }> {
  return session.client.createRoom({
    name,
    invite,
    preset: Preset.PrivateChat,
    initial_state: [encryptionState],
  });
}

/**
 * l'épinglage passe par `m.room.pinned_events`, un événement d'**état**.
 * Les événements d'état ne sont jamais chiffrés en Matrix : le serveur voit la liste
 * des messages épinglés d'un salon. Exposé ici, documenté dans README.md.
 */
export const PINNED_EVENTS_METADATA = {
  cleartext: true,
  reason:
    "m.room.pinned_events est un événement d'état ; Matrix ne chiffre pas l'état. " +
    "Le serveur voit quels messages sont épinglés, dans quel salon et par qui.",
} as const;

export function getPinnedEvents(session: Session, roomId: string): string[] {
  const state = session.client
    .getRoom(roomId)
    ?.currentState.getStateEvents(EventType.RoomPinnedEvents, "");
  const pinned: unknown = state?.getContent().pinned;
  return Array.isArray(pinned) ? (pinned as string[]) : [];
}

export async function setPinnedEvents(
  session: Session,
  roomId: string,
  eventIds: string[],
): Promise<ISendEventResponse> {
  await assertEncrypted(session, roomId);
  return session.client.sendStateEvent(
    roomId,
    EventType.RoomPinnedEvents,
    { pinned: eventIds },
    "",
  );
}

/**
 * l'échelle de power levels Matrix est exposée telle quelle : des
 * entiers. Aucun rôle nommé, aucune catégorie, aucun héritage — la traduction en
 * libellés, si l'UI en veut, est l'affaire de l'UI.
 */
export function powerLevelOf(session: Session, roomId: string, userId: string): number {
  return session.client.getRoom(roomId)?.getMember(userId)?.powerLevel ?? 0;
}

export function setPowerLevel(
  session: Session,
  roomId: string,
  userId: string,
  powerLevel: number,
): Promise<ISendEventResponse> {
  return session.client.setPowerLevel(roomId, userId, powerLevel);
}

export function memberCount(session: Session, roomId: string): number {
  return session.client.getRoom(roomId)?.getJoinedMemberCount() ?? 0;
}

/**
 * **Les invitations en attente de ce salon.**
 *
 * `memberCount` ne compte que ceux qui ont rejoint — c'est la vérité du protocole, et
 * c'est bien ce qu'il doit rendre. Mais un groupe qu'on vient de créer n'affichait
 * alors que « 1 membre », soi, alors qu'on venait d'y inviter deux personnes : exact,
 * et incompréhensible. Ce second compte est ce qui manque pour le dire en entier.
 */
export function invitedCount(session: Session, roomId: string): number {
  return (
    session.client.getRoom(roomId)?.getMembersWithMembership(KnownMembership.Invite).length ?? 0
  );
}

export function members(session: Session, roomId: string): RoomMember[] {
  return session.client.getRoom(roomId)?.getJoinedMembers() ?? [];
}

/**
 * le droit d'exclure quelqu'un, **lu dans l'état du salon**, jamais deviné.
 *
 * Deux conditions, et les deux comptent : atteindre le niveau exigé pour l'action `kick`,
 * et être **strictement au-dessus** de la personne visée. Matrix refuse la seconde même
 * entre deux comptes à 100, et une UI qui ne testerait que la première afficherait un
 * bouton dont le serveur refuserait l'appel.
 *
 * Le prédicat vit ici parce que l'UI doit **masquer** le bouton non autorisé plutôt que
 * de le griser (M-H) : sans lui, le shard referait ce calcul de power levels, ce que la
 * `CLAUDE.md` le lui interdit.
 */
export function canKick(session: Session, roomId: string, userId: string): boolean {
  const room = session.client.getRoom(roomId);
  const self = session.client.getUserId();
  // Se sortir soi-même d'un salon est un `leave`, pas un `kick` : deux gestes distincts.
  if (!room || !self || userId === self) return false;

  const mine = room.getMember(self)?.powerLevel ?? 0;
  return (
    room.currentState.hasSufficientPowerLevelFor("kick", mine) &&
    mine > (room.getMember(userId)?.powerLevel ?? 0)
  );
}

export function kick(
  session: Session,
  roomId: string,
  userId: string,
  reason?: string,
): Promise<EmptyObject> {
  return session.client.kick(roomId, userId, reason);
}

/** inviter dans un salon existant. Le chemin natif de D-09, sans détour. */
export function invite(session: Session, roomId: string, userId: string): Promise<EmptyObject> {
  return session.client.invite(roomId, userId);
}

/**
 * le sas d'entrée d'un groupe (voie A).
 *
 * Un lien de groupe ne peut pas faire entrer tout seul : son porteur ne peut ni s'inviter
 * (il faut être membre) ni rejoindre un salon en `join_rule: invite`. Le `knock` natif
 * ouvre la seule porte qui ne coûte ni un graphe social (voie B) ni un pouvoir Matrix
 * pour le service de liens (voie C) : **le porteur frappe, un membre confirme.**
 *
 * Ces quatre fonctions sont des relais du SDK, et c'est voulu — la règle produit (quand
 * bascule-t-on, qui confirme) vit dans le shard, l'état vit dans le salon. Rien n'est
 * mémorisé ici : `joinRule` relit l'état à chaque appel, parce qu'un autre appareil de la
 * même personne peut avoir révoqué le dernier lien entre-temps.
 */
export type JoinRule = "invite" | "knock";

/**
 * Le SDK a son propre enum ; le shard, lui, n'importe pas matrix-js-sdk. On
 * expose donc une union de littéraux et on traduit ici — une table de deux entrées, pas
 * un cast : si un jour l'enum d'amont change de valeur, c'est cette ligne qui casse à la
 * compilation plutôt qu'un `join_rule` silencieusement invalide.
 */
const REGLES: Record<JoinRule, SdkJoinRule> = {
  invite: SdkJoinRule.Invite,
  knock: SdkJoinRule.Knock,
};

export function joinRule(session: Session, roomId: string): JoinRule {
  const contenu = session.client
    .getRoom(roomId)
    ?.currentState.getStateEvents(EventType.RoomJoinRules, "")
    ?.getContent();
  // Tout ce qui n'est pas explicitement `knock` est traité comme `invite` : c'est le
  // défaut de `Preset.PrivateChat`, et le sens qu'on veut dans le doute — fermé.
  return contenu?.join_rule === SdkJoinRule.Knock ? "knock" : "invite";
}

export function setJoinRule(
  session: Session,
  roomId: string,
  rule: JoinRule,
): Promise<ISendEventResponse> {
  return session.client.sendStateEvent(
    roomId,
    EventType.RoomJoinRules,
    { join_rule: REGLES[rule] },
    "",
  );
}

/**
 * Frapper à la porte. Le `reason` est **en clair** — c'est un événement d'appartenance,
 * et Matrix ne chiffre pas l'état : on n'en envoie donc aucun. Se présenter se fait dans
 * le salon, une fois entré.
 */
export function knock(session: Session, roomId: string): Promise<{ room_id: string }> {
  return session.client.knockRoom(roomId);
}

/**
 * Ceux qui ont frappé et attendent. `getJoinedMembers()` ne les rend pas — ils ne sont
 * pas joints —, il faut donc lire l'appartenance `knock` dans l'état du salon.
 */
export function knockers(session: Session, roomId: string): RoomMember[] {
  return session.client.getRoom(roomId)?.getMembersWithMembership(KnownMembership.Knock) ?? [];
}

/**
 * les trois niveaux de notification d'un salon. Ce sont des **push rules
 * Matrix natives**, pas un réglage maison : le serveur les évalue, elles suivent le
 * compte sur tous ses appareils, et rien n'est à synchroniser de notre côté.
 */
export type RoomNotificationLevel = "all" | "mentions" | "mute";

/**
 * Une règle qui ne notifie pas. `dont_notify` est la forme que le SDK épinglé (42.0.0)
 * écrit lui-même dans `setRoomMutePushRule` ; une liste d'actions vide dit la même chose
 * et se rencontre sur les comptes réglés par d'autres clients. **On reconnaît les deux à
 * la lecture, on écrit celle du SDK** — s'écarter de sa forme ferait diverger notre
 * lecture de la sienne.
 */
const silent = (rule: IPushRule | undefined): boolean =>
  rule !== undefined && !rule.actions.includes(PushRuleActionName.Notify);

/** La règle d'un salon pour un genre donné : son identifiant **est** le `roomId`. */
const ruleFor = (session: Session, kind: PushRuleKind, roomId: string): IPushRule | undefined =>
  session.client.pushRules?.global?.[kind]?.find((rule) => rule.rule_id === roomId);

/**
 * l'état actuel, tel que le compte le porte.
 *
 * L'ordre de lecture est celui de l'évaluation côté serveur : une règle `override`
 * l'emporte sur une règle `room`, donc « silencieux » se teste avant « mentions
 * uniquement ». L'inverse rendrait « mentions » sur un salon complètement muet.
 */
export function roomNotificationLevel(session: Session, roomId: string): RoomNotificationLevel {
  if (silent(ruleFor(session, PushRuleKind.Override, roomId))) return "mute";
  if (silent(ruleFor(session, PushRuleKind.RoomSpecific, roomId))) return "mentions";
  return "all";
}

/**
 * poser le niveau.
 *
 * Les deux règles sont retirées avant d'en écrire une : un salon ne porte qu'un niveau,
 * et laisser l'ancienne à côté de la nouvelle ferait dépendre le résultat de l'ordre
 * d'évaluation du serveur plutôt que du choix de l'utilisateur.
 *
 * - `mentions` — une règle de genre `room` qui ne notifie pas. Les mentions passent quand
 *   même : `.m.rule.is_user_mention` et `.m.rule.roomnotif` sont des `override`, évaluées
 *   avant. C'est exactement ce que le niveau promet.
 * - `mute` — une règle `override` sur le `room_id`, qui passe donc **avant** les mentions
 *   et les éteint aussi.
 */
export async function setRoomNotificationLevel(
  session: Session,
  roomId: string,
  level: RoomNotificationLevel,
): Promise<void> {
  for (const kind of [PushRuleKind.Override, PushRuleKind.RoomSpecific]) {
    if (ruleFor(session, kind, roomId)) await session.client.deletePushRule("global", kind, roomId);
  }

  if (level === "mute") {
    await session.client.addPushRule("global", PushRuleKind.Override, roomId, {
      conditions: [{ kind: ConditionKind.EventMatch, key: "room_id", pattern: roomId }],
      actions: [PushRuleActionName.DontNotify],
    });
  } else if (level === "mentions") {
    // Une règle de genre `room` s'applique par son identifiant : aucune condition à écrire.
    await session.client.addPushRule("global", PushRuleKind.RoomSpecific, roomId, {
      actions: [PushRuleActionName.DontNotify],
    });
  }
}
