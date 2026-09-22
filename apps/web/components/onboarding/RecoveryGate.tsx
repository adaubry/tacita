"use client";

import type { ReactNode } from "react";

import { Placeholder } from "../foundation/Placeholder";
import { Button, Skeleton, VStack } from "../foundation/primitives";
import { RecoveryStep } from "./RecoveryStep";
import { useSession } from "./SessionProvider";

/**
 * REQ-UI-04 / REQ-UIX-06 — la porte d'entrée de toute l'app.
 *
 * **Elle remplace le contenu, elle ne redirige pas.** Un garde de route se contourne en
 * tapant une adresse ; ici, tant que la clé de récupération n'est pas confirmée, aucune
 * route ne rend autre chose que l'étape — quelle que soit l'URL demandée. C'est ce que
 * « ni sautée, ni différée, ni contournée par URL directe » veut dire concrètement.
 */
export function RecoveryGate({ children }: { children: ReactNode }) {
  const { etat, reessayer } = useSession();

  if (etat.phase === "echec") {
    // Le chargement a dépassé son délai sans aboutir (typiquement IndexedDB laissé
    // pendant par iOS après suspension) : on ne reste jamais bloqué, on propose de
    // relancer la reprise — ce qui rouvre les bases et rejoue la crypto.
    return (
      <Placeholder
        titre="Chargement interrompu"
        explication="Tacita n'a pas réussi à rouvrir votre session. Cela arrive parfois quand l'app est restée en arrière-plan."
        action={<Button label="Réessayer" variant="primary" onClick={reessayer} />}
      />
    );
  }

  if (etat.phase === "chargement") {
    // DESIGN.md : pas de spinner plein écran. Une géométrie d'attente, localisée.
    return (
      <VStack gap={2} padding={4}>
        <Skeleton height={44} />
        <Skeleton height={44} />
        <Skeleton height={44} />
      </VStack>
    );
  }

  if (etat.phase === "hors-session") {
    // La redirection vers l'OIDC est déjà partie (REQ-UIX-06 : sans écran intermédiaire).
    // Ce qui s'affiche entre-temps ne doit ni ressembler à une erreur, ni à un formulaire.
    return <Placeholder titre="Connexion…" explication="Redirection vers votre fournisseur." />;
  }

  if (etat.phase === "recuperation-requise") {
    return <RecoveryStep session={etat.session} />;
  }

  return <>{children}</>;
}
