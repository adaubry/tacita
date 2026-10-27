import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresStore, SCHEMA, type Store } from "../../apps/invite-tokens/src/store.ts";

/**
 * **l'atomicité, contre un vrai PostgreSQL.**
 *
 * Par la règle des deux portes : `apps/invite-tokens/tests/store.test.ts` asserte la
 * *forme* de l'instruction, ce qui attrape une régression de structure. Il ne prouve pas
 * le comportement — l'imitation en mémoire de la suite est monothread, donc atomique par
 * construction, et une imitation qui confirme l'hypothèse par construction ne l'éprouve
 * pas (règle 3 de `CLAUDE.md`).
 *
 * Ce que ce fichier prouve, et que 56 tests ne prouvaient pas : que le SQL est valide,
 * et qu'une seule de deux résolutions concurrentes du dernier usage réussit **quand
 * c'est PostgreSQL qui arbitre**.
 */

const { POSTGRES_USER, POSTGRES_PASSWORD } = process.env;
// 55432 : le port publié par l’overlay de fumée, choisi loin des ports PostgreSQL
// courants. Le service, lui, joint la base par le réseau du compose.
const DATABASE_URL = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:55432/invite_tokens`;

const BOB = "@bob:tacita.test";
const MAINTENANT = Date.now();

let pool: pg.Pool;
let store: Store;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  // La base dédiée est créée par `infra/postgres/10-invite-tokens.sh` à l'initialisation
  // du volume ; le schéma l'est par le service à son démarrage.
  await pool.query(SCHEMA);
  await pool.query("TRUNCATE links CASCADE");
  store = createPostgresStore((text, params) => pool.query(text, params));
});

afterAll(async () => {
  await pool?.end();
});

const lien = (maxUses: number, tokenHash: string) =>
  store.create({
    tokenHash,
    issuer: BOB,
    kind: "friend",
    roomId: null,
    expiresAt: MAINTENANT + 86_400_000,
    maxUses,
  });

describe("la consommation est atomique contre un vrai PostgreSQL", () => {
  it("deux résolutions concurrentes du dernier usage : une seule réussit", async () => {
    await lien(1, "empreinte-dernier-usage");

    const [a, b] = await Promise.all([
      store.consume("empreinte-dernier-usage", "@a:tacita.test", MAINTENANT),
      store.consume("empreinte-dernier-usage", "@b:tacita.test", MAINTENANT),
    ]);

    expect([a, b].filter(Boolean), "les deux ont obtenu le dernier usage").toHaveLength(1);
    expect((a ?? b)!.usesLeft).toBe(0);
  });

  it("un lien multi-usages en sert exactement le nombre annoncé, même sous rafale", async () => {
    await lien(3, "empreinte-multi");

    const porteurs = Array.from({ length: 8 }, (_, n) => `@p${n}:tacita.test`);
    const issues = await Promise.all(
      porteurs.map((porteur) => store.consume("empreinte-multi", porteur, MAINTENANT)),
    );

    expect(issues.filter(Boolean)).toHaveLength(3);
  });

  it("le garde refuse l'émetteur et la répétition dans la même instruction", async () => {
    await lien(2, "empreinte-gardes");

    // son propre lien : rien n'est consommé.
    expect(await store.consume("empreinte-gardes", BOB, MAINTENANT)).toBeUndefined();

    // le même porteur deux fois : le second n'obtient rien de plus, et
    // `find` le voit comme une reprise.
    expect(await store.consume("empreinte-gardes", "@mira:tacita.test", MAINTENANT)).toBeDefined();
    expect(await store.consume("empreinte-gardes", "@mira:tacita.test", MAINTENANT)).toBeUndefined();

    const repris = await store.find("empreinte-gardes", "@mira:tacita.test", MAINTENANT);
    expect(repris).toMatchObject({ repeated: true, link: { usesLeft: 1 } });
  });

  it("l'expiration est comparée à l'horloge fournie par le serveur", async () => {
    await lien(1, "empreinte-expirée");

    expect(await store.find("empreinte-expirée", "@x:tacita.test", MAINTENANT + 86_400_001)).toBeUndefined();
    expect(await store.consume("empreinte-expirée", "@x:tacita.test", MAINTENANT + 86_400_001)).toBeUndefined();
  });
});
