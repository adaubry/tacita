import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTypingIndicator,
  IDLE_STOP_MS,
  SERVER_TIMEOUT_MS,
  subscribeTyping,
  THROTTLE_MS,
  typingUsers,
} from "../src";
import { fakeMember, fakeSession } from "./session-mock";

const ROOM = "!salon:tacita.test";

let ctx: ReturnType<typeof fakeSession>;

beforeEach(() => {
  vi.useFakeTimers();
  ctx = fakeSession();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("m.typing éphémère, throttlé, avec arrêt automatique", () => {
  it("20 frappes en 1 s ne produisent qu'une seule émission", () => {
    const typing = createTypingIndicator(ctx.session);
    for (let i = 0; i < 20; i++) {
      typing.keystroke(ROOM);
      vi.advanceTimersByTime(50);
    }
    expect(ctx.client.sendTyping).toHaveBeenCalledOnce();
    expect(ctx.client.sendTyping).toHaveBeenCalledWith(ROOM, true, SERVER_TIMEOUT_MS);
    typing.dispose();
  });

  it("réémet une fois la fenêtre de throttle écoulée", () => {
    const typing = createTypingIndicator(ctx.session);
    typing.keystroke(ROOM);
    vi.advanceTimersByTime(THROTTLE_MS);
    typing.keystroke(ROOM);
    expect(ctx.client.sendTyping.mock.calls.filter((call) => call[1] === true)).toHaveLength(2);
    typing.dispose();
  });

  it("le timeout serveur dépasse la fenêtre de throttle, sinon l'indicateur clignote", () => {
    expect(SERVER_TIMEOUT_MS).toBeGreaterThan(THROTTLE_MS);
  });

  it("s'arrête tout seul après une inactivité", () => {
    const typing = createTypingIndicator(ctx.session);
    typing.keystroke(ROOM);
    ctx.client.sendTyping.mockClear();

    vi.advanceTimersByTime(IDLE_STOP_MS);
    expect(ctx.client.sendTyping).toHaveBeenCalledWith(ROOM, false, 0);
    typing.dispose();
  });

  it("chaque frappe repousse l'arrêt automatique", () => {
    const typing = createTypingIndicator(ctx.session);
    typing.keystroke(ROOM);
    ctx.client.sendTyping.mockClear();

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(IDLE_STOP_MS - 100);
      typing.keystroke(ROOM);
    }
    expect(ctx.client.sendTyping).not.toHaveBeenCalledWith(ROOM, false, 0);
    typing.dispose();
  });

  it("l'arrêt explicite émet une fois et annule le différé", () => {
    const typing = createTypingIndicator(ctx.session);
    typing.keystroke(ROOM);
    ctx.client.sendTyping.mockClear();

    typing.stop(ROOM);
    vi.advanceTimersByTime(IDLE_STOP_MS * 2);
    expect(ctx.client.sendTyping).toHaveBeenCalledExactlyOnceWith(ROOM, false, 0);
  });

  it("dispose annule les arrêts en attente sans laisser de timer", () => {
    const typing = createTypingIndicator(ctx.session);
    typing.keystroke(ROOM);
    typing.dispose();
    ctx.client.sendTyping.mockClear();

    vi.advanceTimersByTime(IDLE_STOP_MS * 2);
    expect(ctx.client.sendTyping).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("les salons sont throttlés indépendamment", () => {
    const typing = createTypingIndicator(ctx.session);
    typing.keystroke(ROOM);
    typing.keystroke("!autre:tacita.test");
    expect(ctx.client.sendTyping).toHaveBeenCalledTimes(2);
    typing.dispose();
  });
});

describe("lecture : qui écrit, et le signal qui le dit", () => {
  it("rend ceux qui écrivent, et jamais soi-même", () => {
    const salon = fakeSession({
      members: [
        fakeMember("@bob:tacita.test", "bob", 100, true),
        fakeMember("@alice:tacita.test", "alice", 0, true),
        fakeMember("@zoe:tacita.test", "zoé"),
      ],
    });

    // `@bob` est l'utilisateur courant du mock : se voir soi-même « en train
    // d'écrire » serait un indicateur qui décrit sa propre frappe.
    expect(typingUsers(salon.session, ROOM)).toEqual(["@alice:tacita.test"]);
  });

  it("personne n'écrit : une liste vide, pas une absence", () => {
    expect(typingUsers(fakeSession().session, ROOM)).toEqual([]);
  });

  it("l'abonnement ne réveille que pour son propre salon, et se défait", () => {
    const prevenu = vi.fn();
    const desabonner = subscribeTyping(ctx.session, ROOM, prevenu);

    const [, handler] = ctx.client.on.mock.calls.at(-1)!;
    (handler as (event: unknown, member: { roomId: string }) => void)({}, { roomId: ROOM });
    (handler as (event: unknown, member: { roomId: string }) => void)(
      {},
      { roomId: "!autre:tacita.test" },
    );
    expect(prevenu).toHaveBeenCalledTimes(1);

    desabonner();
    expect(ctx.client.off).toHaveBeenCalledWith("RoomMember.typing", handler);
  });
});
