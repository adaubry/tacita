import { readdirSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TTL_SECONDS,
  issue,
  LinkError,
  list,
  MAX_TTL_SECONDS,
  resolve,
  revoke,
  type Deps,
} from "../src/links.ts";
import type { MatrixReader } from "../src/matrix.ts";
import { createMemoryStore } from "./memory-store.ts";

const BOB = "@bob:tacita.test";
const MIRA = "@mira:tacita.test";
const SALON = "!groupe:tacita.test";
const MAINTENANT = 1_800_000_000_000;

/** Ce que le service exécute, commentaires retirés — le dossier, pas une liste de fichiers. */
function codeDuService(): string {
  const src = new URL("../src/", import.meta.url);
  return readdirSync(src)
    .filter((nom) => nom.endsWith(".ts"))
    .map((nom) => readFileSync(new URL(nom, src), "utf-8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Deux comptes vivants, personne d'ignoré : le cas nominal, que chaque test dévie. */
function fakeMatrix(jetons: Record<string, string> = { "jeton-bob": BOB, "jeton-mira": MIRA }) {
  return {
    whoami: vi.fn(async (token: string) => jetons[token]),
    // Signatures explicites : sans elles, `mock.calls` est un tuple vide et un test qui
    // inspecte les arguments ne compile pas — ici, celui qui garde.
    ignores: vi.fn(async (_accessToken: string, _self: string, _other: string) => false),
    accountExists: vi.fn(async (_accessToken: string, _userId: string) => true),
    isMember: vi.fn(async (_accessToken: string, _roomId: string) => true),
  } satisfies MatrixReader;
}

let store: ReturnType<typeof createMemoryStore>;
let matrix: ReturnType<typeof fakeMatrix>;
let deps: Deps;

beforeEach(() => {
  store = createMemoryStore();
  matrix = fakeMatrix();
  deps = { store, matrix, now: () => MAINTENANT };
});

const lienAmi = () => issue(deps, "jeton-bob", { kind: "friend" });

/** L'échec de résolution, quelle qu'en soit la cause. */
const échec = async (promesse: Promise<unknown>) => {
  const error = await promesse.catch((raison: unknown) => raison);
  expect(error).toBeInstanceOf(LinkError);
  return error as LinkError;
};

describe("POST /links crée un lien, authentifié auprès de Synapse", () => {
  it("l'identité vient de whoami, jamais du corps de la requête", async () => {
    const { id } = await issue(deps, "jeton-bob", { kind: "friend", issuer: MIRA } as never);

    expect(matrix.whoami).toHaveBeenCalledWith("jeton-bob");
    expect(store.rows.get(id)!.issuer).toBe(BOB);
  });

  it("sans jeton valide, rien n'est créé", async () => {
    expect((await échec(issue(deps, undefined, { kind: "friend" }))).status).toBe(401);
    expect((await échec(issue(deps, "jeton-inconnu", { kind: "friend" }))).status).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  it("un usage et un jour par défaut", async () => {
    const { id, expiresAt } = await lienAmi();

    expect(store.rows.get(id)!.usesLeft).toBe(1);
    expect(expiresAt).toBe(MAINTENANT + DEFAULT_TTL_SECONDS * 1_000);
  });

  it("un lien de groupe porte son salon, un lien d'ami n'en porte aucun", async () => {
    const groupe = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });
    expect(store.rows.get(groupe.id)!.roomId).toBe(SALON);

    const ami = await lienAmi();
    expect(store.rows.get(ami.id)!.roomId).toBeNull();
  });

  it("un lien de groupe exige que l'émetteur soit membre du salon", async () => {
    // Relevé en pentest : un compte quelconque émettait un lien pour un salon étranger.
    matrix.isMember.mockResolvedValue(false);
    const erreur = await échec(issue(deps, "jeton-bob", { kind: "group", roomId: SALON }));

    expect(erreur.errcode).toBe("TACITA_BAD_ROOM");
    expect(matrix.isMember).toHaveBeenCalledWith("jeton-bob", SALON);
    expect(store.rows.size).toBe(0);
  });

  it("refuse plutôt que de corriger en silence : kind, roomId, maxUses, ttl", async () => {
    const refus = async (request: Record<string, unknown>) =>
      (await échec(issue(deps, "jeton-bob", request))).errcode;

    expect(await refus({})).toBe("TACITA_BAD_KIND");
    expect(await refus({ kind: "ami" })).toBe("TACITA_BAD_KIND");
    expect(await refus({ kind: "group" })).toBe("TACITA_BAD_ROOM");
    expect(await refus({ kind: "friend", maxUses: 0 })).toBe("TACITA_BAD_USES");
    expect(await refus({ kind: "friend", maxUses: 1.5 })).toBe("TACITA_BAD_USES");
    // Un TTL au-delà du plafond est refusé, pas rogné : un lien qui dure moins que
    // demandé se découvre au pire moment.
    expect(await refus({ kind: "friend", ttlSeconds: MAX_TTL_SECONDS + 1 })).toBe("TACITA_BAD_TTL");
    expect(store.rows.size).toBe(0);
  });
});

describe("token opaque, aléatoire, stocké haché", () => {
  it("256 bits de CSPRNG, jamais deux fois le même", async () => {
    const tokens = new Set<string>();
    for (let n = 0; n < 50; n++) tokens.add((await lienAmi()).token);

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      expect(token).toMatch(/^[\w-]+$/); // base64url : rien à échapper dans une URL
    }
  });

  it("la base ne contient jamais le token en clair", async () => {
    const { token, id } = await lienAmi();
    const stocké = store.rows.get(id)!;

    expect(stocké.tokenHash).not.toBe(token);
    expect(JSON.stringify(stocké)).not.toContain(token);
    expect(stocké.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("le token reste résolvable : c'est son empreinte qui est comparée", async () => {
    const { token } = await lienAmi();
    await expect(resolve(deps, "jeton-mira", token)).resolves.toMatchObject({ kind: "friend" });
  });
});

describe("un lien ne révèle rien avant résolution authentifiée", () => {
  it("la réponse de création ne porte ni émetteur, ni salon, ni libellé", async () => {
    const créé = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });

    expect(Object.keys(créé).sort()).toEqual(["expiresAt", "id", "token"]);
    const sérialisé = JSON.stringify(créé);
    expect(sérialisé).not.toContain(BOB);
    expect(sérialisé).not.toContain(SALON);
  });

  it("le token lui-même n'encode rien : un lien qui fuite ne dit pas qui invite qui", async () => {
    const { token } = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });
    const décodé = Buffer.from(token, "base64url").toString("latin1");

    expect(décodé).not.toContain("bob");
    expect(décodé).not.toContain("groupe");
    expect(décodé).not.toContain("tacita");
  });
});

describe("GET /links liste les liens de l'émetteur, jamais ceux d'un autre", () => {
  it("chacun ne voit que les siens", async () => {
    await lienAmi();
    await issue(deps, "jeton-mira", { kind: "friend" });

    expect(await list(deps, "jeton-bob")).toHaveLength(1);
    expect(await list(deps, "jeton-mira")).toHaveLength(1);
    expect((await list(deps, "jeton-bob"))[0]!.id).not.toBe((await list(deps, "jeton-mira"))[0]!.id);
  });

  it("kind, salon, expiration et usages restants — et rien de plus", async () => {
    await issue(deps, "jeton-bob", { kind: "group", roomId: SALON, maxUses: 3 });
    const [lien] = await list(deps, "jeton-bob");

    expect(Object.keys(lien!).sort()).toEqual(["expiresAt", "id", "kind", "roomId", "usesLeft"]);
    expect(lien).toMatchObject({ kind: "group", roomId: SALON, usesLeft: 3 });
  });

  /**
   * Le salon est ce qui permet au panneau de liens d'un groupe de reconnaître les siens.
   * Sans lui il les confondait avec ceux des autres groupes du même émetteur, et son sas
   * d'entrée suivait alors des liens qui menaient ailleurs — ouvert sans lien propre,
   * laissé ouvert après la révocation du dernier. Il ne fuite rien : l'appelant est
   * l'émetteur, on ne lui rend que ce qu'il a demandé lui-même.
   */
  it("le salon accompagne un lien de groupe, et rien n'accompagne un lien d'ami", async () => {
    await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });
    await lienAmi();

    const liens = await list(deps, "jeton-bob");
    expect(liens.find((lien) => lien.kind === "group")!.roomId).toBe(SALON);
    // Absente, pas nulle : la même forme que la résolution, pour qu'un `=== roomId` côté
    // client ne puisse jamais être vrai par accident.
    const ami = liens.find((lien) => lien.kind === "friend")!;
    expect("roomId" in ami).toBe(false);
  });

  it("un lien révoqué ou expiré n'est plus actif", async () => {
    const { id } = await lienAmi();
    await revoke(deps, "jeton-bob", id);
    expect(await list(deps, "jeton-bob")).toEqual([]);

    await issue(deps, "jeton-bob", { kind: "friend", ttlSeconds: 60 });
    deps = { ...deps, now: () => MAINTENANT + 61_000 };
    expect(await list(deps, "jeton-bob")).toEqual([]);
  });
});

describe("DELETE /links/:id révoque immédiatement", () => {
  it("le lien révoqué ne se résout plus", async () => {
    const { id, token } = await lienAmi();
    await revoke(deps, "jeton-bob", id);

    expect((await échec(resolve(deps, "jeton-mira", token))).status).toBe(404);
  });

  it("le lien d'un autre est traité comme inexistant", async () => {
    const { id, token } = await lienAmi();

    expect((await échec(revoke(deps, "jeton-mira", id))).errcode).toBe("TACITA_LINK_INVALID");
    expect((await échec(revoke(deps, "jeton-mira", "lien-inexistant"))).errcode).toBe(
      "TACITA_LINK_INVALID",
    );
    // Et le lien de Bob est intact : le refus n'a rien touché.
    await expect(resolve(deps, "jeton-mira", token)).resolves.toBeDefined();
  });
});

describe("la résolution rend un identifiant, et le service s'arrête là", () => {
  it("rend kind et issuer, plus roomId pour un lien de groupe", async () => {
    const ami = await lienAmi();
    expect(await resolve(deps, "jeton-mira", ami.token)).toEqual({ kind: "friend", issuer: BOB });

    const groupe = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });
    expect(await resolve(deps, "jeton-mira", groupe.token)).toEqual({
      kind: "group",
      issuer: BOB,
      roomId: SALON,
    });
  });

  it("aucune invitation n'est émise : le service ne fait aucune écriture Matrix", async () => {
    const { token } = await lienAmi();
    await resolve(deps, "jeton-mira", token);

    // Les seuls appels Matrix du service sont des lectures faites au nom de l'appelant.
    expect(Object.keys(matrix)).toEqual(["whoami", "ignores", "accountExists", "isMember"]);
  });

  it("sans jeton valide, aucune résolution — et aucun usage consommé", async () => {
    const { token, id } = await lienAmi();

    expect((await échec(resolve(deps, undefined, token))).status).toBe(401);
    expect(store.rows.get(id)!.usesLeft).toBe(1);
  });
});

describe("la consommation est atomique", () => {
  it("deux résolutions concurrentes du dernier usage : une seule réussit", async () => {
    const { token, id } = await issue(deps, "jeton-bob", { kind: "friend", maxUses: 1 });
    const autres = fakeMatrix({ "jeton-a": "@a:tacita.test", "jeton-b": "@b:tacita.test" });
    const concurrents: Deps = { ...deps, matrix: autres };

    const issues = await Promise.allSettled([
      resolve(concurrents, "jeton-a", token),
      resolve(concurrents, "jeton-b", token),
    ]);

    // `find` puis `consume` : les deux voient un usage disponible, un seul l'obtient.
    expect(issues.filter((issue) => issue.status === "fulfilled")).toHaveLength(1);
    expect(store.rows.get(id)!.usesLeft).toBe(0);
  });

  it("un lien multi-usages en sert exactement le nombre annoncé", async () => {
    const { token, id } = await issue(deps, "jeton-bob", { kind: "friend", maxUses: 2 });
    const porteurs = fakeMatrix({ a: "@a:tacita.test", b: "@b:tacita.test", c: "@c:tacita.test" });
    const trois: Deps = { ...deps, matrix: porteurs };

    const issues = await Promise.allSettled(
      ["a", "b", "c"].map((jeton) => resolve(trois, jeton, token)),
    );

    expect(issues.filter((issue) => issue.status === "fulfilled")).toHaveLength(2);
    expect(store.rows.get(id)!.usesLeft).toBe(0);
  });
});

describe("un seul message d'échec pour trois causes", () => {
  it("inconnu, expiré et révoqué rendent strictement la même chose", async () => {
    const inconnu = await échec(resolve(deps, "jeton-mira", "jamais-émis"));

    const { id, token: révoqué } = await lienAmi();
    await revoke(deps, "jeton-bob", id);
    const révocation = await échec(resolve(deps, "jeton-mira", révoqué));

    const { token: périmé } = await issue(deps, "jeton-bob", { kind: "friend", ttlSeconds: 60 });
    const plusTard: Deps = { ...deps, now: () => MAINTENANT + 61_000 };
    const expiration = await échec(resolve(plusTard, "jeton-mira", périmé));

    for (const cas of [révocation, expiration]) {
      expect(cas.status).toBe(inconnu.status);
      expect(cas.errcode).toBe(inconnu.errcode);
    }
    expect(inconnu.status).toBe(404);
  });

  it("l'épuisement des usages se confond avec les trois autres", async () => {
    const { token } = await lienAmi();
    await resolve(deps, "jeton-mira", token);

    const suivant = { ...deps, matrix: fakeMatrix({ "jeton-x": "@x:tacita.test" }) };
    expect((await échec(resolve(suivant, "jeton-x", token))).errcode).toBe("TACITA_LINK_INVALID");
  });
});

describe("limitation de débit sur la résolution, par compte", () => {
  it("au-delà du budget, la résolution est refusée sans toucher à la base", async () => {
    const { token, id } = await lienAmi();
    const budget = vi.fn((clé: string) => clé !== `compte:${MIRA}`);

    const bridé: Deps = { ...deps, limit: budget };
    expect((await échec(resolve(bridé, "jeton-mira", token))).status).toBe(429);
    expect(store.rows.get(id)!.usesLeft).toBe(1);
    expect(budget).toHaveBeenCalledWith(`compte:${MIRA}`);
  });
});

describe("porteur sans compte : aucun usage consommé", () => {
  it("répond avant même de regarder le token : il ne peut pas être consommé", async () => {
    const { token, id } = await lienAmi();
    const sansCompte = { ...deps, matrix: fakeMatrix({}) };

    const erreur = await échec(resolve(sansCompte, "jeton-sans-compte", token));
    expect(erreur.status).toBe(401);
    // Le service ne peut pas distinguer « pas de compte » de « déconnecté » — c'est
    // l'UI qui choisit entre le login OIDC et l'écran d'explication.
    expect(erreur.errcode).toBe("TACITA_AUTH_REQUIRED");
    expect(store.rows.get(id)!.usesLeft).toBe(1);
  });
});

describe("porteur déconnecté : le token n'est consommé qu'après authentification", () => {
  it("le même lien reste résolvable une fois le porteur authentifié", async () => {
    const { token, id } = await lienAmi();

    expect((await échec(resolve(deps, undefined, token))).status).toBe(401);
    expect(store.rows.get(id)!.usesLeft).toBe(1);

    // Après le détour par OIDC, le lien vaut toujours : il a survécu à la redirection
    // parce que rien n'a été consommé entre-temps.
    await expect(resolve(deps, "jeton-mira", token)).resolves.toMatchObject({ issuer: BOB });
    expect(store.rows.get(id)!.usesLeft).toBe(0);
  });
});

describe("le porteur est l'émetteur", () => {
  it("refus explicite, aucun DM avec soi-même, aucun usage consommé", async () => {
    const { token, id } = await lienAmi();

    const erreur = await échec(resolve(deps, "jeton-bob", token));
    expect(erreur.errcode).toBe("TACITA_OWN_LINK");
    expect(store.rows.get(id)!.usesLeft).toBe(1);
  });
});

describe("lien déjà résolu par ce porteur : succès idempotent", () => {
  it("la reprise rend le même résultat et ne consomme aucun usage de plus", async () => {
    const { token, id } = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });

    const premier = await resolve(deps, "jeton-mira", token);
    expect(store.rows.get(id)!.usesLeft).toBe(0);

    // Le lien est épuisé pour tout le monde — sauf pour qui l'a déjà résolu : ce n'est
    // pas une erreur, le client rouvre la conversation existante.
    expect(await resolve(deps, "jeton-mira", token)).toEqual(premier);
    expect(store.rows.get(id)!.usesLeft).toBe(0);
  });
});

describe("l'un des deux a bloqué l'autre", () => {
  it("le service ne lit que la liste d'ignorés de l'appelant, jamais celle de l'émetteur", async () => {
    // Le sens émetteur → porteur est hors de portée : cette liste n'est lisible qu'avec
    // les droits de l'émetteur, que `invite-tokens` refuse au service. Il est tenu par Matrix
    // lui-même, côté client. Ce test garde la frontière : chercher à le vérifier ici
    // supposerait un pouvoir Matrix, et c'est exactement ce qu'on a refusé.
    const { token } = await lienAmi();
    await resolve(deps, "jeton-mira", token);

    for (const [jeton, soi] of matrix.ignores.mock.calls) {
      expect([jeton, soi]).toEqual(["jeton-mira", MIRA]);
    }
  });

  it("le même échec neutre : un blocage ne s'annonce pas", async () => {
    const { token, id } = await lienAmi();
    matrix.ignores.mockResolvedValue(true);

    const erreur = await échec(resolve(deps, "jeton-mira", token));
    expect(erreur.errcode).toBe("TACITA_LINK_INVALID");
    expect(erreur.status).toBe(404);
    // Rien ne distingue ce refus d'un lien inexistant, y compris le compteur d'usages.
    expect(store.rows.get(id)!.usesLeft).toBe(1);
    expect(matrix.ignores).toHaveBeenCalledWith("jeton-mira", MIRA, BOB);
  });
});

describe("émetteur disparu", () => {
  it("compte désactivé : lien invalide, même réponse neutre", async () => {
    const { token } = await lienAmi();
    matrix.accountExists.mockResolvedValue(false);

    expect((await échec(resolve(deps, "jeton-mira", token))).errcode).toBe("TACITA_LINK_INVALID");
  });

  it("« salon quitté » n'est pas vérifié, et rien n'essaie de l'être", async () => {
    // Limite assumée : le lire supposerait l'état d'un
    // salon dont ni le service ni le porteur ne sont membres. Un lien de groupe reste
    // donc résolvable, et c'est le parcours d'invitation côté client qui échouera.
    const { token } = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });
    await expect(resolve(deps, "jeton-mira", token)).resolves.toMatchObject({ roomId: SALON });

    // Le garde : personne n'ajoute discrètement une lecture d'état de salon — elle
    // demanderait des droits Matrix, et c'est un amendement de spec, pas un correctif.
    // `joined_rooms` en est sorti : c'est la liste de l'appelant lui-même,
    // lue avec son jeton à l'émission, pas l'état d'un salon.
    expect(codeDuService()).not.toMatch(/joined_members|\/state\/|\/rooms\//);
  });

  it("vérifié à chaque résolution, jamais mis en cache", async () => {
    const { token, id } = await issue(deps, "jeton-bob", { kind: "friend", maxUses: 2 });
    const porteurs = fakeMatrix({ a: "@a:tacita.test", b: "@b:tacita.test" });
    const surveillé: Deps = { ...deps, matrix: porteurs };

    await resolve(surveillé, "a", token);
    porteurs.accountExists.mockResolvedValue(false); // le compte disparaît entre les deux
    expect((await échec(resolve(surveillé, "b", token))).errcode).toBe("TACITA_LINK_INVALID");

    expect(porteurs.accountExists).toHaveBeenCalledTimes(2);
    expect(store.rows.get(id)!.usesLeft).toBe(1); // le second n'a rien consommé
  });
});

describe("expiration vérifiée contre l'horloge du serveur", () => {
  it("une date fournie par le client est ignorée", async () => {
    const { id } = await issue(deps, "jeton-bob", {
      kind: "friend",
      ttlSeconds: 60,
      expiresAt: MAINTENANT + 10 * 365 * 86_400_000,
    } as never);

    expect(store.rows.get(id)!.expiresAt).toBe(MAINTENANT + 60_000);
  });

  it("le plafond de sept jours est celui du serveur", async () => {
    const { expiresAt } = await issue(deps, "jeton-bob", { kind: "friend", ttlSeconds: MAX_TTL_SECONDS });
    expect(expiresAt).toBe(MAINTENANT + MAX_TTL_SECONDS * 1_000);
  });
});

describe("stockage minimal, lignes expirées purgées", () => {
  it("la ligne ne porte que ce que la spec autorise", async () => {
    const { id } = await issue(deps, "jeton-bob", { kind: "group", roomId: SALON });

    expect(Object.keys(store.rows.get(id)!).sort()).toEqual([
      "expiresAt",
      "id",
      "issuer",
      "kind",
      "revoked",
      "roomId",
      "tokenHash",
      "usesLeft",
    ]);
  });

  it("un lien expiré ne survit pas à la purge, un lien épuisé mais valide si", async () => {
    const { token } = await lienAmi(); // un usage, un jour
    await resolve(deps, "jeton-mira", token);
    await issue(deps, "jeton-bob", { kind: "friend", ttlSeconds: 60 });

    expect(await store.purge(MAINTENANT + 61_000)).toBe(1);
    // Celui qui reste est le lien épuisé : c'est lui qui porte l'idempotence de
    // l'effacer ferait échouer la reprise du porteur.
    expect(await resolve(deps, "jeton-mira", token)).toMatchObject({ issuer: BOB });
  });
});
