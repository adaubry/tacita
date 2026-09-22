"use client";

import { useRef, type PointerEvent } from "react";

/**
 * Distance minimale d'un glissement. Deux seuils et pas un : la distance seule ferait
 * agir un doigt qui descend la liste en biais, d'où la tolérance verticale.
 */
export const SEUIL_GLISSEMENT = 64;
const TOLERANCE_VERTICALE = 32;

/**
 * REQ-UI-09 — **zone morte de 20 px au bord gauche.** Un glissement vers la droite qui
 * part du bord déclenche le retour arrière de Safari iOS hors standalone : le geste
 * n'arrive jamais jusqu'à nous, et la page a changé. On ne peut pas l'empêcher, on peut
 * refuser d'agir dessus — sinon l'utilisateur voit *les deux* se produire selon la
 * chance qu'il a eue de partir à 19 ou 21 px.
 */
export const ZONE_MORTE_BORD = 20;

/** Appui long avant le hold menu. En dessous, un tap lent ouvrirait le menu. */
export const DUREE_APPUI_LONG = 500;

export interface OptionsGlissement {
  onDroite?: () => void;
  onGauche?: () => void;
  onAppuiLong?: () => void;
  /** À activer sur tout ce qui vit dans une pile de navigation (REQ-UI-09). */
  zoneMorteBord?: boolean;
}

/**
 * Le geste de glissement de l'app, en un seul endroit : carte de conversation (M-C),
 * bannière de demandes (M-C), message (M-D). Trois copies auraient dérivé sur trois
 * seuils différents, et l'utilisateur aurait senti la différence sans pouvoir la nommer.
 *
 * Rend des props à étaler sur l'élément. `touchAction: "pan-y"` en fait partie : sans
 * elle le navigateur défile pendant le geste et `pointerup` n'arrive jamais à la bonne
 * abscisse — le seuil ne serait franchi que par hasard.
 */
export function useGlissement({
  onDroite,
  onGauche,
  onAppuiLong,
  zoneMorteBord = false,
}: OptionsGlissement) {
  const depart = useRef<{ x: number; y: number } | null>(null);
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);

  const annuler = () => {
    if (minuterie.current) clearTimeout(minuterie.current);
    minuterie.current = null;
  };

  return {
    // `touchAction: pan-y` laisse le défilement vertical mais réserve l'horizontal au
    // geste. `user-select`/`touch-callout` à `none` : sur iOS, un appui long sur une
    // bulle déclenche sinon la sélection de texte native (surlignage bleu, façon Live
    // Text) *en plus* du hold menu. On le coupe ici, au point unique par où passent
    // tous les gestes (message, carte de conversation, bannière) — la copie reste
    // offerte par « Copier » du hold menu, pas par la sélection native.
    style: {
      touchAction: "pan-y" as const,
      userSelect: "none" as const,
      WebkitUserSelect: "none" as const,
      WebkitTouchCallout: "none" as const,
    },

    onPointerDown(evenement: PointerEvent) {
      if (zoneMorteBord && evenement.clientX < ZONE_MORTE_BORD) {
        depart.current = null;
        return;
      }
      depart.current = { x: evenement.clientX, y: evenement.clientY };
      if (onAppuiLong) minuterie.current = setTimeout(onAppuiLong, DUREE_APPUI_LONG);
    },

    onPointerUp(evenement: PointerEvent) {
      annuler();
      const origine = depart.current;
      depart.current = null;
      if (!origine) return;

      const dx = evenement.clientX - origine.x;
      if (Math.abs(evenement.clientY - origine.y) > TOLERANCE_VERTICALE) return;
      if (dx >= SEUIL_GLISSEMENT) onDroite?.();
      else if (dx <= -SEUIL_GLISSEMENT) onGauche?.();
    },

    onPointerCancel() {
      annuler();
      depart.current = null;
    },
  };
}
