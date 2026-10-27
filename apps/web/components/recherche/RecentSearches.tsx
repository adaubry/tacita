"use client";

import { useEffect, useRef, useState } from "react";

import type { Contact } from "../../lib/contacts";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { Button, Text } from "../foundation/primitives";

interface RecentSearchesProps {
  /** Les profils récemment recherchés, du plus récent au plus ancien. */
  profils: Contact[];
  onChoisir: (contact: Contact) => void;
  /** « purgeable ». Absent = pas de bouton, liste non vidable. */
  onPurger?: () => void;
}

/** Largeur d'une vignette de profil. Fixe : c'est elle qui rend le débordement lisible. */
const LARGEUR_PROFIL = 72;

/**
 * composant 17, « Recent searches » : un scroller horizontal de profils
 * avec **content peek**, c'est-à-dire un dernier élément volontairement coupé quand la
 * liste déborde.
 *
 * Le peek n'est pas décoratif : un scroller dont tout tient à l'écran ne montre pas
 * qu'il défile, et un utilisateur qui ne voit pas de coupure ne fait pas le geste. On
 * ne le simule donc que lorsqu'il y a réellement quelque chose à révéler — d'où la
 * mesure plutôt qu'une largeur devinée.
 */
export function RecentSearches({ profils, onChoisir, onPurger }: RecentSearchesProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [deborde, setDeborde] = useState(false);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // Une seule mesure par changement de liste. Pas de ResizeObserver : la largeur du
    // scroller suit celle de l'écran, et une rotation re-rend l'écran de toute façon.
    setDeborde(element.scrollWidth > element.clientWidth);
  }, [profils]);

  if (profils.length === 0) return null;

  return (
    <section aria-labelledby="recents-titre" style={{ display: "grid", gap: "var(--spacing-2)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--spacing-2)",
          padding: "0 var(--spacing-3)",
        }}
      >
        <Text id="recents-titre" type="supporting" weight="bold" color="secondary">
          Recherches récentes
        </Text>
        {onPurger && <Button label="Effacer" variant="ghost" size="sm" onClick={onPurger} />}
      </div>

      <div
        ref={scroller}
        role="list"
        aria-label="Profils récemment recherchés"
        data-deborde={deborde ? "true" : undefined}
        style={{
          display: "flex",
          gap: "var(--spacing-3)",
          overflowX: "auto",
          padding: "0 var(--spacing-3)",
          // Le geste s'arrête sur un profil entier, jamais entre deux — sinon le peek
          // se transforme en alignement approximatif dès le premier défilement.
          scrollSnapType: "x mandatory",
        }}
      >
        {profils.map((profil, rang) => {
          // Le dernier est coupé **seulement** si la liste déborde : sinon la coupure
          // annoncerait un contenu qui n'existe pas.
          const peek = deborde && rang === profils.length - 1;
          return (
            <div
              key={profil.userId}
              role="listitem"
              data-peek={peek ? "true" : undefined}
              style={{
                flex: "0 0 auto",
                width: peek ? LARGEUR_PROFIL * 0.6 : LARGEUR_PROFIL,
                overflow: peek ? "hidden" : undefined,
                scrollSnapAlign: "start",
              }}
            >
              <Button
                label={profil.nom}
                variant="ghost"
                onClick={() => onChoisir(profil)}
                style={{
                  display: "grid",
                  justifyItems: "center",
                  gap: "var(--spacing-1)",
                  width: LARGEUR_PROFIL,
                  padding: "var(--spacing-1)",
                  // `Button` est un contrôle à **hauteur fixe** (`--size-element-md`,
                  // 32 px). L'avatar en fait 40 à lui seul, le nom en ajoute une ligne :
                  // le contenu débordait de son propre bouton. Les autres dimensions
                  // étaient déjà reprises ici, la hauteur avait été oubliée — même défaut
                  // que la vignette de la timeline, à un endroit de moins.
                  height: "auto",
                }}
              >
                <ConversationAvatar nom={profil.nom} direct cle={profil.userId} />
                <Text type="supporting" color="secondary" maxLines={1}>
                  {profil.nom}
                </Text>
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
