/**
 * Les gestes tactiles : glissement latéral et tirer-pour-rafraîchir.
 *
 * Les seuils sont ici parce qu'ils se répondent — `SEUIL_GLISSEMENT` sépare un
 * défilement d'un geste, `ZONE_MORTE_BORD` laisse à Safari iOS son geste de retour
 * arrière, `DUREE_APPUI_LONG` ouvre le menu d'un message.
 *
 * Simulés en test par événements pointer ; jsdom ne rend aucune géométrie, donc rien
 * ici ne se prouve à l'écran.
 */
"use client";

import { useRef, useState, type PointerEvent } from "react";

/**
 * Distance minimale d'un glissement. Deux seuils et pas un : la distance seule ferait
 * agir un doigt qui descend la liste en biais, d'où la tolérance verticale.
 */
export const SEUIL_GLISSEMENT = 64;
const TOLERANCE_VERTICALE = 32;

/**
 * **zone morte de 20 px au bord gauche.** Un glissement vers la droite qui
 * part du bord déclenche le retour arrière de Safari iOS hors standalone : le geste
 * n'arrive jamais jusqu'à nous, et la page a changé. On ne peut pas l'empêcher, on peut
 * refuser d'agir dessus — sinon l'utilisateur voit *les deux* se produire selon la
 * chance qu'il a eue de partir à 19 ou 21 px.
 */
export const ZONE_MORTE_BORD = 20;

/** Appui long avant le hold menu. En dessous, un tap lent ouvrirait le menu. */
export const DUREE_APPUI_LONG = 500;

/**
 * Au-delà de quoi le doigt « glisse » et n'« appuie » plus.
 *
 * **C'est ce seuil qui manquait, et c'est lui qui cassait la réponse par glissement.**
 * L'appui long n'était annulé qu'au relâchement : un glissement tranquille — le geste
 * normal, on ne balaie pas un message en 200 ms — franchissait les 500 ms en route, le
 * hold menu s'ouvrait par-dessus, avalait le `pointerup`, et le glissement n'arrivait
 * jamais à son terme. Signalé tel quel : « slider pour répondre ne marche pas ».
 */
const SEUIL_GLISSEMENT_COMMENCE = 10;

/** Ce que le doigt peut emporter à l'écran. Au-delà, le geste est déjà acquis. */
const AMPLITUDE_MAX = 96;

export interface OptionsGlissement {
  onDroite?: () => void;
  onGauche?: () => void;
  onAppuiLong?: () => void;
  /** À activer sur tout ce qui vit dans une pile de navigation. */
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
 *
 * **Le contenu suit le doigt** (`transform`), et ce n'est pas une décoration : un geste
 * dont rien ne bouge ne dit ni qu'il a été pris en compte, ni dans quel sens il va, ni
 * qu'il faut aller plus loin. On lâchait donc au tiers du chemin en concluant qu'il ne
 * marchait pas. La translation s'arrête à `AMPLITUDE_MAX` — au-delà le seuil est franchi,
 * continuer à suivre le doigt ne dirait rien de plus.
 */
export function useGlissement({
  onDroite,
  onGauche,
  onAppuiLong,
  zoneMorteBord = false,
}: OptionsGlissement) {
  const depart = useRef<{ x: number; y: number } | null>(null);
  const minuterie = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * **L'axe se décide une fois, au premier mouvement franc** (30/08/2026, plainte :
   * « slider un message marche mal »).
   *
   * La tolérance verticale était réévaluée à *chaque* `pointermove` : un défilement de
   * timeline qui partait un peu de travers faisait glisser le message, puis le rappelait
   * sec dès que le doigt dépassait 32 px de vertical. Le message tremblait sous le pouce
   * pendant qu'on lisait, et une réponse partait parfois toute seule.
   *
   * `null` tant qu'on ne sait pas, puis « x » ou « y » pour toute la durée du geste. En
   * « y », on ne touche plus à rien : le défilement appartient à la page.
   */
  const axe = useRef<"x" | "y" | null>(null);

  /** Un appui long qui a déjà agi ne doit pas aussi déclencher un glissement au relâché. */
  const aAgi = useRef(false);

  const [ecart, setEcart] = useState(0);

  const annuler = () => {
    if (minuterie.current) clearTimeout(minuterie.current);
    minuterie.current = null;
  };

  const finir = () => {
    annuler();
    depart.current = null;
    axe.current = null;
    aAgi.current = false;
    setEcart(0);
  };

  return {
    // Sans elle, l'appui long déclenche aussi la sélection de texte native d'iOS
    // (voir `.tacita-geste` dans tokens.css).
    className: "tacita-geste",
    style: {
      touchAction: "pan-y" as const,
      transform: ecart === 0 ? undefined : `translateX(${ecart}px)`,
      transition: ecart === 0 ? "transform 140ms ease-out" : undefined,
    },

    onPointerDown(evenement: PointerEvent) {
      if (zoneMorteBord && evenement.clientX < ZONE_MORTE_BORD) {
        depart.current = null;
        return;
      }
      depart.current = { x: evenement.clientX, y: evenement.clientY };
      axe.current = null;
      aAgi.current = false;
      if (onAppuiLong) {
        minuterie.current = setTimeout(() => {
          aAgi.current = true;
          onAppuiLong();
        }, DUREE_APPUI_LONG);
      }
      /*
       * **Pas de capture ici.** Elle était prise dès le `pointerdown`, donc sur chaque
       * effleurement : l'élément recevait tous les événements avant même qu'on sache s'il
       * s'agissait d'un tap, d'un défilement ou d'un glissement. Elle est prise dans
       * `onPointerMove`, une fois l'axe horizontal établi — c'est-à-dire une fois qu'il y
       * a quelque chose à capturer.
       */
    },

    onPointerMove(evenement: PointerEvent) {
      const origine = depart.current;
      if (!origine) return;

      const dx = evenement.clientX - origine.x;
      const dy = evenement.clientY - origine.y;

      // L'axe est acquis : un geste vertical ne redevient jamais horizontal en route.
      if (axe.current === "y") return;

      if (axe.current === null) {
        // En dessous du seuil, un tremblement de pouce n'a pas à choisir pour l'utilisateur.
        if (
          Math.abs(dx) < SEUIL_GLISSEMENT_COMMENCE &&
          Math.abs(dy) < SEUIL_GLISSEMENT_COMMENCE
        ) {
          return;
        }
        annuler();
        // La dominante l'emporte, et elle vaut pour tout le geste. `TOLERANCE_VERTICALE`
        // reste le plafond au-delà duquel un mouvement penché est un défilement.
        axe.current =
          Math.abs(dx) > Math.abs(dy) && Math.abs(dy) <= TOLERANCE_VERTICALE ? "x" : "y";
        if (axe.current === "y") {
          setEcart(0);
          return;
        }
        evenement.currentTarget.setPointerCapture?.(evenement.pointerId);
      }

      const suivi = onDroite === undefined && dx > 0 ? 0 : onGauche === undefined && dx < 0 ? 0 : dx;
      setEcart(Math.max(-AMPLITUDE_MAX, Math.min(AMPLITUDE_MAX, suivi)));
    },

    onPointerUp(evenement: PointerEvent) {
      const origine = depart.current;
      const axeAvant = axe.current;
      const aAgiAvant = aAgi.current;
      finir();
      if (!origine) return;

      // Un appui long a déjà agi, ou le geste n'était pas horizontal : le relâché n'agit
      // pas. Sans ça, un hold menu ouvert repartait en réponse dès qu'on levait le doigt.
      if (aAgiAvant || axeAvant !== "x") return;

      const dx = evenement.clientX - origine.x;
      if (dx >= SEUIL_GLISSEMENT) onDroite?.();
      else if (dx <= -SEUIL_GLISSEMENT) onGauche?.();
    },

    onPointerCancel: finir,
  };
}

/** Distance à tirer avant que le rafraîchissement parte. */
export const SEUIL_TIRAGE = 72;
/** Ce que le contenu descend au maximum pendant le tirage. */
const AMPLITUDE_TIRAGE = 96;

/**
 * **Tirer vers le bas pour rafraîchir** (30/08/2026, demande utilisateur).
 *
 * *Interprétation, à confirmer.* La demande dit « swipe up pour refresh ». Aucun système
 * ne place le rafraîchissement sur un balayage vers le haut — sur iOS comme sur Android,
 * c'est le tirage vers le **bas**, en haut de liste, et le balayage vers le haut sert à
 * défiler. On implémente donc la convention, qui est ce que le doigt essaiera d'abord ;
 * l'inverser est un signe à changer si l'intention était bien l'autre.
 *
 * Le tirage n'arme que si la page est **déjà en haut** : sinon le geste appartient au
 * défilement, et l'utilisateur qui remonte sa liste verrait le contenu s'étirer sous son
 * doigt à chaque fois qu'il atteint le sommet.
 */
export function useTirerPourRafraichir(rafraichir: () => void) {
  const depart = useRef<number | null>(null);
  const [tire, setTire] = useState(0);

  const finir = () => {
    depart.current = null;
    setTire(0);
  };

  return {
    /** Ce que le conteneur doit rendre pour montrer le tirage. */
    tire,
    pret: tire >= SEUIL_TIRAGE,
    style: {
      transform: tire === 0 ? undefined : `translateY(${tire}px)`,
      transition: tire === 0 ? "transform 140ms ease-out" : undefined,
    },
    onPointerDown(evenement: PointerEvent) {
      // `scrollY` et non le conteneur : l'accueil défile avec le document.
      depart.current = globalThis.scrollY <= 0 ? evenement.clientY : null;
    },
    onPointerMove(evenement: PointerEvent) {
      if (depart.current === null) return;
      const dy = evenement.clientY - depart.current;
      if (dy <= 0) {
        setTire(0);
        return;
      }
      // Résistance : le contenu suit à moitié, ce qui dit « c'est un geste, pas un défilement ».
      setTire(Math.min(AMPLITUDE_TIRAGE, dy / 2));
    },
    onPointerUp() {
      const acquis = tire >= SEUIL_TIRAGE;
      finir();
      if (acquis) rafraichir();
    },
    onPointerCancel: finir,
  };
}
