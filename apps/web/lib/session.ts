import type { Session } from "@tacita/client-core";

/**
 * L'état d'entrée dans l'app, tel que l'UI a besoin de le connaître. Rien de plus :
 * la logique vit dans `client-core` (spec 04), le shard ne fait que router dessus.
 */
export type EtatSession =
  | { phase: "chargement" }
  /**
   * La reprise de session n'a ni abouti ni échoué dans le délai imparti — typiquement
   * une connexion IndexedDB qu'iOS a laissée pendante après une suspension de la PWA
   * (ni `onsuccess`, ni `onerror`). L'écran de chargement ne doit jamais rester bloqué :
   * on propose de réessayer plutôt que de tourner à l'infini.
   */
  | { phase: "echec" }
  /** Aucune session restaurable : REQ-UIX-06 renvoie à l'OIDC, sans écran intermédiaire. */
  | { phase: "hors-session" }
  /** REQ-COR-06 / REQ-UI-04 — la clé de récupération n'est pas configurée. Bloquant. */
  | { phase: "recuperation-requise"; session: Session }
  | { phase: "prete"; session: Session };

/** Le paramètre que Synapse ajoute au retour du fournisseur OIDC. */
export const PARAM_JETON = "loginToken";

/**
 * REQ-UIX-06 — l'URL de départ vers le fournisseur. C'est Synapse qui redirige : nous
 * n'avons **aucune UI de mot de passe**, et nous n'en aurons pas (REQ-UI-04).
 */
export function urlConnexion(homeserverUrl: string, retour: string): string {
  const url = new URL("/_matrix/client/v3/login/sso/redirect", homeserverUrl);
  url.searchParams.set("redirectUrl", retour);
  return url.toString();
}

/**
 * Le jeton de connexion arrive dans l'URL. Il doit **disparaître de la barre d'adresse
 * et de l'historique** aussitôt consommé (contrainte M-B) : un jeton dans l'historique
 * se retrouve dans une capture d'écran, une synchronisation de navigateur, ou un
 * copier-coller d'URL.
 *
 * `replaceState` et non `pushState` : l'entrée d'historique qui portait le jeton est
 * remplacée, pas doublée.
 */
export function retirerJetonDeLUrl(location: Location, history: History): string | null {
  const url = new URL(location.href);
  const jeton = url.searchParams.get(PARAM_JETON);
  if (!jeton) return null;

  url.searchParams.delete(PARAM_JETON);
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  return jeton;
}

/**
 * REQ-COR-06 / REQ-UI-04 — la porte. `recoveryRequired()` est la source ; le shard ne
 * dérive rien lui-même.
 *
 * Sans clé de récupération, **le compte ne peut pas chiffrer du tout** (D-08) :
 * `setupRecoveryKey()` est ce qui amorce le cross-signing, et la sauter rend le client
 * muet — l'utilisateur pourrait lire, jamais écrire. L'étape n'est donc pas un confort
 * qu'on pourrait différer, et c'est pour ça qu'elle bloque.
 */
export async function etatDe(session: Session): Promise<EtatSession> {
  return (await session.recoveryRequired())
    ? { phase: "recuperation-requise", session }
    : { phase: "prete", session };
}
