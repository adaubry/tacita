"use client";

import { useRouter } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

import { IconeRetour } from "./icons";
import { Button, Text, Toolbar } from "./primitives";

interface LayoutHeaderProps {
  titre: string;
  /** Actions de droite, propres à chaque layout. */
  fin?: ReactNode;
  /** Certains layouts (les onglets) n'ont pas de retour. */
  retour?: boolean;
  /**
   * Le filet du bas prend la teinte posée par l'écran. Réservé aux layouts qui *sont*
   * quelque part — une conversation, un profil — et jamais aux écrans d'app (réglages,
   * demandes), qui n'appartiennent à personne et gardent le neutre.
   */
  teinte?: boolean;
}

/**
 * header de layout : `Toolbar`, titre centré, retour à gauche.
 *
 * Le retour suit **l'historique de navigation**, jamais une route codée en dur : la
 * même conversation s'ouvre depuis l'accueil, une recherche ou une mention, et un
 * `href` figé renverrait les deux tiers des visiteurs au mauvais endroit.
 */
export function LayoutHeader({ titre, fin, retour = true, teinte = false }: LayoutHeaderProps) {
  const router = useRouter();

  return (
    <Toolbar
      label={titre}
      dividers={["bottom"]}
      /*
       * **Un filet teinté, pas un bandeau de 2 px.** Le `Toolbar` tire son séparateur de
       * `--color-border` ; le redéfinir dans cette portée teinte le filet sans toucher à
       * la couleur du reste de l'app, et sans recoder la primitive. C'est le seul trait
       * de cet en-tête, donc le seul que la redéfinition atteigne.
       *
       * Un hairline plutôt que le trait épais des maquettes : DESIGN.md pose que la
       * profondeur s'exprime d'abord par le filet, et un filet de 1 px qui change de
       * couleur dit « vous êtes ici » sans crier.
       */
      style={
        teinte
          ? ({ "--color-border": "var(--tacita-teinte-encre)" } as CSSProperties)
          : undefined
      }
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
