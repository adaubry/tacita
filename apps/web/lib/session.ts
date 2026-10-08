import type { RecoveryState, Session } from "@tacita/client-core";

import { lireOnboardingEnCours } from "./preferences";

/**
 * L'état d'entrée dans l'app, tel que l'UI a besoin de le connaître. Rien de plus :
 * la logique vit dans `client-core`, le shard ne fait que router dessus.
 */
export type EtatSession =
  | { phase: "chargement" }
  /**
   * La reprise n'a ni abouti ni échoué dans le délai — typiquement une connexion IndexedDB
   * qu'iOS a laissée pendante après avoir suspendu la PWA. On propose de réessayer.
   */
  | { phase: "echec" }
  /** Aucune session restaurable : renvoie à l'OIDC, sans écran intermédiaire. */
  | { phase: "hors-session" }
  /**
   * cet appareil ne peut pas encore chiffrer. Bloquant.
   *
   * `mode` dit **laquelle des deux étapes** : fabriquer la clé (inscription) ou recevoir
   * celle qui existe déjà (toute reconnexion). Les confondre était le défaut : chaque
   * `m.login.token` donne un `device_id` neuf, donc un appareil non signé, et l'écran de
   * création s'ouvrait devant quelqu'un qui avait sa clé depuis longtemps.
   */
  | {
      phase: "recuperation-requise";
      session: Session;
      mode: Exclude<RecoveryState, "prete">;
      /**
       * **un parcours d'accueil resté en plan sur cet appareil**, lu avant de
       * savoir laquelle des deux étapes de clé s'impose.
       *
       * Il est porté ici et pas seulement dans `prete` parce que `mode` ne suffit pas à le
       * déduire : une inscription interrompue puis reprise par le déverrouillage arrive
       * avec `mode: "deverrouillage"` et un parcours pourtant inachevé. Le déduire de
       * `mode` renvoyait ces gens sur l'accueil, au milieu de leur propre inscription.
       */
      onboarding: boolean;
    }
  /**
   * l'app est atteignable. `onboarding` dit qu'elle ne s'ouvre pas encore :
   * le parcours d'accueil est commencé et n'est pas fini, sur cet appareil.
   */
  | { phase: "prete"; session: Session; onboarding?: boolean };

/*
 * `PARAM_JETON`, `urlConnexion` et `retirerJetonDeLUrl` vivaient ici. Les trois servaient
 * le même aller-retour SSO : construire l'URL de redirection vers le fournisseur, puis
 * retirer de l'historique le `loginToken` qu'il renvoyait dans la barre d'adresse.
 *
 * Supprimés avec Keycloak. L'identité est portée par Synapse, la
 * connexion est un formulaire (`Connexion.tsx`), et plus aucun secret ne transite par
 * l'URL — ce qui retire aussi, au passage, la classe de fuite que `retirerJetonDeLUrl`
 * existait pour contenir : capture d'écran, synchronisation de navigateur, copier-coller.
 */

/**
 * la porte. `recoveryState()` est la source ; le shard ne dérive
 * rien lui-même — il ne fait que router les trois cas sur deux phases.
 *
 * Sans identité cross-signing sur cet appareil, **le compte ne peut pas chiffrer du
 * tout** : il ne recevrait pas les clés Megolm des autres, et les siennes ne
 * partiraient à personne. L'étape n'est donc pas un confort qu'on pourrait différer, et
 * c'est pour ça qu'elle bloque.
 *
 * Il n'y a plus de trace locale à consulter (l'ancien `recuperation-faite`) :
 * `recoveryState()` lit le magasin crypto, ce qui répond juste hors ligne **et** distingue
 * les deux étapes. La trace, elle, ne savait rien du `device_id` — après une
 * déconnexion/reconnexion dans le même navigateur, elle laissait passer un appareil non
 * signé, muet et sourd, avec l'application entière derrière.
 */
export async function etatDe(session: Session, indexedDB?: IDBFactory): Promise<EtatSession> {
  /*
   * la reprise du parcours d'accueil. Elle est lue **ici** et non dans un
   * écran : la porte montre déjà une géométrie d'attente pendant que cette fonction
   * répond, et une lecture faite plus tard ferait clignoter l'accueil avant le parcours.
   *
   * Lue **avant** la branche, et portée par les deux phases (corrigé) : la
   * confirmation de la clé décidait sinon du parcours sur le seul `mode`, et perdait la
   * marque de quiconque avait commencé une inscription puis dû passer par l'autre chemin.
   *
   * Une base absente ou illisible vaut « pas de parcours en cours » : le pire cas est
   * quelqu'un qui reprend la main une étape trop tôt, jamais quelqu'un bloqué dehors.
   */
  const onboarding = indexedDB
    ? await lireOnboardingEnCours(indexedDB).catch(() => false)
    : false;

  const etat = await session.recoveryState();
  if (etat !== "prete") {
    return { phase: "recuperation-requise", session, mode: etat, onboarding };
  }
  return { phase: "prete", session, onboarding };
}
