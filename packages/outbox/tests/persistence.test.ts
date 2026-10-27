import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BASE_BACKOFF_MS, createOutbox, type Outbox } from "../src";
import { fakeSession, matrixError } from "./session-mock";

const ROOM = "!salon:tacita.test";
const message = (body: string) => ({ msgtype: "m.text", body });

const code = ["outbox.ts", "store.ts", "entry.ts", "index.ts"]
  .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf-8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

let ctx: ReturnType<typeof fakeSession>;
let outbox: Outbox;

beforeEach(async () => {
  ctx = fakeSession();
  outbox = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB });
});

describe("persistance IndexedDB avant tout réseau, survit au reload", () => {
  it("écrit l'entrée avant la première tentative d'envoi", async () => {
    const order: string[] = [];
    ctx.client.sendEvent.mockImplementation(async () => {
      order.push("send");
      return { event_id: "$ok" };
    });
    outbox.subscribe(() => order.push("persist"));

    await outbox.enqueue(ROOM, message("un"), "t1");
    await vi.waitFor(() => expect(order).toContain("send"));
    expect(order[0]).toBe("persist");
  });

  it("l'entrée est toujours là après destruction et recréation du module", async () => {
    ctx.client.sendEvent.mockRejectedValue(new Error("hors ligne"));
    await outbox.enqueue(ROOM, message("composé hors ligne"), "t1");
    outbox.dispose();

    const rechargé = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB });
    expect(rechargé.pending(ROOM)).toEqual([
      expect.objectContaining({ txnId: "t1", content: message("composé hors ligne") }),
    ]);
    rechargé.dispose();
  });

  it("le statut « sending » est visible mais n'atteint jamais le disque", async () => {
    let resolveSend: (() => void) | undefined;
    ctx.client.sendEvent.mockImplementation(
      () => new Promise((resolve) => (resolveSend = () => resolve({ event_id: "$ok" }))),
    );

    await outbox.enqueue(ROOM, message("un"), "t1");
    await vi.waitFor(() => expect(outbox.pending(ROOM)[0]?.status).toBe("sending"));
    outbox.dispose(); // onglet fermé en plein envoi

    // Rien à réparer au démarrage : le disque n'a jamais connu que « queued ».
    const rechargé = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB });
    expect(rechargé.pending(ROOM)[0]?.status).toBe("queued");
    resolveSend?.();
    rechargé.dispose();
  });
});

describe("le contenu ne passe ni par localStorage ni par les logs", () => {
  it("aucun stockage synchrone du navigateur n'est touché", () => {
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it("le module n'écrit rien dans la console", () => {
    expect(code).not.toMatch(/console\./);
  });

  it("une entrée en échec ne retient que le code d'erreur, pas le message", async () => {
    ctx.client.sendEvent.mockRejectedValue(
      Object.assign(new Error("échec sur le corps « rendez-vous à 18h »"), {
        errcode: "M_FORBIDDEN",
        httpStatus: 403,
      }),
    );
    await outbox.enqueue(ROOM, message("rendez-vous à 18h"), "t1");
    await outbox.flush();

    const [entry] = outbox.pending(ROOM);
    expect(entry?.errcode).toBe("M_FORBIDDEN");
    expect(Object.keys(entry!)).not.toContain("error");
    // Le contenu vit dans `content`, qui est ce que la Session chiffrera — nulle part ailleurs.
    expect(JSON.stringify({ ...entry, content: undefined })).not.toContain("18h");
  });
});

describe("le store est enregistré au registre de wipe de la Session", () => {
  it("s'enregistre sous le nom outbox", () => {
    expect(ctx.session.registerWipe).toHaveBeenCalledWith("outbox", expect.any(Function));
  });

  it("le wipe vide la file en mémoire et sur disque", async () => {
    ctx.client.sendEvent.mockRejectedValue(matrixError("M_FORBIDDEN", 403));
    await outbox.enqueue(ROOM, message("un"), "t1");
    await outbox.flush();
    expect(outbox.pending(ROOM)).toHaveLength(1);

    await ctx.runWipes();
    expect(outbox.pending(ROOM)).toEqual([]);

    outbox.dispose();
    const rechargé = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB });
    expect(rechargé.pending(ROOM)).toEqual([]);
    rechargé.dispose();
  });
});

describe("la reprise d'un téléversement média appartient à la file", () => {
  const octets = (taille: number): ArrayBuffer => new Uint8Array(taille).fill(7).buffer;
  const media = () => ({
    msgtype: "m.image",
    body: "plage.jpg",
    file: { url: "", key: {}, iv: "iv", hashes: {}, v: "v2" },
    info: { thumbnail_file: { url: "" } },
  });

  const enAttente = () => [
    { chemin: ["file", "url"], octets: octets(32) },
    { chemin: ["info", "thumbnail_file", "url"], octets: octets(8) },
  ];

  it("téléverse chaque blob, pose son URL au bon endroit, puis envoie l'événement", async () => {
    let rang = 0;
    const televerser = vi.fn(async () => `mxc://tacita.test/${(rang += 1)}`);
    const file = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB, televerser });

    await file.enqueue(ROOM, media(), "t1", enAttente());
    await vi.waitFor(() => expect(ctx.client.sendEvent).toHaveBeenCalled());

    expect(televerser).toHaveBeenCalledTimes(2);
    const [, , contenu] = ctx.client.sendEvent.mock.calls[0]!;
    expect((contenu as { file: { url: string } }).file.url).toBe("mxc://tacita.test/1");
    expect(
      (contenu as { info: { thumbnail_file: { url: string } } }).info.thumbnail_file.url,
    ).toBe("mxc://tacita.test/2");
    file.dispose();
  });

  /**
   * Le cœur de la REQ : un téléversement de 200 Mo qui échoue au second blob ne doit pas
   * refaire le premier. Sans cette propriété, la « reprise » est un renvoi complet.
   */
  it("un échec au second blob ne re-téléverse pas le premier", async () => {
    const televerses: number[] = [];
    let echoue = true;
    const televerser = vi.fn(async (donnees: ArrayBuffer) => {
      if (donnees.byteLength === 8 && echoue) {
        echoue = false;
        throw new Error("réseau coupé");
      }
      televerses.push(donnees.byteLength);
      return "mxc://tacita.test/ok";
    });

    const file = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB, televerser });
    await file.enqueue(ROOM, media(), "t1", enAttente());

    await vi.waitFor(() => expect(televerses).toContain(32));
    // Le premier est passé, le second a échoué : l'entrée reste en file avec le seul
    // téléversement qui manque.
    await vi.waitFor(() => expect(file.pending(ROOM)[0]?.televersements).toHaveLength(1));
    expect(file.pending(ROOM)[0]!.televersements![0]!.octets.byteLength).toBe(8);
    // Et le contenu porte déjà l'URL du premier : elle a été persistée, pas recalculée.
    expect((file.pending(ROOM)[0]!.content as { file: { url: string } }).file.url).toBe(
      "mxc://tacita.test/ok",
    );

    await file.flush();
    // La reprise est tenue par le backoff : l'entrée n'est due qu'à BASE_BACKOFF_MS après
    // l'échec, et le délai par défaut de `waitFor` vaut exactement cette durée — le test
    // ne tenait qu'à quelques millisecondes, et tombait dès que la machine était chargée.
    await vi.waitFor(() => expect(ctx.client.sendEvent).toHaveBeenCalled(), {
      timeout: 3 * BASE_BACKOFF_MS,
    });
    // Deux tailles téléversées en tout : 32 une seule fois, puis 8.
    expect(televerses).toEqual([32, 8]);
    file.dispose();
  });

  it("ce qui reste à téléverser survit à un redémarrage du module", async () => {
    const televerser = vi.fn(async () => {
      throw new Error("hors ligne");
    });
    const file = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB, televerser });
    await file.enqueue(ROOM, media(), "t1", enAttente());
    await vi.waitFor(() => expect(televerser).toHaveBeenCalled());
    file.dispose();

    const relancee = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB, televerser });
    // Les octets chiffrés sont toujours là : la reprise ne rechiffrera rien.
    expect(relancee.pending(ROOM)[0]?.televersements).toHaveLength(2);
    expect(relancee.pending(ROOM)[0]!.televersements![0]!.octets.byteLength).toBe(32);
    relancee.dispose();
  });

  it("sans téléverseur injecté, une pièce jointe ne part pas en silence", async () => {
    const file = await createOutbox(ctx.session, { indexedDB: ctx.indexedDB });
    await file.enqueue(ROOM, media(), "t1", enAttente());

    await vi.waitFor(() => expect(file.pending(ROOM)[0]?.attempts).toBeGreaterThan(0));
    expect(ctx.client.sendEvent).not.toHaveBeenCalled();
    file.dispose();
  });
});
