"use client";

import type { ReactNode } from "react";

import { HOMESERVER } from "../../lib/config";

import { Placeholder } from "../foundation/Placeholder";
import { Button, VStack } from "../foundation/primitives";
import { Connexion } from "./Connexion";
import { EcranDePorte } from "./EcranDePorte";
import { Onboarding } from "./Onboarding";
import { RecoveryUnlock } from "./RecoveryUnlock";
import { useSession } from "./SessionProvider";
import { Skeleton } from "../foundation/Skeleton";

/**
 * la porte d'entrée de toute l'app.
 *
 * **Elle remplace le contenu, elle ne redirige pas.** Un garde de route se contourne en
 * tapant une adresse ; ici, tant que la clé de récupération n'est pas confirmée — puis
 * tant que le parcours d'accueil n'est pas fini —, aucune route ne rend autre chose,
 * quelle que soit l'URL demandée. C'est ce que « ni sautée, ni différée, ni contournée
 * par URL directe » veut dire concrètement.
 *
 * Les deux blocages n'ont pas la même nature et il ne faut pas les confondre : la clé est
 * bloquante parce que **sans elle le compte ne chiffre pas** ; le parcours l'est
 * parce qu'il se termine dans une conversation ouverte, et qu'un parcours dont on peut
 * sortir par le milieu laisse quelqu'un sur une application vide. Ses étapes, elles,
 * peuvent être facultatives — c'est le parcours qui le dit, pas cette porte.
 */
export function RecoveryGate({
  children,
  homeserverUrl = HOMESERVER,
}: {
  children: ReactNode;
  /** Injecté en test ; en production, l'adresse du déploiement. */
  homeserverUrl?: string;
}) {
  const { etat, sessionOuverte, reessayer } = useSession();

  if (etat.phase === "echec") {
    // Le chargement a dépassé son délai sans aboutir : jamais bloqué, on relance la
    // reprise — ce qui rouvre les bases et rejoue la crypto.
    return (
      <EcranDePorte>
        <Placeholder
          titre="Chargement interrompu"
          explication="Tacita n'a pas réussi à rouvrir votre session. Cela arrive parfois quand l'app est restée en arrière-plan."
          action={<Button label="Réessayer" variant="primary" onClick={reessayer} />}
        />
      </EcranDePorte>
    );
  }

  if (etat.phase === "chargement") {
    // DESIGN.md : pas de spinner plein écran. Une géométrie d'attente, localisée.
    return (
      <EcranDePorte>
        <VStack gap={2}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </VStack>
      </EcranDePorte>
    );
  }

  if (etat.phase === "hors-session") {
    /*
     * **le formulaire, et non une redirection**.
     *
     * Cet écran affichait « Connexion… / Redirection vers votre fournisseur » : il n'y
     * avait rien à saisir, l'identité vivant chez Keycloak. Elle est revenue dans le
     * produit, et cet emplacement est celui où on la demande.
     */
    return (
      <EcranDePorte>
        <Connexion homeserverUrl={homeserverUrl} onSession={sessionOuverte} />
      </EcranDePorte>
    );
  }

  if (etat.phase === "recuperation-requise") {
    /*
     * Deux chemins, pas un. `mode` vient de `recoveryState()` : le shard ne
     * dérive rien. La porte ne proposait que la création, et l'ouvrait donc à chaque
     * reconnexion — chaque `m.login.token` donne un `device_id` neuf, non signé, ce que
     * l'ancienne source confondait avec « ce compte n'a pas de clé ».
     *
     * `creation` **est** le premier pas du parcours d'accueil, et non un écran séparé qui
     * le précéderait : c'est le seul instant où l'on sait que le compte vient de naître
     * (voir `SessionProvider`), et l'indicateur de progression doit compter cette étape-là
     * comme les autres — sans quoi il annoncerait « étape 1 sur 3 » à quelqu'un qui vient
     * déjà d'en franchir une.
     */
    return etat.mode === "creation" ? (
      <Onboarding session={etat.session} depart={0} />
    ) : (
      <EcranDePorte>
        <RecoveryUnlock session={etat.session} />
      </EcranDePorte>
    );
  }

  /*
   * la clé est confirmée et l'app est joignable, mais le parcours n'est pas
   * fini : il reprend **après** l'étape bloquante, qui vient d'être franchie ou l'avait
   * été avant un rechargement. Les étapes qui suivent sont toutes idempotentes (les
   * images par défaut ne s'écrasent pas, la conversation personnelle ne se duplique pas),
   * donc reprendre au même endroit ne coûte rien et ne casse rien.
   */
  if (etat.onboarding) return <Onboarding session={etat.session} depart={1} />;

  return <>{children}</>;
}
