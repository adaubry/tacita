import type { Session } from "@tacita/client-core";

import { members } from "./rooms";

/** Syntaxe saisie par l'utilisateur (façon Discord). */
export const EVERYONE = "@everyone";
/** Ce que Matrix comprend : déclenche la push rule native `.m.rule.roomnotif`. */
export const ROOM_MENTION = "@room";

export interface MentionCandidate {
  /** `@room`, ou un identifiant Matrix complet. */
  id: string;
  /** Ce que l'utilisateur tape après `@`. */
  label: string;
}

export interface MentionContent {
  body: string;
  "m.mentions": { room?: true; user_ids?: string[] };
}

/** données d'autocomplétion : `@everyone` puis les membres du salon. */
export function mentionCandidates(session: Session, roomId: string): MentionCandidate[] {
  return [
    { id: ROOM_MENTION, label: "everyone" },
    ...members(session, roomId).map((member) => ({ id: member.userId, label: member.name })),
  ];
}

/** `@everyone` est un littéral sans métacaractère : construit une fois, jamais échappé. */
const EVERYONE_RE = new RegExp(`${EVERYONE}\\b`, "g");

/**
 * Les libellés viennent du serveur (noms d'affichage) : sans échappement, un pseudo
 * `a.*` deviendrait un joker qui mentionnerait tout le salon.
 */
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `@everyone` est réécrit en `@room` dans le corps : c'est ce littéral
 * que `.m.rule.roomnotif` cherche. `m.mentions.room` est posé en parallèle pour la
 * règle `.m.rule.is_room_mention` des serveurs récents. Le rendu inverse (`@room`
 * réaffiché en `@everyone`) est à l'UI.
 *
 * Limite assumée : seuls les libellés sans espace sont résolus (`@bob`, pas
 * `@Jean Dupont`) — un pseudo à espaces reste du texte. Voir README.md.
 */
export function parseMentions(
  text: string,
  candidates: MentionCandidate[] = [],
): MentionContent {
  const body = text.replace(EVERYONE_RE, ROOM_MENTION);
  const mentions: MentionContent["m.mentions"] = {};

  if (body !== text) mentions.room = true;

  const userIds = candidates
    .filter((candidate) => candidate.id !== ROOM_MENTION && !/\s/.test(candidate.label))
    .filter(({ id, label }) =>
      [label, id].some((needle) => new RegExp(`@${escape(needle.replace(/^@/, ""))}\\b`).test(body)),
    )
    .map((candidate) => candidate.id);

  if (userIds.length > 0) mentions.user_ids = [...new Set(userIds)];

  return { body, "m.mentions": mentions };
}
