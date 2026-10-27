import { readFileSync } from "node:fs";
import { PushRuleActionName, type IPushRule } from "matrix-js-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import {
  canKick,
  createDirectMessage,
  createGroupChat,
  getPinnedEvents,
  invite,
  joinRule,
  kick,
  knock,
  knockers,
  memberCount,
  members,
  PINNED_EVENTS_METADATA,
  powerLevelOf,
  roomNotificationLevel,
  setJoinRule,
  setPinnedEvents,
  setPowerLevel,
  setRoomNotificationLevel,
} from "../src";
import { fakeMember, fakeSession } from "./session-mock";

const ROOM = "!salon:tacita.test";

let ctx: ReturnType<typeof fakeSession>;

beforeEach(() => {
  ctx = fakeSession({
    members: [fakeMember("@bob:tacita.test", "bob", 100), fakeMember("@alice:tacita.test", "alice")],
    pinned: ["$epingle"],
  });
});

describe("DM et groupes, chiffrés dès la création", () => {
  it("un DM est un salon à 2 marqué is_direct et chiffré à la création", async () => {
    await createDirectMessage(ctx.session, "@alice:tacita.test");
    const [opts] = ctx.client.createRoom.mock.calls[0]!;
    expect(opts).toMatchObject({ is_direct: true, invite: ["@alice:tacita.test"] });
    expect(opts.initial_state).toEqual([
      { type: "m.room.encryption", state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
    ]);
  });

  it("un groupe est chiffré à la création lui aussi", async () => {
    await createGroupChat(ctx.session, "équipe", ["@alice:tacita.test"]);
    const [opts] = ctx.client.createRoom.mock.calls[0]!;
    expect(opts).toMatchObject({ name: "équipe", invite: ["@alice:tacita.test"] });
    expect(opts.initial_state?.[0]?.type).toBe("m.room.encryption");
    expect(opts.is_direct).toBeUndefined();
  });

  it("la vérification client refuse toute écriture dans un salon non chiffré", async () => {
    ctx.crypto.isEncryptionEnabledInRoom.mockResolvedValue(false);
    await expect(setPinnedEvents(ctx.session, ROOM, ["$a"])).rejects.toThrow(/non chiffré/);
    expect(ctx.client.sendStateEvent).not.toHaveBeenCalled();
  });

  it("un client sans crypto ne peut rien écrire non plus", async () => {
    ctx.client.getCrypto.mockReturnValue(undefined as never);
    await expect(setPinnedEvents(ctx.session, ROOM, ["$a"])).rejects.toThrow(/non chiffré/);
  });
});

describe("épinglage via m.room.pinned_events, état non chiffré", () => {
  it("écrit la liste dans l'événement d'état", async () => {
    await setPinnedEvents(ctx.session, ROOM, ["$a", "$b"]);
    expect(ctx.client.sendStateEvent).toHaveBeenCalledWith(
      ROOM,
      "m.room.pinned_events",
      { pinned: ["$a", "$b"] },
      "",
    );
  });

  it("relit la liste épinglée depuis l'état du salon", () => {
    expect(getPinnedEvents(ctx.session, ROOM)).toEqual(["$epingle"]);
  });

  it("expose cleartext: true et le documente", () => {
    expect(PINNED_EVENTS_METADATA.cleartext).toBe(true);
    expect(PINNED_EVENTS_METADATA.reason).toMatch(/état/i);
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    expect(readme).toMatch(/pinned_events/);
  });
});

describe("power levels numériques, aucun rôle nommé", () => {
  it("lit le power level d'un membre tel quel", () => {
    expect(powerLevelOf(ctx.session, ROOM, "@bob:tacita.test")).toBe(100);
    expect(powerLevelOf(ctx.session, ROOM, "@alice:tacita.test")).toBe(0);
    expect(powerLevelOf(ctx.session, ROOM, "@inconnu:tacita.test")).toBe(0);
  });

  it("écrit un power level via le SDK", async () => {
    await setPowerLevel(ctx.session, ROOM, "@alice:tacita.test", 50);
    expect(ctx.client.setPowerLevel).toHaveBeenCalledWith(ROOM, "@alice:tacita.test", 50);
  });

  it("expose le compteur de membres du salon", () => {
    expect(memberCount(ctx.session, ROOM)).toBe(2);
  });

  it("aucune échelle de rôles nommés n'est introduite", () => {
    const source = readFileSync(new URL("../src/rooms.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/\b(moderator|modérateur|administrateur|OWNER|ROLES?)\b/i);
  });

  it("expose la liste des membres rejoints", () => {
    expect(members(ctx.session, ROOM).map((membre) => membre.userId)).toEqual([
      "@bob:tacita.test",
      "@alice:tacita.test",
    ]);
  });

  it("le droit d'exclure exige le niveau requis **et** d'être au-dessus de la cible", () => {
    // @bob est à 100, le seuil `kick` du salon à 50, @alice à 0.
    expect(canKick(ctx.session, ROOM, "@alice:tacita.test")).toBe(true);
  });

  it("à égalité de power level, Matrix refuse — le prédicat aussi", () => {
    ctx = fakeSession({
      members: [
        fakeMember("@bob:tacita.test", "bob", 100),
        fakeMember("@alice:tacita.test", "alice", 100),
      ],
    });
    expect(canKick(ctx.session, ROOM, "@alice:tacita.test")).toBe(false);
  });

  it("sous le seuil du salon, aucun droit — même sur quelqu'un de plus bas", () => {
    ctx = fakeSession({
      members: [
        fakeMember("@bob:tacita.test", "bob", 10),
        fakeMember("@alice:tacita.test", "alice", 0),
      ],
      kickLevel: 50,
    });
    expect(canKick(ctx.session, ROOM, "@alice:tacita.test")).toBe(false);
  });

  it("s'exclure soi-même n'est pas un kick", () => {
    expect(canKick(ctx.session, ROOM, "@bob:tacita.test")).toBe(false);
  });

  it("l'exclusion et l'invitation passent par le SDK, sans détour", async () => {
    await kick(ctx.session, ROOM, "@alice:tacita.test");
    expect(ctx.client.kick).toHaveBeenCalledWith(ROOM, "@alice:tacita.test", undefined);

    await invite(ctx.session, ROOM, "@mira:tacita.test");
    expect(ctx.client.invite).toHaveBeenCalledWith(ROOM, "@mira:tacita.test");
  });
});

describe("trois niveaux de notification, en push rules natives", () => {
  /** Une règle telle que `/sync` la rend : muette si ses actions ne notifient pas. */
  const regle = (ruleId: string, notifie: boolean): IPushRule => ({
    rule_id: ruleId,
    actions: [notifie ? PushRuleActionName.Notify : PushRuleActionName.DontNotify],
    default: false,
    enabled: true,
  });

  it("sans règle, le salon notifie tout", () => {
    expect(roomNotificationLevel(ctx.session, ROOM)).toBe("all");
  });

  it("une règle `room` muette se lit « mentions uniquement »", () => {
    ctx = fakeSession({ pushRules: { global: { room: [regle(ROOM, false)] } } });
    expect(roomNotificationLevel(ctx.session, ROOM)).toBe("mentions");
  });

  it("une règle `override` muette l'emporte : le salon est silencieux", () => {
    ctx = fakeSession({
      pushRules: { global: { override: [regle(ROOM, false)], room: [regle(ROOM, false)] } },
    });
    expect(roomNotificationLevel(ctx.session, ROOM)).toBe("mute");
  });

  it("une règle qui notifie n'est pas une règle de silence", () => {
    ctx = fakeSession({ pushRules: { global: { room: [regle(ROOM, true)] } } });
    expect(roomNotificationLevel(ctx.session, ROOM)).toBe("all");
  });

  it("la règle d'un autre salon ne dit rien de celui-ci", () => {
    ctx = fakeSession({ pushRules: { global: { room: [regle("!autre:tacita.test", false)] } } });
    expect(roomNotificationLevel(ctx.session, ROOM)).toBe("all");
  });

  it("« mentions uniquement » écrit une règle de genre room, sans condition", async () => {
    await setRoomNotificationLevel(ctx.session, ROOM, "mentions");
    expect(ctx.client.addPushRule).toHaveBeenCalledWith("global", "room", ROOM, {
      actions: ["dont_notify"],
    });
  });

  it("« silencieux » écrit un override sur le room_id : les mentions s'éteignent aussi", async () => {
    await setRoomNotificationLevel(ctx.session, ROOM, "mute");
    expect(ctx.client.addPushRule).toHaveBeenCalledWith("global", "override", ROOM, {
      conditions: [{ kind: "event_match", key: "room_id", pattern: ROOM }],
      actions: ["dont_notify"],
    });
  });

  it("« tout » retire la règle existante et n'en écrit aucune", async () => {
    ctx = fakeSession({ pushRules: { global: { room: [regle(ROOM, false)] } } });
    await setRoomNotificationLevel(ctx.session, ROOM, "all");

    expect(ctx.client.deletePushRule).toHaveBeenCalledWith("global", "room", ROOM);
    expect(ctx.client.addPushRule).not.toHaveBeenCalled();
  });

  it("changer de niveau ne laisse jamais deux règles côte à côte", async () => {
    ctx = fakeSession({ pushRules: { global: { override: [regle(ROOM, false)] } } });
    await setRoomNotificationLevel(ctx.session, ROOM, "mentions");

    expect(ctx.client.deletePushRule).toHaveBeenCalledWith("global", "override", ROOM);
    expect(ctx.client.addPushRule).toHaveBeenCalledTimes(1);
  });

  it("aucune règle absente n'est supprimée — pas de 404 provoqué", async () => {
    await setRoomNotificationLevel(ctx.session, ROOM, "mute");
    expect(ctx.client.deletePushRule).not.toHaveBeenCalled();
  });
});

describe("le sas d'entrée : knock, et l'invitation native qui le clôt", () => {
  it("un salon sans règle d'accès lisible compte comme `invite` : dans le doute, fermé", () => {
    // Le cas réel : `Preset.PrivateChat` n'écrit pas toujours l'événement, et l'état
    // n'est pas encore là avant le premier /sync. Lire « knock » par défaut ouvrirait un
    // groupe privé sur une absence de donnée.
    expect(joinRule(fakeSession({}).session, ROOM)).toBe("invite");
    expect(joinRule(fakeSession({ joinRule: "invite" }).session, ROOM)).toBe("invite");
    expect(joinRule(fakeSession({ joinRule: "public" }).session, ROOM)).toBe("invite");
  });

  it("reconnaît le sas quand il est ouvert", () => {
    expect(joinRule(fakeSession({ joinRule: "knock" }).session, ROOM)).toBe("knock");
  });

  it("la bascule s'écrit dans l'état du salon, avec la valeur que Matrix attend", async () => {
    await setJoinRule(ctx.session, ROOM, "knock");
    expect(ctx.client.sendStateEvent).toHaveBeenCalledWith(
      ROOM,
      "m.room.join_rules",
      { join_rule: "knock" },
      "",
    );

    await setJoinRule(ctx.session, ROOM, "invite");
    expect(ctx.client.sendStateEvent).toHaveBeenLastCalledWith(
      ROOM,
      "m.room.join_rules",
      { join_rule: "invite" },
      "",
    );
  });

  it("frapper n'envoie aucun motif : l'état de salon n'est jamais chiffré", async () => {
    await knock(ctx.session, ROOM);
    expect(ctx.client.knockRoom).toHaveBeenCalledWith(ROOM);
    // Un `reason` partirait en clair. Se présenter se fait dans le salon, une fois entré.
    expect(ctx.client.knockRoom.mock.calls[0]).toEqual([ROOM]);
  });

  it("ceux qui attendent se lisent dans l'appartenance knock, pas dans les membres", () => {
    const attente = fakeMember("@mira:tacita.test", "mira");
    const avecKnock = fakeSession({
      members: [fakeMember("@bob:tacita.test", "bob", 100)],
      knockers: [attente],
    });

    expect(knockers(avecKnock.session, ROOM).map((m) => m.userId)).toEqual(["@mira:tacita.test"]);
    // Et surtout : ils ne sont pas comptés comme membres du groupe.
    expect(members(avecKnock.session, ROOM).map((m) => m.userId)).toEqual(["@bob:tacita.test"]);
    expect(memberCount(avecKnock.session, ROOM)).toBe(1);
  });

  it("accepter est une invitation native, pas un mécanisme de plus", async () => {
    // E-13 : c'est tout l'intérêt de la voie A — le sas se referme par le chemin de
    // D-09 déjà éprouvé, aucun état parallèle à tenir.
    await invite(ctx.session, ROOM, "@mira:tacita.test");
    expect(ctx.client.invite).toHaveBeenCalledWith(ROOM, "@mira:tacita.test");
  });

  it("un groupe créé n'est pas en knock : la bascule suit les liens, pas la création", async () => {
    await createGroupChat(ctx.session, "équipe");
    const [opts] = ctx.client.createRoom.mock.calls[0]!;
    // `@tacita/messaging` « inchangée par défaut » : pas de knock permanent
    // sur tous les groupes.
    expect(JSON.stringify(opts)).not.toContain("knock");
  });
});
