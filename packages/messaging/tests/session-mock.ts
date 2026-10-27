import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import type { ICreateRoomOpts, IPushRules, MatrixEvent, PushRuleKind } from "matrix-js-sdk";
import { vi } from "vitest";

/** Un `MatrixEvent` réduit à ce que le package en lit. */
export function fakeEvent(
  id: string,
  content: Record<string, unknown>,
  sender = "@bob:tacita.test",
  type = "m.room.message",
) {
  return {
    getId: () => id,
    getType: () => type,
    getSender: () => sender,
    getContent: () => content,
    /**
     * `isRelation` fait partie du contrat de `MatrixEvent` que le package lit depuis le
     * 08/08/2026 : `messages()` écarte les `m.replace`, sans quoi un message modifié
     * s'affiche deux fois. Le faux le dérive du contenu, comme le SDK.
     */
    isRelation: (relType?: string) => {
      const relation = content["m.relates_to"] as { rel_type?: string } | undefined;
      return relType ? relation?.rel_type === relType : Boolean(relation?.rel_type);
    },
  };
}

export function fakeMember(userId: string, name: string, powerLevel = 0, typing = false) {
  return { userId, name, powerLevel, typing, roomId: "!salon:tacita.test" };
}

/** Une annotation telle que le SDK la rend dans les relations d'un événement. */
export interface FakeReaction {
  key: string;
  sender?: string;
  redacted?: boolean;
  /** Défaut : `$reaction-<rang>`. La bascule de redacte **par identifiant**. */
  id?: string;
}

export interface FakeRoomOptions {
  members?: ReturnType<typeof fakeMember>[];
  pinned?: string[];
  maySendEvent?: boolean;
  mayRedact?: boolean;
  /** Réactions portées par `$cible`, pour la lecture agrégée de. */
  reactions?: FakeReaction[];
  /** l'état initial de `m.ignored_user_list`. */
  ignored?: string[];
  /** ce que `getProfileInfo` rend. */
  profile?: { displayname?: string; avatar_url?: string } & Record<string, unknown>;
  /** ce que l'annuaire du homeserver rend. */
  annuaire?: { user_id: string; display_name?: string; avatar_url?: string }[];
  /** niveau exigé par l'état du salon pour l'action `kick`. */
  kickLevel?: number;
  /** L'invitant, quand le salon est une invitation de DM. */
  inviter?: string;
  /** la règle d'accès dans l'état du salon. `undefined` = aucun événement. */
  joinRule?: string;
  /** ceux qui ont frappé et attendent : jamais dans les membres joints. */
  knockers?: ReturnType<typeof fakeMember>[];
  /** les push rules du compte, telles que `/sync` les rend. */
  pushRules?: IPushRules;
}

/**
 * Session mockée (« suite Vitest avec Session mockée »). `sendEvent`
 * simule la déduplication par `txnId` du serveur : même transaction, même
 * `event_id`.
 */
export function fakeSession(options: FakeRoomOptions = {}) {
  const {
    members = [fakeMember("@bob:tacita.test", "bob", 100)],
    pinned = [],
    maySendEvent = true,
    mayRedact = true,
    reactions = [],
    profile = { displayname: "bob" },
    annuaire = [],
    kickLevel = 50,
    pushRules = { global: {} },
    joinRule,
    knockers = [],
  } = options;
  let ignored = options.ignored ?? [];

  const transactions = new Map<string, string>();
  let autoId = 0;

  const room = {
    roomId: "!salon:tacita.test",
    getJoinedMembers: () => members,
    // l'appartenance `knock` est une catégorie à part : quelqu'un qui a
    // frappé n'est pas joint, et un mock qui le rendrait dans `getJoinedMembers`
    // laisserait passer une lecture fausse.
    getMembersWithMembership: (membership: string) => (membership === "knock" ? knockers : []),
    // l'invitant d'une invitation de DM : `acceptInvitation` le lit avant
    // de rejoindre, pour inscrire le salon dans `m.direct`.
    getDMInviter: () => options.inviter,
    getJoinedMemberCount: () => members.length,
    getMembers: () => members,
    getMember: (userId: string) => members.find((member) => member.userId === userId) ?? null,
    // L'agrégation des annotations est celle du SDK : le mock rend ce qu'elle rendrait,
    // il ne la refait pas — sinon le test validerait notre propre regroupement.
    relations: {
      getChildEventsForEvent: vi.fn((_eventId: string, _relType: string, _type: string) => ({
        getRelations: () =>
          reactions.map(({ key, sender = "@bob:tacita.test", redacted = false, id }, rang) => ({
            ...fakeEvent(id ?? `$reaction-${rang}`, { "m.relates_to": { key } }, sender, "m.reaction"),
            isRedacted: () => redacted,
          })),
      })),
    },
    currentState: {
      getStateEvents: vi.fn((type: string, _stateKey: string) => {
        // `m.room.join_rules` absent quand le test n'en pose pas : c'est le cas qui doit
        // se lire « invite », et un mock qui rendrait toujours un objet le masquerait.
        if (type === "m.room.join_rules") {
          return joinRule === undefined ? null : { getContent: () => ({ join_rule: joinRule }) };
        }
        return { getContent: () => ({ pinned }) };
      }),
      maySendEvent: vi.fn(() => maySendEvent),
      maySendRedactionForEvent: vi.fn(() => mayRedact),
      // le seuil vient de l'état du salon, comme chez le SDK : le test
      // pilote le niveau exigé, jamais le résultat du prédicat.
      hasSufficientPowerLevelFor: vi.fn(
        (_action: string, powerLevel: number) => powerLevel >= kickLevel,
      ),
    },
  };

  const crypto = { isEncryptionEnabledInRoom: vi.fn(async (_roomId: string) => true) };

  const client = {
    getUserId: vi.fn(() => "@bob:tacita.test"),
    getCrypto: vi.fn(() => crypto),
    getRoom: vi.fn((_roomId: string): typeof room | null => room),
    sendEvent: vi.fn(
      async (_roomId: string, _type: string, _content: object, txnId?: string) => {
        const key = txnId ?? `auto-${autoId++}`;
        if (!transactions.has(key)) transactions.set(key, `$evt${transactions.size}`);
        return { event_id: transactions.get(key)! };
      },
    ),
    sendStateEvent: vi.fn(async () => ({ event_id: "$state" })),
    redactEvent: vi.fn(async () => ({ event_id: "$redaction" })),
    // Les paramètres portent la forme du vrai type : sans eux, `mock.calls` est typé
    // comme un tuple vide et les assertions sur les arguments ne compilent pas.
    sendTyping: vi.fn(async (_roomId: string, _isTyping: boolean, _timeoutMs: number) => ({})),
    createRoom: vi.fn(async (_opts: ICreateRoomOpts) => ({ room_id: "!nouveau:tacita.test" })),
    setPowerLevel: vi.fn(async (_roomId: string, _userId: string, _level: number) => ({
      event_id: "$pl",
    })),
    // Le modèle social de D-09. `ignored` est un état porté par le
    // mock et non un tableau figé : `ignoreUser` relit la liste avant d'écrire, et un
    // faux qui rendrait toujours la même chose ne prouverait pas cette relecture.
    joinRoom: vi.fn(async (roomId: string) => ({ roomId })),
    knockRoom: vi.fn(async (roomId: string) => ({ room_id: roomId })),
    leave: vi.fn(async (_roomId: string) => ({})),
    getIgnoredUsers: vi.fn((): string[] => ignored),
    setIgnoredUsers: vi.fn(async (userIds: string[]) => {
      ignored = userIds;
      return {};
    }),
    getProfileInfo: vi.fn(async (_userId: string) => profile),
    setDisplayName: vi.fn(async (_name: string) => ({})),
    setAvatarUrl: vi.fn(async (_url: string) => ({})),
    /** l'écriture d'un champ de profil étendu (MSC4133). */
    setExtendedProfileProperty: vi.fn(async (_key: string, _value: unknown) => {}),
    searchUserDirectory: vi.fn(async (_options: { term: string; limit?: number }) => ({
      results: annuaire,
      limited: false,
    })),
    kick: vi.fn(async (_roomId: string, _userId: string, _reason?: string) => ({})),
    invite: vi.fn(async (_roomId: string, _userId: string) => ({})),
    pushRules,
    addPushRule: vi.fn(
      async (_scope: string, _kind: PushRuleKind, _ruleId: string, _body: object) => ({}),
    ),
    deletePushRule: vi.fn(async (_scope: string, _kind: PushRuleKind, _ruleId: string) => ({})),
    on: vi.fn(),
    off: vi.fn(),
  };

  let timelineEvents: unknown[] = [];

  const session = {
    client,
    // le prédicat **dérive** du crypto comme dans la vraie Session, au
    // lieu de rendre `true` en dur : les tests qui simulent un salon non chiffré le
    // font en pilotant le crypto, et c'est ce couplage-là qu'ils doivent exercer.
    isEncrypted: vi.fn(async (roomId: string) => {
      try {
        return (await client.getCrypto()?.isEncryptionEnabledInRoom(roomId)) ?? false;
      } catch {
        return false;
      }
    }),
    // La conversion est ici, et nulle part ailleurs : les tests posent des faux
    // événements réduits à ce que `messages()` en lit, alors que le contrat rend des
    // `MatrixEvent`. C'est le `satisfies` ci-dessous qui a révélé l'écart — le mock
    // annonçait `unknown[]`, et personne ne le voyait.
    timeline: vi.fn((_roomId: string) => ({
      events: () => timelineEvents as MatrixEvent[],
      // la remontée d'historique appartient à `client-core` ; aucun test de
      // ce paquet ne la déclenche, mais le contrat l'exige, et un mock qui l'omettrait ne
      // compilerait pas (c'est le point du `satisfies`).
      paginate: vi.fn(async () => false),
    })),
    // Audit des jonctions — `satisfies` ancre les membres définis ici sur le vrai
    // contrat. Les membres absents sont complétés par `asSession`, qui les fait lever
    // au lieu de manquer. Le `client` reste un faux assumé.
  } satisfies { client: unknown } & Partial<Omit<Session, "client">>;

  return {
    session: asSession(session),
    client,
    crypto,
    room,
    setTimeline(events: unknown[]) {
      timelineEvents = events;
    },
  };
}
