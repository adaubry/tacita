import { describe, expect, it, vi } from "vitest";

import { createPostgresStore, SCHEMA, type Sql } from "../src/store.ts";

/** Un client PostgreSQL qui n'exécute rien : on regarde ce qu'on lui donne. */
function espion(rows: Record<string, unknown>[] = []) {
  const textes: string[] = [];
  const query: Sql = async (text) => {
    textes.push(text);
    return { rows };
  };
  return { query: vi.fn(query), textes: () => textes };
}

describe("la consommation est une seule instruction, garde compris", () => {
  /**
   * Pourquoi une assertion sur la **forme du SQL** plutôt que sur un comportement :
   * l'imitation en mémoire de la suite est monothread, donc atomique par construction —
   * elle confirmerait l'hypothèse au lieu de l'éprouver. Ce qui rend la consommation
   * atomique est la structure de l'instruction, et c'est elle qu'on garde.
   *
   * Le comportement concurrent réel ne se prouve que contre un vrai PostgreSQL ; c'est
   * dit dans le README.
   */
  it("un seul appel, un seul UPDATE, aucun SELECT préalable des usages", async () => {
    const { query, textes } = espion([
      { id: "l1", issuer: "@bob:tacita.test", kind: "friend", room_id: null, expires_at: "1", uses_left: "0" },
    ]);

    await createPostgresStore(query).consume("empreinte", "@mira:tacita.test", 1_000);

    expect(textes()).toHaveLength(1);
    const sql = textes()[0]!;
    expect(sql.match(/UPDATE links/g)).toHaveLength(1);
    // Le garde vit dans le `WHERE` de l'`UPDATE` : PostgreSQL le réévalue après avoir
    // pris le verrou de ligne. Le porter dans le code appelant rouvrirait la course.
    expect(sql).toMatch(/uses_left = uses_left - 1/);
    expect(sql).toMatch(/uses_left > 0/);
    expect(sql).toMatch(/RETURNING/);
    // Un `SELECT … FROM links` suivi d'un `UPDATE` serait le motif à bannir.
    expect(sql).not.toMatch(/SELECT[\s\S]*FROM links[\s\S]*UPDATE/i);
  });

  it("les trois causes d'invalidité sont dans le même garde que le décrément", async () => {
    const { query, textes } = espion();
    await createPostgresStore(query).consume("empreinte", "@mira:tacita.test", 1_000);

    const sql = textes()[0]!;
    expect(sql).toMatch(/NOT revoked/);
    expect(sql).toMatch(/expires_at > \$3/); // l'horloge du serveur
    expect(sql).toMatch(/issuer <> \$2/); // jamais son propre lien
    expect(sql).toMatch(/link_resolutions/); // jamais deux fois le même porteur
  });

  it("rien n'est rendu quand aucune ligne n'a été décrémentée", async () => {
    const { query } = espion([]);
    expect(await createPostgresStore(query).consume("empreinte", "@mira:tacita.test", 1)).toBeUndefined();
  });
});

describe("le schéma est la liste de ce que le service sait", () => {
  it("aucune colonne de nom d'affichage, de libellé ni de contenu", () => {
    expect(SCHEMA).toMatch(/token_hash/);
    expect(SCHEMA).not.toMatch(/display_?name|avatar|topic|label|body|content|message/i);
  });

  it("le token n'a de place que hachée", () => {
    // Une colonne `token` en clair rendrait fausse sans casser un seul test
    // de comportement : c'est le genre de régression qu'un test de forme attrape.
    expect(SCHEMA).not.toMatch(/^\s*token\s+text/m);
  });

  it("l'unicité (lien, porteur) est ce qui porte l'idempotence de", () => {
    expect(SCHEMA).toMatch(/PRIMARY KEY \(link_id, bearer\)/);
  });

  it("la purge ne retire que les lignes expirées", async () => {
    const { query, textes } = espion();
    await createPostgresStore(query).purge(1_000);

    expect(textes()[0]).toMatch(/DELETE FROM links WHERE expires_at <= \$1/);
    // Un lien épuisé mais valide reste : il porte la reprise idempotente du porteur.
    expect(textes()[0]).not.toMatch(/uses_left/);
  });
});

describe("la liste est filtrée par émetteur en base, pas en mémoire", () => {
  it("le WHERE porte l'émetteur : tout filtrer côté service enverrait les liens des autres sur le réseau", async () => {
    const { query, textes } = espion();
    await createPostgresStore(query).listByIssuer("@bob:tacita.test", 1_000);

    expect(textes()[0]).toMatch(/WHERE issuer = \$1/);
  });
});
