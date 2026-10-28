import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import type { MatrixEvent } from "matrix-js-sdk";
import { describe, expect, it, vi } from "vitest";

import {
  conversations,
  FAVOURITE_TAG,
  invitations,
  openDirectMessage,
  setFavourite,
  subscribeConversations,
} from "../src";
import { fakeEvent } from "./session-mock";

const MOI = "@bob:tacita.test";
const ALICE = "@alice:tacita.test";

interface SalonFictif {
  roomId: string;
  name: string;
  membership?: "join" | "invite" | "leave";
  /**
   * `msgtype` et `sender` sont optionnels, mais ils font partie du contrat depuis que
   * l'aperçu doit dire **quoi** et **de qui** : un doublon qui ne modèle pas ce que le
   * code appelle ne peut infirmer aucune hypothèse.
   */
  messages?: { texte: string; ts: number; msgtype?: string; sender?: string }[];
  /** Nom d'affichage par membre — l'aperçu nomme l'expéditeur, jamais le salon. */
  nomsMembres?: Record<string, string>;
  /**
   * Les membres du salon, avec leur appartenance. Le doublon doit les porter depuis que
   * `pairImplicite` reconnaît un tête-à-tête que `m.direct` ignore : sans eux, il ne peut
   * ni confirmer ni infirmer la règle.
   */
  membres?: { userId: string; membership?: "join" | "invite" | "leave" }[];
  /** Le salon porte un état `m.room.name` — c'est ce qui en fait un groupe. */
  nomme?: boolean;
  unread?: number;
  highlight?: number;
  tags?: string[];
  inviter?: string;
  /** `mxc://` du salon — en groupe, c'est lui que la liste affiche. */
  avatar?: string;
  /** `mxc://` par membre — en DM, c'est celui de l'autre que la liste affiche. */
  avatarsMembres?: Record<string, string>;
}

/**
 * Un client à plusieurs salons — ce que `session-mock` n'offre pas : il en tient un
 * seul, ce qui suffit aux quatre autres suites et pas à celle-ci. Le contrat `Session`
 * reste vérifié par `asSession`, seul site de compilation autorisé.
 */
function fakeClient(salons: SalonFictif[], directs: Record<string, string[]> = {}) {
  const rooms = salons.map((salon) => ({
    roomId: salon.roomId,
    name: salon.name,
    tags: Object.fromEntries((salon.tags ?? []).map((tag) => [tag, {}])),
    getMyMembership: () => salon.membership ?? "join",
    getDMInviter: () => salon.inviter,
    getUnreadNotificationCount: (type?: string) =>
      (type === "highlight" ? salon.highlight : salon.unread) ?? 0,
    /*
     * **Les deux méthodes d'avatar font partie du contrat** (30/08/2026, plainte : « la
     * photo de profil ne s'affiche pas dans l'accueil »). Le doublon ne les portait pas,
     * parce que `Conversation` ne portait pas encore `avatarUrl` — et un doublon qui ne
     * modèle pas ce que le code appelle ne peut infirmer aucune hypothèse (règle 3).
     */
    getMxcAvatarUrl: () => salon.avatar ?? null,
    getMember: (userId: string) => {
      const mxc = salon.avatarsMembres?.[userId];
      const nom = salon.nomsMembres?.[userId];
      if (mxc === undefined && nom === undefined) return null;
      return { getMxcAvatarUrl: () => mxc ?? null, name: nom };
    },
    getMembers: () =>
      (salon.membres ?? []).map(({ userId, membership }) => ({
        userId,
        membership: membership ?? "join",
      })),
    // Seul `m.room.name` est interrogé : un salon « nommé » est un groupe, et c'est la
    // seule chose que `pairImplicite` lit de l'état.
    currentState: {
      getStateEvents: (type: string) =>
        type === "m.room.name" && salon.nomme ? { getContent: () => ({ name: salon.name }) } : null,
    },
  }));

  const client = {
    getUserId: vi.fn(() => MOI),
    getRooms: vi.fn(() => rooms),
    getRoom: vi.fn((roomId: string) => rooms.find((room) => room.roomId === roomId) ?? null),
    getAccountData: vi.fn((type: string) =>
      type === "m.direct" ? { getContent: () => directs } : undefined,
    ),
    setRoomTag: vi.fn(async (_roomId: string, _tag: string, _metadata: object) => ({})),
    deleteRoomTag: vi.fn(async (_roomId: string, _tag: string) => ({})),
    createRoom: vi.fn(async () => ({ room_id: "!neuf:tacita.test" })),
    // `m.direct` s'écrit vraiment : le mock le conserve, pour que la
    // relecture voie ce que l'écriture a posé.
    setAccountData: vi.fn(async (type: string, contenu: Record<string, string[]>) => {
      if (type === "m.direct") Object.assign(directs, contenu);
      return {};
    }),
    isEncrypted: vi.fn(async () => true),
    on: vi.fn(),
    off: vi.fn(),
  };

  const session = asSession({
    client,
    isEncrypted: async () => true,
    timeline: (roomId: string) => ({
      events: () =>
        (salons.find((salon) => salon.roomId === roomId)?.messages ?? []).map(
          ({ texte, ts, msgtype, sender }) =>
            ({
              ...fakeEvent("$e", { body: texte, msgtype: msgtype ?? "m.text" }, sender ?? ALICE),
              getTs: () => ts,
            }) as unknown as MatrixEvent,
        ),
      paginate: async () => false,
    }),
  } as unknown as { client: unknown } & Partial<Omit<Session, "client">>);

  return { session, client };
}

describe("liste des conversations, compteurs natifs, invitations à part", () => {
  it("rend les salons rejoints, le plus récent d'abord, avec aperçu et horodatage", () => {
    const { session } = fakeClient([
      { roomId: "!vieux:t", name: "vieux", messages: [{ texte: "salut", ts: 1000 }] },
      { roomId: "!neuf:t", name: "neuf", messages: [{ texte: "coucou", ts: 5000 }] },
    ]);

    expect(conversations(session).map((c) => [c.roomId, c.preview, c.timestamp])).toEqual([
      ["!neuf:t", "coucou", 5000],
      ["!vieux:t", "salut", 1000],
    ]);
  });

  /**
   * **De quoi nommer une pièce jointe au lieu d'afficher son fichier.** L'accueil rendait
   * le `body` tel quel, et le `body` d'un vocal est `vocal-1793145337523.webm` : ça ne dit
   * ni ce que c'est, ni dans quel sens ça va. Le paquet rend les **faits** — le type, la
   * direction, le nom de l'expéditeur — et la phrase reste au shard.
   */
  it("l'aperçu porte le type du dernier message, sa direction et son auteur", () => {
    const { session } = fakeClient([
      {
        roomId: "!dm:t",
        name: "alice",
        nomsMembres: { [ALICE]: "alice" },
        messages: [{ texte: "vocal-179.webm", ts: 1000, msgtype: "m.audio" }],
      },
      {
        roomId: "!moi:t",
        name: "groupe",
        nomsMembres: { [MOI]: "bob" },
        messages: [{ texte: "IMG_4417.HEIC", ts: 2000, msgtype: "m.image", sender: MOI }],
      },
    ]);

    const [mien, delle] = conversations(session);

    expect(delle).toMatchObject({
      previewMsgtype: "m.audio",
      previewDeMoi: false,
      previewAuteur: "alice",
    });
    expect(mien).toMatchObject({ previewMsgtype: "m.image", previewDeMoi: true, previewAuteur: "bob" });
  });

  /**
   * **Un salon à deux que `m.direct` ignore reste un tête-à-tête.** Signalé sur trois
   * écrans à la fois : initiales au lieu de la photo du correspondant, absence de la
   * liste d'amis — donc impossible de l'ajouter à un groupe —, et un écran
   * d'informations annonçant « 2 membres » avec le bouton « Ajouter ». `m.direct` ne
   * décrit que les salons que cette application a ouverts ou acceptés ; rien ne repasse
   * derrière pour les autres.
   */
  it("un salon à deux sans nom est un tête-à-tête, même absent de `m.direct`", () => {
    const { session } = fakeClient([
      {
        roomId: "!orphelin:t",
        name: "alice",
        membres: [{ userId: MOI }, { userId: ALICE }],
      },
    ]);

    const [salon] = conversations(session);
    expect(salon).toMatchObject({ direct: true, peerId: ALICE });
  });

  it("une invitation en attente compte : un DM ne devient pas un groupe le temps d'une réponse", () => {
    const { session } = fakeClient([
      {
        roomId: "!invite:t",
        name: "alice",
        membres: [{ userId: MOI }, { userId: ALICE, membership: "invite" }],
      },
    ]);
    expect(conversations(session)[0]).toMatchObject({ direct: true, peerId: ALICE });
  });

  /**
   * Le garde-fou de la règle : un groupe de deux personnes existe, et l'appeler
   * tête-à-tête serait faux. Dans cette application un groupe porte toujours un nom —
   * `createGroupChat` en pose un, et la feuille de création refuse de partir sans.
   */
  it("un salon à deux **nommé** reste un groupe", () => {
    const { session } = fakeClient([
      {
        roomId: "!duo:t",
        name: "Équipe",
        nomme: true,
        membres: [{ userId: MOI }, { userId: ALICE }],
      },
    ]);
    expect(conversations(session)[0]).toMatchObject({ direct: false, peerId: undefined });
  });

  it("à trois, ce n'est plus un tête-à-tête", () => {
    const { session } = fakeClient([
      {
        roomId: "!trois:t",
        name: "trois",
        membres: [{ userId: MOI }, { userId: ALICE }, { userId: "@carol:t" }],
      },
    ]);
    expect(conversations(session)[0]!.direct).toBe(false);
  });

  it("un message texte ne porte aucun type : c'est le cas par défaut", () => {
    const { session } = fakeClient([
      { roomId: "!a:t", name: "a", messages: [{ texte: "coucou", ts: 1000 }] },
    ]);
    // `undefined` et non `"m.text"` : le rendre explicite obligerait chaque lecteur à le
    // réécarter, et le `body` d'un texte est déjà le bon aperçu.
    expect(conversations(session)[0]!.previewMsgtype).toBeUndefined();
  });

  it("relaie les compteurs natifs tels quels, mention comprise", () => {
    const { session } = fakeClient([
      { roomId: "!a:t", name: "a", unread: 12, highlight: 1 },
      { roomId: "!b:t", name: "b", unread: 3 },
    ]);

    const [a, b] = conversations(session);
    expect([a!.unread, a!.mention]).toEqual([12, true]);
    expect([b!.unread, b!.mention]).toEqual([3, false]);
  });

  it("distingue DM et groupe par `m.direct`, et expose l'autre membre", () => {
    const { session } = fakeClient(
      [
        { roomId: "!dm:t", name: "alice" },
        { roomId: "!groupe:t", name: "équipe" },
      ],
      { [ALICE]: ["!dm:t"] },
    );

    const [dm, groupe] = conversations(session).sort((x, y) => x.roomId.localeCompare(y.roomId));
    expect([dm!.direct, dm!.peerId]).toEqual([true, ALICE]);
    expect([groupe!.direct, groupe!.peerId]).toEqual([false, undefined]);
  });

  it("un salon invité n'est pas dans la liste : il est dans les invitations", () => {
    const { session } = fakeClient([
      { roomId: "!joint:t", name: "joint" },
      { roomId: "!invite:t", name: "alice", membership: "invite", inviter: ALICE },
      { roomId: "!parti:t", name: "parti", membership: "leave" },
    ]);

    expect(conversations(session).map((c) => c.roomId)).toEqual(["!joint:t"]);
    expect(invitations(session)).toEqual([{ roomId: "!invite:t", name: "alice", from: ALICE }]);
  });

  /**
   * `Room` — l'**apparition** d'un salon — a manqué jusqu'au 07/08/2026, et le défaut
   * n'était visible qu'avec deux navigateurs contre un vrai Synapse : une demande d'ami
   * n'apparaissait chez l'invité qu'après rechargement complet de la page. Le serveur la
   * livrait bien ; rien dans l'app ne disait de relire. Un salon invité est **nouveau**
   * côté client, donc aucun de ses propres événements n'a pu être réémis à temps.
   */
  it("l'abonnement couvre les cinq sources de changement, et se défait", () => {
    const { session, client } = fakeClient([]);
    const desabonner = subscribeConversations(session, () => {});

    expect(client.on.mock.calls.map(([evenement]) => evenement)).toEqual([
      "Room",
      "Room.timeline",
      "Room.tags",
      "Room.receipt",
      "Room.myMembership",
    ]);

    desabonner();
    // Symétrie stricte : un abonnement non retiré fuit à chaque changement d'écran.
    expect(client.off.mock.calls.map(([evenement]) => evenement)).toEqual(
      client.on.mock.calls.map(([evenement]) => evenement),
    );
  });
});

describe("épingle par le tag natif m.favourite", () => {
  it("épingler pose le tag, désépingler le retire", async () => {
    const { session, client } = fakeClient([{ roomId: "!a:t", name: "a" }]);

    await setFavourite(session, "!a:t", true);
    expect(client.setRoomTag).toHaveBeenCalledWith("!a:t", FAVOURITE_TAG, {});

    await setFavourite(session, "!a:t", false);
    expect(client.deleteRoomTag).toHaveBeenCalledWith("!a:t", FAVOURITE_TAG);
  });

  it("le tag posé se relit sur la conversation", () => {
    const { session } = fakeClient([{ roomId: "!a:t", name: "a", tags: [FAVOURITE_TAG] }]);
    expect(conversations(session)[0]!.pinned).toBe(true);
  });
});

describe("un seul DM par correspondant", () => {
  it("réutilise le DM existant sans créer de salon", async () => {
    const { session, client } = fakeClient([{ roomId: "!dm:t", name: "alice" }], {
      [ALICE]: ["!dm:t"],
    });

    expect(await openDirectMessage(session, ALICE)).toBe("!dm:t");
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it("un DM quitté ne compte pas : un nouveau est créé", async () => {
    const { session, client } = fakeClient(
      [{ roomId: "!parti:t", name: "alice", membership: "leave" }],
      { [ALICE]: ["!parti:t"] },
    );

    expect(await openDirectMessage(session, ALICE)).toBe("!neuf:tacita.test");
    expect(client.createRoom).toHaveBeenCalledTimes(1);
  });
});

describe("un DM est inscrit dans m.direct, sinon il n'en est un pour personne", () => {
  /**
   * Mesuré avec deux navigateurs contre un vrai Synapse : un DM créé par
   * l'app s'affichait « 2 membres, c'est le début de ce groupe ». `is_direct` ne pose le
   * drapeau que dans l'invitation ; ni le serveur ni le SDK n'écrivent l'account data.
   */
  it("créer un DM l'inscrit, et un second appel ne recrée rien", async () => {
    const { session, client } = fakeClient([]);

    const premier = await openDirectMessage(session, ALICE);
    expect(client.setAccountData).toHaveBeenCalledWith("m.direct", { [ALICE]: [premier] });

    // Le salon existe maintenant côté client : le second appel doit le retrouver.
    const salon = { roomId: premier, name: "alice", tags: {}, getMyMembership: () => "join" };
    client.getRooms.mockReturnValue([salon] as never);
    client.getRoom.mockReturnValue(salon as never);
    client.createRoom.mockClear();

    expect(await openDirectMessage(session, ALICE)).toBe(premier);
    // « Jamais un second » : sans `m.direct`, cette ligne échouait et un salon de plus
    // était créé à chaque ouverture de conversation.
    expect(client.createRoom).not.toHaveBeenCalled();
  });

  it("n'écrase pas les autres correspondants déjà inscrits", async () => {
    const { session, client } = fakeClient([], { "@mira:tacita.test": ["!mira:t"] });
    await openDirectMessage(session, ALICE);

    const [, contenu] = client.setAccountData.mock.calls.at(-1)!;
    expect(contenu).toEqual({ "@mira:tacita.test": ["!mira:t"], [ALICE]: ["!neuf:tacita.test"] });
  });
});
