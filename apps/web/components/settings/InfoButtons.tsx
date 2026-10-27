"use client";

import type { ReactNode } from "react";

import { Text } from "../foundation/primitives";

export interface BoutonInfo {
  cle: string;
  libelle: string;
  icone: ReactNode;
  onClick: () => void;
}

/**
 * composant 14 du wireframe : les **Info buttons**.
 *
 * Libellé sous l'icône, quatre boutons équirépartis.
 *
 * **Ils portent `data-variant="primary"` sans être des `Button`** (« le i à côté du
 * profil, c'est encore l'ancienne UI »). La règle du primaire doux de
 * `tokens.css` vise cet attribut, que seul le bouton rendu par Astryx porte : ces
 * quatre-là, écrits à la main, étaient restés les derniers pavés gris à pastille d'accent
 * pleine de l'app — et ils occupent le haut d'un écran entier. Poser l'attribut les y
 * raccroche au lieu de recopier la recette ; si le taux du voile bouge, il bouge ici
 * aussi. Corollaire : la forme, le fond, l'encre et la bordure ne sont **pas** en style
 * inline, qui l'emporterait sur la règle.
 *
 * L'icône se rend nue, et non dans un `NavIcon` : celui-ci pose une pastille d'accent
 * **plein**, qui dans une pilule de ce même accent ferait deux verts l'un dans l'autre.
 * Nue, elle hérite de `currentColor`, donc de l'encre que la règle pose.
 *
 * `flex: 1` sur chaque cellule plutôt qu'une grille à quatre colonnes : le composant
 * accepte quatre boutons aujourd'hui, mais l'équirépartition ne doit pas dépendre du
 * compte — un jeu à trois se répartirait de travers sur une grille figée.
 */
export function InfoButtons({ boutons }: { boutons: BoutonInfo[] }) {
  return (
    <div
      role="group"
      aria-label="Actions de la conversation"
      style={{ display: "flex", gap: "var(--spacing-2)", padding: "var(--spacing-3)" }}
    >
      {boutons.map(({ cle, libelle, icone, onClick }) => (
        <button
          key={cle}
          type="button"
          data-variant="primary"
          onClick={onClick}
          aria-label={libelle}
          style={{
            flex: 1,
            display: "grid",
            justifyItems: "center",
            gap: "var(--spacing-1)",
            // Cibles de 44 px (M-A) : le libellé compte dans la hauteur, l'icône seule
            // ne suffirait pas.
            minHeight: 44,
            padding: "var(--spacing-2)",
            border: 0,
            cursor: "pointer",
          }}
        >
          {icone}
          {/* DESIGN.md : les libellés d'Info buttons sont du `caption` — c'est ce que
              rend `supporting` sous notre thème (M-A). `color="inherit"` : sans lui,
              `Text` repose sa propre encre et le libellé resterait gris sous une icône
              verte. */}
          <Text type="supporting" color="inherit" maxLines={1}>
            {libelle}
          </Text>
        </button>
      ))}
    </div>
  );
}
