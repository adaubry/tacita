import { readFileSync } from "node:fs";

import { IDBFactory } from "fake-indexeddb";
import { MatrixEventEvent, RoomEvent } from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUFFER_MS, createSearch, ROOM_MENTION, type Search } from "../src";
// Moteur et worker s'importent par leur module : le point d'entrée principal ne
// les réexporte pas, sinon Orama atterrirait dans le bundle du thread principal.
import { createEngine } from "../src/engine";
import { serve } from "../src/worker";
import { fakeSession, fakeWorker, matrixEvent, packageCode, redactionOf } from "./session-mock";

const ROOM = "!salon:tacita.test";

/** Un événement prêt pour l'index, tel que le produirait `indexable()`. */
const doc = (eventId: string, body: string, tsOrigin = 1) => ({
  eventId,
  roomId: ROOM,
  sender: "@bob:tacita.test",
  tsOrigin,
  body,
  msgtype: "m.text",
  mentions: [],
});

let ctx: ReturnType<typeof fakeSession>;
let worker: ReturnType<typeof fakeWorker>;
let search: Search;

beforeEach(async () => {
  ctx = fakeSession();
  // Le worker « fictif » relaie vers le vrai module worker : c'est le protocole
  // qu'on teste, pas l'API Worker du navigateur.
  worker = fakeWorker();
  serve(worker.inside, createEngine({ indexedDB: new IDBFactory() }));
  search = createSearch(ctx.session, worker.outside);
});

afterEach(() => {
  search.dispose();
  vi.useRealTimers();
});

describe("indexation et requêtes déportées dans le worker", () => {
  it("index et search passent par des messages, pas par un appel direct", async () => {
    await search.index(doc("$e1", "rendez-vous au parc"));

    expect(worker.posted.map((message) => message.method)).toEqual(["index"]);
    expect((await search.search("parc")).map((hit) => hit.eventId)).toEqual(["$e1"]);
  });

  it("un événement déchiffré alimente l'index sans que l'appelant s'en occupe", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "réunion demain"));
    ctx.emitDecrypted(matrixEvent("$e2", ROOM, "réunion annulée"));
    expect(worker.posted).toHaveLength(0); // rien n'est parti pendant la rafale

    await vi.advanceTimersByTimeAsync(BUFFER_MS);
    vi.useRealTimers();
    await vi.waitFor(async () => expect(await search.stats()).toMatchObject({ size: 2 }));

    // un seul message pour les deux événements de la rafale.
    expect(worker.posted.filter((message) => message.method === "index")).toHaveLength(1);
  });

  it("n'indexe ni les échecs de déchiffrement ni les événements sans corps", async () => {
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "visible"));
    ctx.emitDecrypted(matrixEvent("$e2", ROOM, "raté", { failed: true }));
    ctx.emitDecrypted(matrixEvent("$e3", ROOM, "", {}));
    ctx.emitDecrypted(matrixEvent("$e4", ROOM, "réaction", { type: "m.reaction" }));

    await vi.waitFor(async () => expect(await search.stats()).toMatchObject({ size: 1 }));
    expect((await search.search("visible")).map((hit) => hit.eventId)).toEqual(["$e1"]);
  });

  it("une erreur du worker remonte comme rejet, sans casser les appels suivants", async () => {
    const cassé = fakeWorker();
    serve(cassé.inside, Promise.reject(new Error("index illisible")));
    const fragile = createSearch(fakeSession().session, cassé.outside);

    await expect(fragile.stats()).rejects.toThrow("index illisible");
    fragile.dispose();
  });
});

describe("aucune recherche n'émet d'appel réseau", () => {
  it("fetch et XMLHttpRequest ne sont pas touchés pendant une recherche", async () => {
    const fetchSpy = vi.fn();
    const xhrSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("XMLHttpRequest", class { open = xhrSpy; send = xhrSpy });

    await search.index(doc("$e1", "hors ligne"));
    await search.search("hors ligne");
    await search.stats();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("aucun code du package n'appelle l'endpoint /search de Synapse", () => {
    const code = packageCode();
    expect(code).not.toMatch(/_matrix\/client|\/search\b|fetch\(|XMLHttpRequest/);
    expect(code).not.toMatch(/client\.search|searchRoomEvents|backPaginateRoomEventsSearch/);
  });
});

describe("msgtype et mentions alimentés au déchiffrement", () => {
  const MIRA = "@mira:tacita.test";

  it("relit msgtype et m.mentions de l'événement, sans que l'appelant s'en occupe", async () => {
    ctx.emitDecrypted(
      matrixEvent("$e1", ROOM, "chat.jpg", { msgtype: "m.image", mentions: { user_ids: [MIRA] } }),
    );
    ctx.emitDecrypted(matrixEvent("$e2", ROOM, "coucou tout le monde", { mentions: { room: true } }));

    await vi.waitFor(async () => expect((await search.stats()).size).toBe(2));
    expect((await search.search("", { msgtype: "m.image" })).map((hit) => hit.eventId)).toEqual([
      "$e1",
    ]);
    expect((await search.search("", { mentions: [MIRA, ROOM_MENTION] })).map((h) => h.eventId).sort())
      .toEqual(["$e1", "$e2"]);
  });

  it("un message sans msgtype vaut m.text, un message sans mention n'en porte aucune", async () => {
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "message nu"));

    await vi.waitFor(async () => expect((await search.stats()).size).toBe(1));
    const [hit] = await search.search("nu");
    expect(hit).toMatchObject({ msgtype: "m.text", mentions: [] });
  });

  it("une correction met à jour le type et les mentions, pas seulement le texte", async () => {
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "oubli", { mentions: { user_ids: [MIRA] } }));
    await vi.waitFor(async () => expect((await search.stats()).size).toBe(1));

    ctx.emitDecrypted(matrixEvent("$e2", ROOM, "corrigé", { replaces: "$e1" }));

    await vi.waitFor(async () => expect((await search.search("corrigé")).length).toBe(1));
    expect(await search.search("", { mentions: MIRA })).toEqual([]);
  });

  it("les critères traversent le protocole du worker tels quels", async () => {
    await search.search("réunion", { sender: MIRA, since: 1_000 });

    expect(worker.posted.at(-1)).toMatchObject({
      method: "search",
      args: ["réunion", { sender: MIRA, since: 1_000 }],
    });
  });
});

describe("le périmètre couvert est exposé pour l'UI", () => {
  it("stats donne de quoi dire « historique téléchargé », pas « tout l'historique »", async () => {
    await search.index([doc("$e1", "un", 1_000), doc("$e2", "deux", 9_000)]);

    expect(await search.stats()).toEqual({
      size: 2,
      max: 200_000,
      oldestTs: 1_000,
      newestTs: 9_000,
    });
  });

  it("la limite est documentée plutôt que masquée", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    expect(readme).toMatch(/historique téléchargé/i);
    expect(readme).toMatch(/\/search/);
  });
});

describe("l'index suit le cycle de vie des messages", () => {
  it("une suppression retire le texte de l'index", async () => {
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "à supprimer"));
    await vi.waitFor(async () => expect((await search.stats()).size).toBe(1));

    ctx.emitRedaction(redactionOf("$e1"));

    await vi.waitFor(async () => expect(await search.search("supprimer")).toEqual([]));
    expect((await search.stats()).size).toBe(0);
  });

  it("une édition remplace le message : l'ancienne version cesse d'être trouvable", async () => {
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "rendez-vous au parc"));
    await vi.waitFor(async () => expect((await search.stats()).size).toBe(1));

    // L'édition porte son propre event_id ; c'est sa cible qui doit être remplacée.
    ctx.emitDecrypted(matrixEvent("$e2", ROOM, "rendez-vous au musée", { replaces: "$e1" }));

    await vi.waitFor(async () => expect(await search.search("parc")).toEqual([]));
    // Un seul document, sous l'identifiant du message d'origine — pas un second au
    // corps « * rendez-vous au musée ».
    expect((await search.stats()).size).toBe(1);
    expect((await search.search("musée")).map((hit) => hit.eventId)).toEqual(["$e1"]);
  });

  it("supprimer un message que l'index n'a jamais vu ne casse rien", async () => {
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "anodin"));
    await vi.waitFor(async () => expect((await search.stats()).size).toBe(1));

    ctx.emitRedaction(redactionOf("$jamais-indexé"));

    await vi.waitFor(async () => expect((await search.stats()).size).toBe(1));
    expect((await search.search("anodin")).map((hit) => hit.eventId)).toEqual(["$e1"]);
  });

  it("dispose détache aussi le hook de suppression", () => {
    search.dispose();
    expect(ctx.client.off).toHaveBeenCalledWith(RoomEvent.Redaction, expect.any(Function));
  });
});

describe("wipe enregistré au registre de la Session", () => {
  it("s'enregistre sous le nom search et vide l'index quand il est appelé", async () => {
    expect(ctx.session.registerWipe).toHaveBeenCalledWith("search", expect.any(Function));

    await search.index(doc("$e1", "secret"));
    await ctx.runWipes();

    expect(await search.search("secret")).toEqual([]);
    expect((await search.stats()).size).toBe(0);
  });

  it("un événement encore en tampon au moment du wipe n'atterrit pas dans l'index", async () => {
    // Timers réels : le va-et-vient avec le worker en dépend, et c'est justement le
    // délai du tampon qu'on veut voir s'écouler pour de bon.
    ctx.emitDecrypted(matrixEvent("$e1", ROOM, "secret"));
    await ctx.runWipes(); // wipe pendant la fenêtre d'accumulation
    await new Promise((resolve) => setTimeout(resolve, BUFFER_MS + 50));

    // Sans purge du tampon, le timer se déclenche après le wipe, réindexe, et le
    // persist() du moteur réécrit du clair sur disque une fois déconnecté.
    expect((await search.stats()).size).toBe(0);
    expect(await search.search("secret")).toEqual([]);
  });

  it("dispose détache le hook de déchiffrement", () => {
    search.dispose();
    expect(ctx.client.off).toHaveBeenCalledWith(MatrixEventEvent.Decrypted, expect.any(Function));
  });
});

describe("l'index s'amorce sur ce que le client tient déjà", () => {
  /**
   * L'écoute seule ne voit que les déchiffrements postérieurs au branchement. Sur une
   * session rouverte, l'historique est relu depuis IndexedDB et déchiffré avant qu'on
   * arrive : sans amorçage, la recherche ne trouve rien de ce que l'écran affiche.
   */
  it("indexe les timelines vives des salons au branchement", async () => {
    const contexte = fakeSession();
    contexte.chargerTimelines(
      [matrixEvent("$vieux", ROOM, "on se voit à la réunion")],
      [matrixEvent("$autre", "!groupe:tacita.test", "pizza ce soir")],
    );

    const canal = fakeWorker();
    serve(canal.inside, createEngine({ indexedDB: new IDBFactory() }));
    const amorce = createSearch(contexte.session, canal.outside);

    expect((await amorce.search("réunion")).map((hit) => hit.eventId)).toEqual(["$vieux"]);
    expect((await amorce.search("pizza")).map((hit) => hit.eventId)).toEqual(["$autre"]);
    amorce.dispose();
  });

  it("n'indexe rien quand le client n'a encore aucun salon", async () => {
    // Le cas d'une session neuve : aucun message posté au worker, donc aucun lot vide.
    const contexte = fakeSession();
    const canal = fakeWorker();
    serve(canal.inside, createEngine({ indexedDB: new IDBFactory() }));
    const amorce = createSearch(contexte.session, canal.outside);

    expect(canal.posted).toEqual([]);
    amorce.dispose();
  });

  it("réindexer un événement déjà connu ne le duplique pas", async () => {
    // L'amorçage a lieu à chaque ouverture de session : il doit être sans effet la
    // seconde fois, sans quoi il gonflerait l'index jusqu'au plafond D-01.
    const evenement = matrixEvent("$vieux", ROOM, "on se voit à la réunion");
    const contexte = fakeSession();
    contexte.chargerTimelines([evenement]);

    const canal = fakeWorker();
    serve(canal.inside, createEngine({ indexedDB: new IDBFactory() }));
    const amorce = createSearch(contexte.session, canal.outside);

    contexte.emitDecrypted(evenement);
    await new Promise((resolve) => setTimeout(resolve, BUFFER_MS + 10));

    expect(await amorce.search("réunion")).toHaveLength(1);
    amorce.dispose();
  });
});
