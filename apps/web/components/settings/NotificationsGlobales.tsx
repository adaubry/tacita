"use client";

import type { Session } from "@tacita/client-core";
import { useEffect, useState } from "react";

import { activerPush, etatPush, type EtatPush } from "../../lib/push";
import { Button, Text, VStack } from "../foundation/primitives";

/** Ce que chaque état dit, et ce qu'il laisse faire. */
const EXPLICATION: Record<EtatPush | "echec", string> = {
  actif: "Cet appareil reçoit les notifications.",
  "a-demander": "Cet appareil ne reçoit pas encore les notifications.",
  // REQ-UI-18 — le refus est un état visible, avec son chemin de rattrapage : nous ne
  // pouvons pas redemander la permission, le navigateur ne nous le permet plus.
  refuse:
    "Les notifications sont bloquées par votre navigateur. Rouvrez-les dans les réglages du site — le cadenas, à gauche de l'adresse — puis revenez ici.",
  "non-supporte":
    "Ce navigateur ne gère pas les notifications. Sur iPhone, elles n'existent que si Tacita est ajoutée à l'écran d'accueil.",
  echec: "L'abonnement n'a pas abouti. Réessayez : le serveur de notifications n'a peut-être pas répondu.",
};

/**
 * REQ-UI-18 — l'abonnement Web Push global, dans les réglages (M-H tient le par-salon).
 *
 * L'état n'est pas mémorisé : la permission se change aussi depuis le navigateur, et un
 * écran qui affiche « actif » quand le navigateur dit non est pire que pas d'écran.
 */
export function NotificationsGlobales({ session }: { session: Session | null }) {
  const [etat, setEtat] = useState<EtatPush | "echec">("a-demander");

  useEffect(() => {
    let annule = false;
    void etatPush().then((lu) => {
      if (!annule) setEtat(lu);
    });
    return () => {
      annule = true;
    };
  }, []);

  return (
    <VStack gap={3}>
      <Text>{EXPLICATION[etat]}</Text>

      {etat === "a-demander" || etat === "echec" ? (
        <Button
          label="Activer les notifications"
          variant="primary"
          isDisabled={!session}
          clickAction={async () => {
            if (!session) return;
            setEtat(await activerPush(session).catch((): EtatPush | "echec" => "echec"));
          }}
        />
      ) : null}

      {/*
        Honnêteté produit (interdit n°13, E-12) : ce que la notification peut montrer
        dépend de si l'application est encore ouverte. Le taire donnerait l'impression
        d'un déchiffrement en panne, alors que c'est la limite annoncée.
      */}
      <Text type="supporting" color="secondary">
        Quand l&apos;application est fermée, la notification dit qui vous écrit, sans
        aperçu du message : le déchiffrement a besoin de l&apos;application ouverte.
        Aucun contenu ne transite par le serveur de notifications.
      </Text>
    </VStack>
  );
}
