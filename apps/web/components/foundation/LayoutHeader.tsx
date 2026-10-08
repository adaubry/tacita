"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { IconeRetour } from "./icons";
import { Button, Text, Toolbar } from "./primitives";

interface LayoutHeaderProps {
  titre: string;
  /** Actions de droite, propres à chaque layout. */
  fin?: ReactNode;
  /** Certains layouts (les onglets) n'ont pas de retour. */
  retour?: boolean;
}

/**
 * header de layout : `Toolbar`, titre centré, retour à gauche.
 *
 * Le retour suit **l'historique de navigation**, jamais une route codée en dur : la
 * même conversation s'ouvre depuis l'accueil, une recherche ou une mention, et un
 * `href` figé renverrait les deux tiers des visiteurs au mauvais endroit.
 */
export function LayoutHeader({ titre, fin, retour = true }: LayoutHeaderProps) {
  const router = useRouter();

  return (
    <Toolbar
      label={titre}
      dividers={["bottom"]}
      startContent={
        retour ? (
          <Button
            label="Retour"
            variant="ghost"
            isIconOnly
            icon={IconeRetour}
            // Sans entrée précédente — conversation ouverte depuis une notification, ou URL
            // restaurée par iOS à la relance — `back()` ne fait rien, et une PWA installée
            // n'a aucun bouton de navigateur pour s'en sortir. Seul ce cas va à l'accueil.
            onClick={() => (globalThis.history.length > 1 ? router.back() : router.push("/"))}
          />
        ) : undefined
      }
      centerContent={
        <Text type="label" size="lg">
          {titre}
        </Text>
      }
      endContent={fin}
    />
  );
}
