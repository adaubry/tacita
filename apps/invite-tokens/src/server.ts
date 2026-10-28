import { createServer, type IncomingMessage } from "node:http";

import { issue, LinkError, list, resolve, revoke, type Deps } from "./links.ts";

/** Un corps de requête plus gros que ça n'est pas une demande de lien. */
const MAX_BODY = 8 * 1024;

/**
 * fenêtre fixe, en mémoire. Le budget est par clé : l'appelant en a une,
 * son IP une autre, et il faut passer les deux.
 *
 * ponytail: compteur local au processus. Deux répliques doublent le budget réel ;
 * passer sur une table PostgreSQL ou un Redis le jour où le service est répliqué —
 * ce qui n'arrive pas avec un cercle fermé de quelques dizaines de comptes.
 */
export function createRateLimit(max: number, windowMs: number) {
  const seen = new Map<string, { count: number; resetAt: number }>();

  return (key: string, now = Date.now()): boolean => {
    const slot = seen.get(key);
    if (!slot || slot.resetAt <= now) {
      seen.set(key, { count: 1, resetAt: now + windowMs });
      // La carte ne se vide jamais toute seule : on profite du passage pour retirer les
      // fenêtres closes, sinon une rafale d'IP distinctes la fait croître sans fin.
      if (seen.size > 10_000) {
        for (const [other, { resetAt }] of seen) if (resetAt <= now) seen.delete(other);
      }
      return true;
    }
    slot.count += 1;
    return slot.count <= max;
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new LinkError(413, "TACITA_BODY_TOO_LARGE");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    throw new LinkError(400, "TACITA_BAD_JSON");
  }
}

/** `Bearer <jeton>` — le jeton d'accès Matrix de l'appelant, jamais un identifiant. */
const accessToken = (req: IncomingMessage): string | undefined =>
  /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];

/**
 * Derrière le proxy de `infra`, qui est le seul chemin d'entrée : `X-Forwarded-For`
 * vient de lui. Le premier élément est le client d'origine.
 */
const clientIp = (req: IncomingMessage): string =>
  (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ||
  req.socket.remoteAddress ||
  "inconnue";

export interface ServerOptions extends Deps {
  /** essais de résolution autorisés par fenêtre, pour une IP comme pour un compte. */
  maxResolvesPerWindow?: number;
  /**
   * Écritures (création, révocation) autorisées par fenêtre et par IP.
   *
   * `issue` n'était pas plafonné du tout : un compte pouvait créer des liens sans fin et
   * gonfler la base `invite_tokens` — relevé en pentest. Plus large que la résolution :
   * créer un lien est un geste normal de l'usage, en énumérer n'en est pas un.
   */
  maxWritesPerWindow?: number;
  windowMs?: number;
  /** sortie des journaux ; injectable pour que le test puisse l'écouter. */
  log?: (event: Record<string, unknown>) => void;
}

export function createInviteService(options: ServerOptions) {
  const limit = createRateLimit(options.maxResolvesPerWindow ?? 20, options.windowMs ?? 60_000);
  // Deux compteurs et non un : partager le budget ferait qu'une rafale de résolutions
  // empêche quelqu'un de créer son lien, ce qui est exactement l'inverse du but.
  const writeLimit = createRateLimit(options.maxWritesPerWindow ?? 30, options.windowMs ?? 60_000);
  const deps: Deps = { ...options, limit };
  const log = options.log ?? ((event) => console.info("request", event));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://invite-tokens.internal");
    const segments = url.pathname.split("/").filter(Boolean);

    /**
     * le journal porte l'issue et le motif technique, **jamais qui** : ni
     * identifiant d'utilisateur, ni `roomId`, ni token. `route` est le gabarit et non
     * l'URL reçue — l'URL de résolution *contient* le token.
     */
    const answer = (route: string, status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      log({ route, status, outcome: status < 400 ? "resolved" : "rejected" });
    };

    const handle = async (route: string, work: () => Promise<[number, unknown]>) => {
      try {
        const [status, body] = await work();
        answer(route, status, body);
      } catch (error) {
        // Tout ce qui n'est pas une décision explicite du domaine est un 500 muet : un
        // message d'erreur brut porterait le contenu de la requête, donc son token.
        const known = error instanceof LinkError;
        answer(route, known ? error.status : 500, {
          errcode: known ? error.errcode : "TACITA_INTERNAL",
        });
      }
    };

    if (segments[0] !== "links") return answer("inconnue", 404, { errcode: "TACITA_UNKNOWN" });

    if (req.method === "POST" && segments.length === 1) {
      // Avant l'authentification, comme pour la résolution : sinon une rafale non
      // authentifiée coûte un appel à Synapse par essai.
      if (!writeLimit(`ip:${clientIp(req)}`)) {
        return answer("POST /links", 429, { errcode: "TACITA_RATE_LIMITED" });
      }
      return void handle("POST /links", async () => [
        201,
        await issue(deps, accessToken(req), (await readBody(req)) as Record<string, unknown>),
      ]);
    }

    if (req.method === "GET" && segments.length === 1) {
      return void handle("GET /links", async () => [200, await list(deps, accessToken(req))]);
    }

    if (req.method === "DELETE" && segments.length === 2) {
      if (!writeLimit(`ip:${clientIp(req)}`)) {
        return answer("DELETE /links/:id", 429, { errcode: "TACITA_RATE_LIMITED" });
      }
      return void handle("DELETE /links/:id", async () => {
        await revoke(deps, accessToken(req), segments[1]!);
        return [204, null];
      });
    }

    if (req.method === "POST" && segments.length === 3 && segments[2] === "resolve") {
      const route = "POST /links/:token/resolve";
      // la moitié « par IP » se paie avant l'authentification : sinon une
      // rafale non authentifiée coûte un appel à Synapse par essai.
      if (!limit(`ip:${clientIp(req)}`)) {
        return answer(route, 429, { errcode: "TACITA_RATE_LIMITED" });
      }
      return void handle(route, async () => [
        200,
        await resolve(deps, accessToken(req), decodeURIComponent(segments[1]!)),
      ]);
    }

    return answer("inconnue", 404, { errcode: "TACITA_UNKNOWN" });
  });
}
