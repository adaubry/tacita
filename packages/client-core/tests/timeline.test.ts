import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeEvent, fakeRoom, resetSdk, type ClientMock } from "./mocks";
import { initSession, type SessionConfig } from "../src";

vi.mock("matrix-js-sdk", async () => (await import("./mocks")).sdkModule());

const config: SessionConfig = {
  homeserverUrl: "https://tacita.test",
  identifiant: "alice",
  motDePasse: "motdepasse-essai",
  indexedDB: new IDBFactory(),
};

let client: ClientMock;

beforeEach(() => {
  ({ client } = resetSdk());
});

describe("OrderedTimeline restitue l'ordre du flux /sync", () => {
  it("conserve l'ordre d'accumulation même quand les timestamps sont dans le désordre", async () => {
    // Horodatages décroissants : un tri par `origin_server_ts` inverserait la liste.
    const sync = [fakeEvent("$a", 3000), fakeEvent("$b", 1000), fakeEvent("$c", 2000)];
    client.getRoom.mockReturnValue(fakeRoom(sync));

    const session = await initSession(config);
    const events = session.timeline("!salon:tacita.test").events();

    expect(events.map((e) => e.getId())).toEqual(["$a", "$b", "$c"]);
    expect(events).toEqual(sync);
  });

  it("relit la timeline vivante à chaque appel plutôt que de figer une copie", async () => {
    const session = await initSession(config);
    const timeline = session.timeline("!salon:tacita.test");

    client.getRoom.mockReturnValue(fakeRoom([fakeEvent("$a", 1000)]));
    expect(timeline.events()).toHaveLength(1);

    client.getRoom.mockReturnValue(fakeRoom([fakeEvent("$a", 1000), fakeEvent("$b", 500)]));
    expect(timeline.events().map((e) => e.getId())).toEqual(["$a", "$b"]);
  });

  it("rend une liste vide pour un salon inconnu du store", async () => {
    const session = await initSession(config);
    client.getRoom.mockReturnValue(null);
    expect(session.timeline("!inconnu:tacita.test").events()).toEqual([]);
  });
});

describe("la timeline remonte l'historique au serveur", () => {
  it("demande la page précédente au salon et signale qu'il en reste", async () => {
    const session = await initSession(config);
    const room = fakeRoom([fakeEvent("$a", 1000)]);
    client.getRoom.mockReturnValue(room);

    await expect(session.timeline("!salon:tacita.test").paginate()).resolves.toBe(true);
    expect(client.scrollback).toHaveBeenCalledWith(room, 50);
  });

  it("rend `false` quand le salon n'a plus de jeton de pagination", async () => {
    const session = await initSession(config);
    // `null` est le signal du SDK pour « début du salon atteint » : sans lui, l'UI
    // continuerait de demander une suite qui n'existe pas, à chaque défilement.
    client.getRoom.mockReturnValue(fakeRoom([fakeEvent("$a", 1000)], null));

    await expect(session.timeline("!salon:tacita.test").paginate()).resolves.toBe(false);
  });

  it("rend `false` sans aucun appel réseau pour un salon inconnu du store", async () => {
    const session = await initSession(config);
    client.getRoom.mockReturnValue(null);

    await expect(session.timeline("!inconnu:tacita.test").paginate()).resolves.toBe(false);
    expect(client.scrollback).not.toHaveBeenCalled();
  });

  it("rend visibles par `events()` les messages que la remontée a ramenés", async () => {
    const session = await initSession(config);
    const timeline = session.timeline("!salon:tacita.test");
    client.getRoom.mockReturnValue(fakeRoom([fakeEvent("$b", 2000)]));

    // Le SDK insère **en tête** : l'ordre rendu reste celui du flux, rien n'est trié.
    client.scrollback.mockImplementation(async () => {
      client.getRoom.mockReturnValue(fakeRoom([fakeEvent("$a", 1000), fakeEvent("$b", 2000)]));
    });

    await timeline.paginate();
    expect(timeline.events().map((event) => event.getId())).toEqual(["$a", "$b"]);
  });
});
