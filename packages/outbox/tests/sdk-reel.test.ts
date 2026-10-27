import { asSession } from "@tacita/client-core/testing";
import { IDBFactory } from "fake-indexeddb";
import {
  ClientEvent,
  createClient,
  EventStatus,
  MemoryStore,
  Room,
  SyncState,
  type MatrixClient,
} from "matrix-js-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutbox, type Outbox } from "../src";

/*
 * **Un vrai `MatrixClient`, seul `fetch` est simulé.**
 *
 * Les autres tests de ce paquet mockent `client.sendEvent` : ils ne peuvent rien dire de
 * ce que le SDK garde d'un envoi raté, puisque le mock ne garde rien (règle 3). Or c'est
 * là que la reprise cassait — la timeline du SDK retient son écho local par `txnId`, et
 * refuse qu'on lui en présente un second avec le même.
 */

const ROOM = "!salon:tacita.test";
const MOI = "@moi:tacita.test";
const message = (body: string) => ({ msgtype: "m.text", body });

/** Au-delà du premier backoff de la file : l'entrée est de nouveau tentable. */
const APRÈS_LE_BACKOFF = 120_000;

type Reponse = "coupure" | { event_id: string };

let client: MatrixClient;
let room: Room;
let outbox: Outbox;
/** Une réponse par `PUT …/send/…`, dans l'ordre ; les autres requêtes rendent `{}`. */
let envois: Reponse[];
let txnEnvoyes: string[];

beforeEach(async () => {
  envois = [];
  txnEnvoyes = [];
  client = createClient({
    baseUrl: "https://hs.tacita.test",
    userId: MOI,
    deviceId: "APPAREIL",
    accessToken: "jeton",
    store: new MemoryStore(),
    fetchFn: async (url) => {
      const chemin = new URL(String(url)).pathname;
      const envoi = /\/send\/[^/]+\/([^/]+)$/.exec(chemin);
      if (!envoi) return Response.json({});
      txnEnvoyes.push(decodeURIComponent(envoi[1]!));
      const reponse = envois.shift() ?? "coupure";
      if (reponse === "coupure") throw new TypeError("fetch failed");
      return Response.json(reponse);
    },
  });
  room = new Room(ROOM, client, MOI);
  client.store.storeRoom(room);

  outbox = await createOutbox(
    asSession({
      client,
      // La garde de chiffrement de la file n'est pas le sujet ici ; le SDK, lui, n'a
      // pas d'état de chiffrement pour ce salon et envoie tel quel.
      isEncrypted: async () => true,
      registerWipe: () => {},
    }),
    { indexedDB: new IDBFactory() },
  );
  client.emit(ClientEvent.Sync, SyncState.Syncing, null);
  // `Date` seul : le SDK arme ses propres `setTimeout`, qu'on laisse courir.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  outbox.dispose();
  client.stopClient();
  vi.useRealTimers();
});

/** Ce que la timeline du SDK porte pour ce `txnId` — l'écho que l'UI masque tant que la file le tient. */
const echoDe = (txnId: string) => room.getLiveTimeline().getEvents().filter((e) => e.getTxnId() === txnId);

describe("un message dont le premier envoi a échoué part au suivant, avec le vrai SDK", () => {
  it("après une coupure, la reprise automatique envoie le message au lieu d'être refusée par le SDK", async () => {
    envois = ["coupure", { event_id: "$parti" }];
    await outbox.enqueue(ROOM, message("bonjour"), "t1");
    await outbox.flush();
    expect(outbox.pending(ROOM)[0]?.status).toBe("queued");

    vi.setSystemTime(Date.now() + APRÈS_LE_BACKOFF);
    await outbox.flush();

    // Le SDK refusait le second envoi avant tout réseau (« known txnId ») : la file ne
    // voyait qu'une erreur sans statut, et réessayait sans jamais rien envoyer.
    expect(txnEnvoyes).toEqual(["t1", "t1"]);
    expect(outbox.pending(ROOM)).toEqual([]);
  });

  it("le renvoi manuel d'un message en échec l'envoie, sous le même txnId", async () => {
    envois = ["coupure", "coupure", "coupure", "coupure", "coupure", "coupure"];
    await outbox.enqueue(ROOM, message("bonjour"), "t1");
    for (let essai = 0; essai < 6; essai++) {
      await outbox.flush();
      vi.setSystemTime(Date.now() + APRÈS_LE_BACKOFF);
    }
    expect(outbox.pending(ROOM)[0]?.status).toBe("failed");

    envois = [{ event_id: "$parti" }];
    await outbox.retry("t1");

    expect(txnEnvoyes.at(-1)).toBe("t1");
    expect(outbox.pending(ROOM)).toEqual([]);
  });

  it("une fois parti, il n'y a qu'un écho, et il porte l'identifiant du serveur", async () => {
    envois = ["coupure", { event_id: "$parti" }];
    await outbox.enqueue(ROOM, message("bonjour"), "t1");
    await outbox.flush();
    vi.setSystemTime(Date.now() + APRÈS_LE_BACKOFF);
    await outbox.flush();

    const [echo, ...autres] = echoDe("t1");
    expect(autres).toEqual([]);
    expect(echo?.getId()).toBe("$parti");
  });
});

describe("un message abandonné ne reste pas dans la timeline du SDK", () => {
  it("abandonner retire l'écho non envoyé, qui sinon s'afficherait comme un message parti", async () => {
    envois = ["coupure"];
    await outbox.enqueue(ROOM, message("bonjour"), "t1");
    await outbox.flush();
    expect(echoDe("t1").map((e) => e.status)).toEqual([EventStatus.NOT_SENT]);

    await outbox.remove("t1");

    // Masqué tant que la file tenait l'entrée (`sansEchoDeFile`), cet écho redevenait
    // visible à l'abandon : un message jamais envoyé, rendu comme les autres.
    expect(echoDe("t1")).toEqual([]);
  });
});
