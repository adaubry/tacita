import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MatrixReader } from "../src/matrix.ts";
import { createInviteService, createRateLimit } from "../src/server.ts";
import { createMemoryStore } from "./memory-store.ts";

const BOB = "@bob:tacita.test";
const MIRA = "@mira:tacita.test";
const SALON = "!groupe:tacita.test";

const matrix = {
  whoami: vi.fn(async (token: string) => ({ "jeton-bob": BOB, "jeton-mira": MIRA })[token]),
  ignores: vi.fn(async () => false),
  accountExists: vi.fn(async () => true),
  isMember: vi.fn(async () => true),
} satisfies MatrixReader;

let store: ReturnType<typeof createMemoryStore>;
let server: Server;
let base: string;
let journal: Record<string, unknown>[];

beforeEach(async () => {
  store = createMemoryStore();
  journal = [];
  server = createInviteService({
    store,
    matrix,
    log: (event) => journal.push(event),
    maxResolvesPerWindow: 3,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

const appel = async (
  method: string,
  path: string,
  options: { token?: string; body?: unknown; ip?: string } = {},
) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.ip ? { "x-forwarded-for": options.ip } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const texte = await response.text();
  return { status: response.status, body: texte ? (JSON.parse(texte) as never) : undefined };
};

const créer = async (body: unknown = { kind: "friend" }, token = "jeton-bob") =>
  (await appel("POST", "/links", { token, body })).body as unknown as {
    id: string;
    token: string;
    expiresAt: number;
  };

describe("POST /links, authentification obligatoire", () => {
  it("crée avec un jeton valide, refuse sans", async () => {
    expect((await appel("POST", "/links", { body: { kind: "friend" } })).status).toBe(401);

    const créé = await appel("POST", "/links", { token: "jeton-bob", body: { kind: "friend" } });
    expect(créé.status).toBe(201);
    expect(créé.body).toMatchObject({ token: expect.any(String), expiresAt: expect.any(Number) });
  });

  it("un corps illisible est un refus, pas un 500", async () => {
    const response = await fetch(`${base}/links`, {
      method: "POST",
      headers: { authorization: "Bearer jeton-bob", "content-type": "application/json" },
      body: "{ pas du json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errcode: "TACITA_BAD_JSON" });
  });
});

describe("GET /links ne rend que les liens de l'appelant", () => {
  it("chacun le sien", async () => {
    await créer();
    await créer({ kind: "friend" }, "jeton-mira");

    const bob = await appel("GET", "/links", { token: "jeton-bob" });
    expect(bob.body).toHaveLength(1);
    expect((await appel("GET", "/links", { token: "jeton-mira" })).body).toHaveLength(1);
  });
});

describe("DELETE /links/:id révoque", () => {
  it("204 pour le propriétaire, échec neutre pour un autre", async () => {
    const { id, token } = await créer();

    expect((await appel("DELETE", `/links/${id}`, { token: "jeton-mira" })).status).toBe(404);
    expect((await appel("DELETE", `/links/${id}`, { token: "jeton-bob" })).status).toBe(204);
    expect((await appel("POST", `/links/${token}/resolve`, { token: "jeton-mira" })).status).toBe(404);
  });
});

describe("POST /links/:token/resolve rend l'identifiant", () => {
  it("le porteur authentifié obtient kind, issuer et roomId", async () => {
    const { token } = await créer({ kind: "group", roomId: SALON });

    const résolu = await appel("POST", `/links/${token}/resolve`, { token: "jeton-mira" });
    expect(résolu.status).toBe(200);
    expect(résolu.body).toEqual({ kind: "group", issuer: BOB, roomId: SALON });
  });

  it("une route inconnue ne dit rien de plus qu'un 404", async () => {
    expect((await appel("GET", "/admin")).status).toBe(404);
    expect((await appel("GET", "/links/quelque-chose")).status).toBe(404);
  });
});

describe("limitation de débit par IP", () => {
  it("au-delà du budget, la même IP est refusée en 429 avant tout appel à Synapse", async () => {
    const { token } = await créer();
    matrix.whoami.mockClear();

    const essais = [];
    for (let n = 0; n < 5; n++) {
      essais.push(await appel("POST", `/links/inconnu-${n}/resolve`, { token, ip: "203.0.113.7" }));
    }

    expect(essais.filter((essai) => essai.status === 429)).toHaveLength(2);
    // Le budget se compte sur les **essais**, pas sur les succès : c'est ce qui permet
    // de voir qu'on essaie.
    expect(matrix.whoami).toHaveBeenCalledTimes(3);
  });

  it("une autre IP garde son propre budget", async () => {
    for (let n = 0; n < 4; n++) {
      await appel("POST", `/links/inconnu-${n}/resolve`, { ip: "203.0.113.7" });
    }
    expect((await appel("POST", "/links/x/resolve", { ip: "198.51.100.4" })).status).not.toBe(429);
  });

  /**
   * Relevé en pentest : `issue` n'était bridé par rien. Un compte authentifié pouvait
   * créer des liens en boucle et faire grossir `invite_tokens` sans fin — un déni de
   * service par la base, pas par le CPU, donc lent à voir et long à défaire.
   */
  it("la création de liens est plafonnée elle aussi, et sur son propre budget", async () => {
    const serveur = createInviteService({
      store: createMemoryStore(),
      matrix,
      maxResolvesPerWindow: 3,
      maxWritesPerWindow: 2,
    });
    await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", resolve));
    const adresse = `http://127.0.0.1:${(serveur.address() as AddressInfo).port}`;

    const poster = () =>
      fetch(`${adresse}/links`, {
        method: "POST",
        headers: {
          authorization: "Bearer jeton-bob",
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.9",
        },
        body: JSON.stringify({ kind: "friend" }),
      }).then((reponse) => reponse.status);

    const statuts = [await poster(), await poster(), await poster()];
    // Le budget d'écriture est distinct de celui de résolution : une rafale de
    // résolutions ne doit pas empêcher quelqu'un de créer son lien.
    const resolution = await fetch(`${adresse}/links/x/resolve`, {
      method: "POST",
      headers: { authorization: "Bearer jeton-bob", "x-forwarded-for": "203.0.113.9" },
    });
    await new Promise<void>((resolve) => serveur.close(() => resolve()));

    expect(statuts).toEqual([201, 201, 429]);
    expect(resolution.status).not.toBe(429);
  });

  it("la fenêtre se rouvre quand elle expire", () => {
    const limite = createRateLimit(2, 1_000);
    expect(limite("ip:1", 0)).toBe(true);
    expect(limite("ip:1", 10)).toBe(true);
    expect(limite("ip:1", 20)).toBe(false);
    expect(limite("ip:1", 1_100)).toBe(true);
  });
});

describe("aucun identifiant, aucun roomId, aucun token dans les logs", () => {
  it("le journal porte l'issue et le gabarit de route, jamais qui", async () => {
    const { id, token } = await créer({ kind: "group", roomId: SALON });
    await appel("POST", `/links/${token}/resolve`, { token: "jeton-mira" });
    await appel("DELETE", `/links/${id}`, { token: "jeton-bob" });
    await appel("POST", `/links/${token}/resolve`, { token: "jeton-inconnu" });

    expect(journal.length).toBeGreaterThan(3);
    const tout = JSON.stringify(journal);
    for (const secret of [token, id, BOB, MIRA, SALON, "jeton-bob"]) {
      expect(tout).not.toContain(secret);
    }

    // Ce qu'il porte, en revanche : de quoi voir ce qui se passe sans savoir à qui.
    expect(journal).toContainEqual({
      route: "POST /links/:token/resolve",
      status: 200,
      outcome: "resolved",
    });
    expect(journal).toContainEqual({
      route: "POST /links/:token/resolve",
      status: 401,
      outcome: "rejected",
    });
  });

  it("une panne interne ne renvoie pas non plus le détail au client", async () => {
    store.find = async () => {
      throw new Error(`base injoignable pour ${BOB}`);
    };
    const { token } = await créer();

    const réponse = await appel("POST", `/links/${token}/resolve`, { token: "jeton-mira" });
    expect(réponse).toEqual({ status: 500, body: { errcode: "TACITA_INTERNAL" } });
    expect(JSON.stringify(journal)).not.toContain(BOB);
  });
});
