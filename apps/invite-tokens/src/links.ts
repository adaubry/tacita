/**
 * Les liens d'invitation : émettre, lister, révoquer.
 *
 * Un lien sert à **se relier** à quelqu'un, jamais à créer un compte — les deux n'ont
 * jamais été le même objet. `DEFAULT_MAX_USES`, `DEFAULT_TTL_SECONDS` et
 * `MAX_TTL_SECONDS` bornent ce qu'un lien peut porter ; `LinkError` nomme les refus,
 * pour que l'appelant les distingue d'une panne.
 */
import type { MatrixReader } from "./matrix.ts";
import type { Link, LinkKind, Store } from "./store.ts";
import { hashToken, mintToken } from "./tokens.ts";

/** un usage, un jour, sept jours au plus. */
export const DEFAULT_MAX_USES = 1;
export const DEFAULT_TTL_SECONDS = 86_400;
export const MAX_TTL_SECONDS = 604_800;

export interface Deps {
  store: Store;
  matrix: MatrixReader;
  /** l'horloge du serveur, jamais une date venue du client. */
  now?: () => number;
  /**
   * limitation par **compte appelant** ; l'autre moitié, par IP, est
   * appliquée par le serveur avant même l'authentification. Rend `false` quand le
   * budget est épuisé. Ici et pas dans le serveur : le compte n'est connu qu'après
   * `whoami`, et le refaire pour le limiteur doublerait l'appel à Synapse.
   */
  limit?: (key: string) => boolean;
}

/**
 * L'échec, tel qu'il sort du service. `status` et `errcode` seuls : pas de champ libre,
 * donc pas de détail qui distinguerait deux causes que veut confondre.
 */
export class LinkError extends Error {
  readonly status: number;
  readonly errcode: string;

  /**
   * Champs déclarés puis affectés, et **non** des propriétés de paramètre
   * (`constructor(readonly status: number)`). Le service tourne sous
   * `node --experimental-strip-types`, qui retire les types sans les transformer : une
   * propriété de paramètre est une construction qui *génère* du code, et Node refuse de
   * démarrer dessus. Les tests ne l'attrapent pas — Vitest transpile pour de bon.
   */
  constructor(status: number, errcode: string) {
    super(errcode);
    this.status = status;
    this.errcode = errcode;
  }
}

/**
 * **le seul** échec de résolution. Token inconnu, expiré, révoqué, épuisé,
 * émetteur disparu, blocage : une réponse, un corps, un code. Distinguer les causes
 * permettrait de sonder l'existence d'un token et, pour le blocage, de confirmer au
 * bloqué qu'il l'est. L'UI dit « ce lien n'est plus valide » et propose d'en redemander.
 */
const invalide = () => new LinkError(404, "TACITA_LINK_INVALID");

/**
 * pas de jeton valide, donc pas de compte **ou** pas encore authentifié.
 * Le service ne peut pas distinguer les deux, et n'a pas à le faire : il répond avant
 * toute lecture de token, donc aucun usage n'est consommé, et l'UI mène à
 * l'écran de connexion, où l'on se connecte ou l'on crée son compte. Ce service, lui,
 * n'en crée aucun — depuis D-13 c'est le formulaire qui s'en charge, sans code
 * d'invitation.
 */
const authRequise = () => new LinkError(401, "TACITA_AUTH_REQUIRED");

async function caller(deps: Deps, accessToken: string | undefined): Promise<string> {
  const userId = accessToken && (await deps.matrix.whoami(accessToken));
  if (!userId) throw authRequise();
  return userId;
}

const clock = (deps: Deps) => deps.now ?? Date.now;

export interface IssueRequest {
  kind?: unknown;
  roomId?: unknown;
  maxUses?: unknown;
  ttlSeconds?: unknown;
}

/** création. Tout ce qui n'est pas conforme est refusé, pas corrigé en silence. */
export async function issue(
  deps: Deps,
  accessToken: string | undefined,
  request: IssueRequest,
): Promise<{ id: string; token: string; expiresAt: number }> {
  const issuer = await caller(deps, accessToken);

  const kind = request.kind;
  if (kind !== "friend" && kind !== "group") throw new LinkError(400, "TACITA_BAD_KIND");

  const roomId = kind === "group" ? request.roomId : null;
  if (kind === "group" && typeof roomId !== "string") throw new LinkError(400, "TACITA_BAD_ROOM");
  // Même refus qu'un salon mal formé : ne pas confirmer l'existence d'un salon étranger.
  if (kind === "group" && !(await deps.matrix.isMember(accessToken!, roomId as string))) {
    throw new LinkError(400, "TACITA_BAD_ROOM");
  }

  const maxUses = request.maxUses ?? DEFAULT_MAX_USES;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1) {
    throw new LinkError(400, "TACITA_BAD_USES");
  }

  const ttl = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  // le plafond est appliqué ici, sur l'horloge du serveur. Un TTL au-delà
  // est refusé plutôt que rogné : un lien qui dure moins que ce qu'on a demandé se
  // découvre au pire moment.
  if (typeof ttl !== "number" || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new LinkError(400, "TACITA_BAD_TTL");
  }

  const token = mintToken();
  const link = await deps.store.create({
    tokenHash: hashToken(token),
    issuer,
    kind,
    roomId: (roomId as string | null) ?? null,
    expiresAt: clock(deps)() + ttl * 1_000,
    maxUses,
  });

  // le porteur ne reçoit que l'opaque et sa date : ni émetteur, ni salon,
  // ni libellé. Un lien qui fuite ne dit pas qui invite qui.
  return { id: link.id, token, expiresAt: link.expiresAt };
}

export interface LinkSummary {
  id: string;
  kind: LinkKind;
  /**
   * Le salon d'un lien `group`, comme dans `Resolution`. **Il ne fuite rien** : l'appelant
   * est l'émetteur, on ne lui apprend que ce qu'il a demandé lui-même. Sans lui, le
   * panneau de liens d'un groupe ne pouvait pas distinguer les siens de ceux des autres
   * groupes du même émetteur — il ouvrait donc le sas d'un salon sur la foi d'un lien qui
   * menait ailleurs, et ne le refermait pas quand il fallait.
   */
  roomId?: string;
  expiresAt: number;
  usesLeft: number;
}

/** les liens actifs de l'appelant, jamais ceux d'un autre. */
export async function list(deps: Deps, accessToken: string | undefined): Promise<LinkSummary[]> {
  const issuer = await caller(deps, accessToken);
  const links = await deps.store.listByIssuer(issuer, clock(deps)());
  return links.map(({ id, kind, roomId, expiresAt, usesLeft }) => ({
    id,
    kind,
    expiresAt,
    usesLeft,
    // Même forme que `rendu()` : la clé est absente sur un lien `friend`, jamais nulle.
    ...(kind === "group" && roomId ? { roomId } : {}),
  }));
}

/** révocation immédiate. Le lien d'un autre est traité comme inexistant. */
export async function revoke(
  deps: Deps,
  accessToken: string | undefined,
  id: string,
): Promise<void> {
  const issuer = await caller(deps, accessToken);
  if (!(await deps.store.revoke(id, issuer))) throw invalide();
}

export interface Resolution {
  kind: LinkKind;
  issuer: string;
  roomId?: string;
}

const rendu = (link: Link): Resolution => ({
  kind: link.kind,
  issuer: link.issuer,
  ...(link.kind === "group" && link.roomId ? { roomId: link.roomId } : {}),
});

/**
 * **le service s'arrête à l'identifiant.** Il n'émet aucune invitation, ne
 * joint aucun salon, ne crée rien : c'est le client qui invite ensuite, par le chemin
 * natif de D-09. Un service compromis peut mentir sur un identifiant ; il ne peut rien
 * envoyer, joindre ni lire.
 */
export async function resolve(
  deps: Deps,
  accessToken: string | undefined,
  token: string,
): Promise<Resolution> {
  const bearer = await caller(deps, accessToken);
  // un service qui ne compte pas ses échecs n'a aucun moyen de voir qu'on
  // l'essaie. Compté avant toute lecture de la base : un essai reste un essai.
  if (deps.limit && !deps.limit(`compte:${bearer}`)) throw new LinkError(429, "TACITA_RATE_LIMITED");

  const now = clock(deps)();
  const hash = hashToken(token);

  // Lecture d'abord : les refus de à ne doivent consommer aucun
  // usage. La consommation, elle, reste une instruction atomique.
  const found = await deps.store.find(hash, bearer, now);
  if (!found) throw invalide();

  // le porteur est l'émetteur. Message explicite : lui seul peut déclencher
  // ce cas, et il connaît déjà son propre lien, donc rien ne fuite.
  if (found.link.issuer === bearer) throw new LinkError(400, "TACITA_OWN_LINK");

  // un blocage ne s'annonce pas : le dire confirmerait au bloqué qu'il
  // l'est. pour l'autre sens, que le service ne peut pas connaître.
  if (await deps.matrix.ignores(accessToken!, bearer, found.link.issuer)) throw invalide();

  // émetteur disparu. Vérifié à chaque résolution, jamais mis en cache : un
  // compte désactivé hier ne doit pas rester valide parce qu'il l'était avant-hier.
  if (!(await deps.matrix.accountExists(accessToken!, found.link.issuer))) throw invalide();

  // ce porteur a déjà résolu ce lien : succès idempotent, aucun usage de
  // plus. Ce n'est pas une erreur, le client rouvre simplement la conversation.
  if (found.repeated) return rendu(found.link);

  const consumed = await deps.store.consume(hash, bearer, now);
  // Usages épuisés, ou dernier usage perdu au profit d'une résolution concurrente : même
  // échec neutre que tout le reste.
  if (!consumed) throw invalide();
  return rendu(consumed);
}
