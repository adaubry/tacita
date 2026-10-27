import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it } from "vitest";

import { packageCode } from "./session-mock";

// Import direct : le moteur ne dépend pas de matrix-js-sdk, ces tests non plus.
import {
  BATCH_SIZE,
  createEngine,
  MAX_EVENTS,
  type IndexableEvent,
  type SearchEngine,
} from "../src/engine";

const ROOM = "!salon:tacita.test";
const AUTRE = "!autre:tacita.test";

const event = (
  n: number,
  body: string,
  roomId = ROOM,
  tsOrigin = n,
  reste: Partial<IndexableEvent> = {},
): IndexableEvent => ({
  eventId: `$e${n}`,
  roomId,
  sender: "@bob:tacita.test",
  tsOrigin,
  body,
  msgtype: "m.text",
  mentions: [],
  ...reste,
});

let indexedDB: IDBFactory;
let engine: SearchEngine;

beforeEach(async () => {
  indexedDB = new IDBFactory();
  engine = await createEngine({ indexedDB });
});

describe("index Orama alimenté par les événements déchiffrés", () => {
  it("indexe un lot et le retrouve par mot-clé", async () => {
    await engine.index([event(1, "rendez-vous au parc"), event(2, "courses ce soir")]);
    const hits = await engine.search("parc");
    expect(hits.map((hit) => hit.eventId)).toEqual(["$e1"]);
    expect(hits[0]).toMatchObject({ roomId: ROOM, body: "rendez-vous au parc" });
  });
});

describe("index persisté, rechargé sans réindexation", () => {
  it("une recherche donne le même résultat après rechargement du module", async () => {
    await engine.index([event(1, "rendez-vous au parc")]);
    engine.close();

    const rechargé = await createEngine({ indexedDB });
    expect((await rechargé.search("parc")).map((hit) => hit.eventId)).toEqual(["$e1"]);
    expect((await rechargé.stats()).size).toBe(1);
    rechargé.close();
  });

  it("un snapshot d'une génération de schéma antérieure est effacé, pas chargé", async () => {
    await engine.index([event(1, "rendez-vous au parc")]);
    engine.close();

    // Ce que laisserait une version d'avant : les mêmes octets, sans les
    // index `msgtype` et `mentions`. Le charger donnerait une base qui échoue au
    // premier filtre — et laisserait du clair illisible en IndexedDB.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("tacita-search", 1);
      request.onsuccess = () => resolve(request.result);
    });
    const stored = db.transaction("index", "readwrite").objectStore("index");
    stored.put({ generation: 1, raw: { anciens: "octets" } }, "orama");
    await new Promise((resolve) => {
      stored.transaction.oncomplete = resolve;
    });
    db.close();

    const rechargé = await createEngine({ indexedDB });
    expect((await rechargé.stats()).size).toBe(0);
    rechargé.close();

    // Effacé, pas seulement ignoré : c'est du contenu déchiffré, il n'a aucune raison
    // de survivre à sa lisibilité.
    const relu = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open("tacita-search", 1);
      request.onsuccess = () => resolve(request.result);
    });
    const restant = relu.transaction("index", "readonly").objectStore("index").get("orama");
    await new Promise((resolve) => {
      restant.onsuccess = resolve;
    });
    expect(restant.result).toBeUndefined();
    relu.close();
  });

  it("un index neuf sans snapshot ne trouve rien plutôt que d'échouer", async () => {
    expect(await engine.search("parc")).toEqual([]);
    expect(await engine.stats()).toMatchObject({ size: 0, oldestTs: null, newestTs: null });
  });
});

describe("recherche globale et par salon", () => {
  beforeEach(async () => {
    await engine.index([
      event(1, "réunion demain", ROOM),
      event(2, "réunion annulée", AUTRE),
      event(3, "déjeuner", ROOM),
    ]);
  });

  it("cherche dans tous les salons par défaut", async () => {
    const hits = await engine.search("réunion");
    expect(hits.map((hit) => hit.eventId).sort()).toEqual(["$e1", "$e2"]);
  });

  it("restreint à un salon quand il est fourni", async () => {
    const hits = await engine.search("réunion", { roomId: AUTRE });
    expect(hits.map((hit) => hit.eventId)).toEqual(["$e2"]);
  });

  it("rend une liste vide quand rien ne correspond", async () => {
    expect(await engine.search("licorne")).toEqual([]);
  });
});

describe("recherche filtrée, critères combinables et locaux", () => {
  const BOB = "@bob:tacita.test";
  const MIRA = "@mira:tacita.test";

  beforeEach(async () => {
    await engine.index([
      event(1, "réunion demain", ROOM, 1_000, { mentions: [MIRA] }),
      event(2, "réunion annulée", ROOM, 2_000, { sender: MIRA }),
      event(3, "photo réunion.jpg", ROOM, 3_000, { msgtype: "m.image" }),
      event(4, "réunion de crise", AUTRE, 4_000, { sender: MIRA, mentions: [BOB] }),
      event(5, "réunion générale", ROOM, 5_000, { mentions: ["@room"] }),
    ]);
  });

  const ids = async (query: string, filters?: Parameters<typeof engine.search>[1]) =>
    (await engine.search(query, filters)).map((hit) => hit.eventId).sort();

  it("un critère absent ne restreint rien", async () => {
    expect(await ids("réunion")).toEqual(["$e1", "$e2", "$e3", "$e4", "$e5"]);
    expect(await ids("réunion", {})).toEqual(["$e1", "$e2", "$e3", "$e4", "$e5"]);
  });

  it("filtrer par expéditeur ne rend que ses messages", async () => {
    expect(await ids("réunion", { sender: MIRA })).toEqual(["$e2", "$e4"]);
  });

  it("filtrer par msgtype distingue le texte du média", async () => {
    expect(await ids("réunion", { msgtype: "m.image" })).toEqual(["$e3"]);
    expect(await ids("réunion", { msgtype: "m.text" })).toEqual(["$e1", "$e2", "$e4", "$e5"]);
  });

  it("l'onglet Mentions se sert du champ, sans plein-texte sur un nom d'affichage", async () => {
    // Terme vide : on ne cherche pas un mot, on filtre. Chercher « bob » aurait rendu
    // les messages qui *parlent* de lui, et raté ceux qui le mentionnent en pièce jointe.
    expect(await ids("", { mentions: BOB })).toEqual(["$e4"]);
    // Une mention de salon en est une pour chacun : l'UI passe les deux.
    expect(await ids("", { mentions: [BOB, "@room"] })).toEqual(["$e4", "$e5"]);
    expect(await ids("", { mentions: "@inconnu:tacita.test" })).toEqual([]);
  });

  it("les bornes de date filtrent, chacune de son côté", async () => {
    expect(await ids("réunion", { since: 3_000 })).toEqual(["$e3", "$e4", "$e5"]);
    expect(await ids("réunion", { until: 2_000 })).toEqual(["$e1", "$e2"]);
    expect(await ids("réunion", { since: 2_000, until: 4_000 })).toEqual(["$e2", "$e3", "$e4"]);
  });

  it("un filtre de dates ne modifie pas l'ordre des résultats", async () => {
    // Interdit n°6 — `tsOrigin` filtre, il ne trie jamais. L'ordre reste celui de la
    // pertinence : un sous-ensemble filtré garde l'ordre relatif du résultat complet.
    const complet = (await engine.search("réunion")).map((hit) => hit.eventId);
    const filtré = (await engine.search("réunion", { since: 2_000 })).map((hit) => hit.eventId);
    expect(filtré).toEqual(complet.filter((id) => filtré.includes(id)));
  });

  it("deux critères combinés rendent l'intersection", async () => {
    expect(await ids("réunion", { sender: MIRA, roomId: AUTRE })).toEqual(["$e4"]);
    expect(await ids("réunion", { sender: MIRA, msgtype: "m.image" })).toEqual([]);
    expect(await ids("réunion", { mentions: BOB, since: 5_000 })).toEqual([]);
  });

  it("le hit porte les deux champs ajoutés, pour que l'UI n'ait rien à redériver", async () => {
    const [hit] = await engine.search("crise");
    expect(hit).toMatchObject({ msgtype: "m.text", mentions: [BOB], sender: MIRA });
  });
});

describe("plafond de l'index et éviction des plus anciens", () => {
  it("le plafond par défaut est celui que le README consigne", () => {
    expect(MAX_EVENTS).toBe(200_000);
  });

  it("au-delà du plafond, les plus anciens sortent et les récents restent", async () => {
    // Plafond abaissé : indexer 200 001 documents réels prendrait des minutes pour
    // vérifier la même branche.
    const petit = await createEngine({ indexedDB: new IDBFactory(), maxEvents: 5 });
    // Un mot distinct par événement : Orama fait de l'OR sur les tokens, un corps
    // partagé rendrait le test incapable de distinguer l'évincé du reste.
    const mots = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    await petit.index(mots.map((mot, n) => event(n, mot, ROOM, n)));

    expect(await petit.stats()).toMatchObject({ size: 5, max: 5, oldestTs: 1, newestTs: 5 });
    expect(await petit.search("alpha")).toEqual([]);
    expect((await petit.search("foxtrot")).map((hit) => hit.eventId)).toEqual(["$e5"]);
    petit.close();
  });

  it("stats expose taille, plafond et bornes temporelles couvertes", async () => {
    await engine.index([event(1, "un", ROOM, 1_000), event(2, "deux", ROOM, 5_000)]);
    expect(await engine.stats()).toEqual({
      size: 2,
      max: MAX_EVENTS,
      oldestTs: 1_000,
      newestTs: 5_000,
    });
  });

  it("évince par ordre d'indexation, pas par date d'origine : un rattrapage survit", async () => {
    const petit = await createEngine({ indexedDB: new IDBFactory(), maxEvents: 2 });

    // D'abord deux messages récents, puis un rattrapage d'historique ancien — c'est
    // l'ordre réel d'une pagination arrière.
    await petit.index([event(1, "alpha", ROOM, 9_000), event(2, "bravo", ROOM, 9_500)]);
    await petit.index([event(3, "charlie", ROOM, 1_000)]);

    // Évincer par `tsOrigin` sortirait « charlie », qu'on vient de télécharger : le
    // rattrapage s'auto-évincerait et ne servirait à rien.
    expect((await petit.search("charlie")).map((hit) => hit.eventId)).toEqual(["$e3"]);
    expect(await petit.search("alpha")).toEqual([]);
    expect((await petit.stats()).oldestTs).toBe(1_000);
    petit.close();
  });
});

describe("l'index suit le cycle de vie des messages", () => {
  it("un événement retiré n'est plus trouvable", async () => {
    await engine.index([event(1, "secret"), event(2, "anodin")]);
    await engine.remove(["$e1"]);

    expect(await engine.search("secret")).toEqual([]);
    expect((await engine.search("anodin")).map((hit) => hit.eventId)).toEqual(["$e2"]);
    expect((await engine.stats()).size).toBe(1);
  });

  it("le retrait survit au rechargement : le texte ne revient pas", async () => {
    await engine.index([event(1, "secret")]);
    await engine.remove(["$e1"]);
    engine.close();

    const rechargé = await createEngine({ indexedDB });
    expect(await rechargé.search("secret")).toEqual([]);
    rechargé.close();
  });

  it("retirer un identifiant inconnu ne casse rien", async () => {
    await engine.index([event(1, "anodin")]);
    await expect(engine.remove(["$jamais-vu"])).resolves.toBeUndefined();
    expect((await engine.stats()).size).toBe(1);
  });

  it("réindexer un identifiant connu remplace le document au lieu d'en ajouter un", async () => {
    await engine.index([event(1, "version initiale")]);
    await engine.index([event(1, "version corrigée")]);

    expect((await engine.stats()).size).toBe(1);
    expect(await engine.search("initiale")).toEqual([]);
    expect((await engine.search("corrigée")).map((hit) => hit.eventId)).toEqual(["$e1"]);
  });

  it("un message et son édition dans le même lot ne cassent pas l'indexation", async () => {
    // Cas courant : une rafale de sync livre le message et son édition ensemble, et
    // l'édition porte l'identifiant de sa cible — donc deux entrées, un seul id.
    await engine.index([event(1, "version initiale"), event(1, "version corrigée")]);

    expect((await engine.stats()).size).toBe(1);
    expect(await engine.search("initiale")).toEqual([]);
    expect((await engine.search("corrigée")).map((hit) => hit.eventId)).toEqual(["$e1"]);
  });

  it("un remplacement garde la date d'origine du message, pas celle de la correction", async () => {
    await engine.index([event(1, "version initiale", ROOM, 1_000)]);
    await engine.index([event(1, "version corrigée", ROOM, 9_000)]);

    // Les bornes affichées décrivent la période des messages couverts, pas celle de
    // leurs corrections.
    expect(await engine.stats()).toMatchObject({ oldestTs: 1_000, newestTs: 1_000 });
  });
});

describe("la rotation Megolm n'est pas un événement pour l'index", () => {
  it("aucun code ne réagit à une rotation de session ni ne réindexe", () => {
    expect(packageCode()).not.toMatch(/megolm|RoomKey|sessionId|reindex|réindex/i);
  });

  it("seuls la purge et wipe retirent quelque chose de l'index", async () => {
    await engine.index([event(1, "toujours là")]);
    expect((await engine.stats()).size).toBe(1);
    await engine.wipe();
    expect((await engine.stats()).size).toBe(0);
  });
});

describe("wipe détruit l'index et son snapshot", () => {
  it("après wipe, plus aucun résultat et le store est vide au rechargement", async () => {
    await engine.index([event(1, "rendez-vous au parc")]);
    await engine.wipe();
    expect(await engine.search("parc")).toEqual([]);

    engine.close();
    const rechargé = await createEngine({ indexedDB });
    expect(await rechargé.search("parc")).toEqual([]);
    expect((await rechargé.stats()).size).toBe(0);
    rechargé.close();
  });
});

describe("indexation par lots avec rendu de la main", () => {
  it("rend la main entre chaque lot, une fois de moins que de lots", async () => {
    let yields = 0;
    const parLots = await createEngine({
      indexedDB: new IDBFactory(),
      yieldTo: async () => {
        yields++;
      },
    });

    await parLots.index(
      Array.from({ length: BATCH_SIZE * 3 }, (_, n) => event(n, `message ${n}`)),
    );

    expect(yields).toBe(2);
    expect((await parLots.stats()).size).toBe(BATCH_SIZE * 3);
    parLots.close();
  });

  it("un lot unique ne rend pas la main pour rien", async () => {
    let yields = 0;
    const petit = await createEngine({
      indexedDB: new IDBFactory(),
      yieldTo: async () => {
        yields++;
      },
    });
    await petit.index([event(1, "un")]);
    expect(yields).toBe(0);
    petit.close();
  });
});
