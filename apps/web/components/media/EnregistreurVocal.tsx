"use client";

import { useEffect, useRef, useState, type PointerEvent as PointerEvenement } from "react";

import { fichierVocal, vocalDisponible } from "../../lib/vocal";
import { IconeEnvoyer, IconeMicro, IconePoubelle } from "../foundation/icons";
import { Button, Text } from "../foundation/primitives";
import { dureeLisible } from "./media";

/**
 * Les deux refus possibles, dits en toutes lettres. DESIGN.md : les permissions se
 * demandent au moment de l'usage, et une limite s'explique en une phrase sobre, jamais
 * par un contrôle grisé sans un mot.
 */
const REFUS = {
  refuse:
    "L'accès au micro a été refusé. Autorisez-le dans les réglages de votre navigateur, puis réessayez.",
  echec:
    "L'enregistrement n'a pas pu démarrer sur cet appareil. Vous pouvez joindre un fichier audio avec le bouton « + ».",
} as const;

/**
 * **Le plafond de durée.** Pas une règle de produit : une borne d'ingénierie. Un
 * enregistrement oublié tient ses morceaux en mémoire jusqu'à l'envoi, et le serveur
 * refuserait de toute façon le téléversement — mais il le refuserait *après* la
 * compression et le chiffrement, c'est-à-dire après avoir fait travailler l'appareil pour
 * rien. On s'arrête avant, en gardant ce qui a été dit.
 */
const DUREE_MAX_MS = 5 * 60 * 1000;

/**
 * **Le plancher.** En dessous, l'appui était une erreur, pas un message.
 *
 * Le garde ne regardait que « des octets existent » : deux touchers maladroits
 * expédiaient un vocal de 200 ms, que le destinataire ouvre pour n'entendre rien. On
 * annule, **sans message d'erreur** — un appui trop court n'est pas une faute à expliquer,
 * et une phrase rouge sous le composer pour ça serait pire que le silence.
 *
 * Il porte encore plus depuis le maintien : un effleurement du micro est maintenant un
 * enregistrement complet, ouvert et refermé, et c'est ce plancher qui le jette.
 */
const DUREE_MIN_MS = 800;

/**
 * **Ce que le doigt doit parcourir vers la poubelle pour annuler.**
 *
 * C'est la « zone où le doigt peut rester appuyé sans annuler » : en deçà de 72 px vers
 * la gauche, rien ne bouge. Un pouce qui tient un bouton pendant qu'on parle ne reste pas
 * immobile — il roule de quelques pixels, et un seuil serré transformerait ce tremblement
 * en annulation. Rien ne contraint la **verticale** : monter ou descendre n'est pas un
 * geste d'annulation, et l'y soumettre ferait perdre le vocal à qui tient son téléphone
 * de travers.
 *
 * 72 px, soit un peu plus d'une cible tactile : assez pour qu'on ne l'atteigne pas sans
 * le vouloir, assez peu pour que le pouce y arrive sans lâcher l'écran.
 */
const COURSE_ANNULATION = 72;

interface EnregistreurVocalProps {
  /** Le fichier produit part par le même chemin qu'une pièce jointe choisie à la main. */
  onEnvoyer: (fichier: File) => void;
  /** Injecté en test : `MediaRecorder` n'existe pas dans jsdom. */
  portee?: typeof globalThis;
}

/**
 * **Le micro se maintient : on appuie, on parle, on relâche, ça part.**
 *
 * C'est le geste d'Instagram et de WhatsApp, et c'est ce que les testeurs attendaient —
 * l'ancien parcours demandait un appui pour ouvrir, un second pour envoyer, et on
 * s'apercevait du premier à l'écran seulement. Le commentaire qui vivait ici défendait
 * l'inverse (« deux appuis valent un geste qu'on rate ») : il avait tort sur le fait, pas
 * sur la règle — un geste doit avoir un équivalent visible, et c'est la raison pour
 * laquelle le **clavier garde les deux appuis** (voir `auClic`).
 *
 * Le glissement vers la poubelle annule. Elle n'apparaît qu'une fois l'enregistrement
 * commencé, à gauche de la barre d'écriture, parce qu'une poubelle en permanence dans un
 * composer est une cible à côté de laquelle personne ne veut parler.
 *
 * Le composant **ne se rend pas du tout** quand l'appareil n'offre aucun format : c'est la
 * règle que `Composer` posait déjà en refusant un micro inerte. Un bouton absent se
 * comprend ; un bouton qui échoue au moment d'envoyer, non.
 */
export function EnregistreurVocal({ onEnvoyer, portee = globalThis }: EnregistreurVocalProps) {
  const format = vocalDisponible(portee);

  const [enCours, setEnCours] = useState(false);
  const [ecoule, setEcoule] = useState(0);
  const [arme, setArme] = useState(false);
  const [refus, setRefus] = useState<keyof typeof REFUS>();

  const enregistreur = useRef<MediaRecorder>(null);
  const morceaux = useRef<Blob[]>([]);
  const flux = useRef<MediaStream>(null);
  /** Distingue « envoyer » d'« annuler » dans `onstop`, qui ne sait pas pourquoi il tombe. */
  const garder = useRef(false);
  /*
   * L'instant du départ, en ref et non dans l'état : `onstop` a besoin de la durée
   * *réelle*, et `ecoule` n'avance que toutes les 200 ms — il sous-estimerait l'appui
   * d'un cinquième de seconde, ce qui est beaucoup quand le plancher en vaut quatre.
   */
  const debut = useRef(0);
  /** Abscisse du doigt à l'appui : la course se mesure depuis là, jamais depuis le bouton. */
  const origine = useRef(0);
  /**
   * L'état d'armement **aussi** en ref. Le relâchement le lit dans une fermeture créée
   * au rendu ; s'il n'était que dans l'état, un `pointerup` arrivant avant que React ait
   * repeint enverrait le vocal que le doigt venait de traîner sur la poubelle.
   */
  const armeRef = useRef(false);
  /**
   * **Le doigt peut se lever avant que le micro soit ouvert.** `getUserMedia` est
   * asynchrone, et la toute première fois elle attend une réponse à la demande de
   * permission : un appui bref part et revient pendant ce temps. Sans cette mémoire,
   * l'enregistrement démarrait **après** le relâchement et ne s'arrêtait plus — micro
   * allumé, rien à l'écran pour le dire.
   */
  const relacheAvantDepart = useRef<"envoyer" | "annuler" | undefined>(undefined);

  /*
   * Le micro s'éteint avec le composant, quoi qu'il arrive. Une pastille
   * d'enregistrement qui reste allumée après coup est une trahison de confiance, pas une
   * fuite mémoire — même jurisprudence que la caméra de `PhotoCapture`.
   */
  useEffect(
    () => () => {
      if (enregistreur.current?.state === "recording") enregistreur.current.stop();
      flux.current?.getTracks().forEach((piste) => piste.stop());
    },
    [],
  );

  useEffect(() => {
    if (!enCours) return;
    const depart = Date.now();
    const minuteur = setInterval(() => setEcoule(Date.now() - depart), 200);
    return () => clearInterval(minuteur);
  }, [enCours]);

  // Le plafond s'applique à l'enregistrement, pas au composant : il garde ce qui a été
  // dit et le propose à l'envoi, au lieu de le jeter.
  useEffect(() => {
    if (enCours && ecoule >= DUREE_MAX_MS) arreter(true);
  }, [enCours, ecoule]);

  const nettoyer = () => {
    flux.current?.getTracks().forEach((piste) => piste.stop());
    flux.current = null;
    enregistreur.current = null;
    armeRef.current = false;
    relacheAvantDepart.current = undefined;
    setEnCours(false);
    setEcoule(0);
    setArme(false);
  };

  const demarrer = async () => {
    if (!format) return;
    setRefus(undefined);
    try {
      const obtenu = await portee.navigator.mediaDevices.getUserMedia({ audio: true });
      flux.current = obtenu;
      morceaux.current = [];
      garder.current = false;

      const Enregistreur = (portee as { MediaRecorder: typeof MediaRecorder }).MediaRecorder;
      const instance = new Enregistreur(obtenu, { mimeType: format });
      instance.ondataavailable = (evenement) => {
        if (evenement.data.size > 0) morceaux.current.push(evenement.data);
      };
      instance.onstop = () => {
        const recoltes = morceaux.current;
        const tenue = Date.now() - debut.current;
        morceaux.current = [];
        nettoyer();
        if (garder.current && recoltes.length > 0 && tenue >= DUREE_MIN_MS) {
          onEnvoyer(fichierVocal(recoltes, format, Date.now()));
        }
      };
      enregistreur.current = instance;
      debut.current = Date.now();
      instance.start();
      setEnCours(true);

      // Le doigt est déjà reparti : on referme tout de suite. Le plancher de durée fera
      // le reste — un appui aussi court n'a rien à envoyer.
      const dejaRelache = relacheAvantDepart.current;
      if (dejaRelache) arreter(dejaRelache === "envoyer");
    } catch (cause) {
      // `NotAllowedError` est le refus de l'utilisateur ; tout le reste est un appareil
      // qui ne suit pas. Deux phrases différentes, parce que les deux se réparent
      // différemment.
      const nom = cause instanceof Error ? cause.name : "";
      setRefus(nom === "NotAllowedError" || nom === "SecurityError" ? "refuse" : "echec");
      nettoyer();
    }
  };

  const arreter = (envoyer: boolean) => {
    garder.current = envoyer;
    if (enregistreur.current?.state === "recording") enregistreur.current.stop();
    else nettoyer();
  };

  /** Le doigt se pose : le micro s'ouvre, et la course d'annulation part d'ici. */
  const auDoigtPose = (evenement: PointerEvenement<HTMLElement>) => {
    if (enCours) return;
    origine.current = evenement.clientX;
    armeRef.current = false;
    relacheAvantDepart.current = undefined;
    setArme(false);
    /*
     * **La capture, sans quoi rien de tout cela ne marche.** Le doigt quitte le bouton
     * dès les premiers pixels : sans capture, les `pointermove` partent à l'élément
     * survolé et le `pointerup` n'arrive jamais ici — l'enregistrement ne s'arrêterait
     * pas. Appel facultatif : jsdom n'a pas l'API, et la tester n'apprendrait rien.
     */
    evenement.currentTarget.setPointerCapture?.(evenement.pointerId);
    void demarrer();
  };

  const auDoigtBouge = (evenement: PointerEvenement<HTMLElement>) => {
    if (!enCours) return;
    // Vers la gauche seulement, et la verticale n'entre pas dans le calcul.
    const desormaisArme = origine.current - evenement.clientX >= COURSE_ANNULATION;
    armeRef.current = desormaisArme;
    setArme(desormaisArme);
  };

  const auDoigtLeve = () => {
    if (!enCours) {
      // Le micro n'est pas encore ouvert : `demarrer` refermera en arrivant.
      relacheAvantDepart.current = armeRef.current ? "annuler" : "envoyer";
      return;
    }
    arreter(!armeRef.current);
  };

  /**
   * **Le chemin clavier, et la raison pour laquelle il existe.**
   *
   * DESIGN.md veut qu'un geste ait un équivalent visible et atteignable autrement qu'au
   * doigt. Un maintien ne se tient pas au clavier : on y revient donc aux deux appuis —
   * le premier ouvre, le second envoie — sur le **même** bouton, dont le libellé dit
   * lequel des deux il fait.
   *
   * `detail === 0` est ce qui distingue les deux mondes : un clic produit par la barre
   * d'espace ou Entrée n'a aucun clic physique à compter, une souris et un doigt en ont
   * au moins un. Sans ce garde, le `click` qui suit chaque `pointerup` rouvrirait un
   * enregistrement juste après l'avoir envoyé.
   */
  const auClic = (evenement: { detail: number }) => {
    if (evenement.detail !== 0) return;
    if (enCours) arreter(true);
    else void demarrer();
  };

  if (!format) return null;

  return (
    <>
      {/*
       * **La barre d'enregistrement couvre le composer**, comme chez Instagram : pendant
       * qu'on parle, le champ, le trombone et l'appareil photo n'ont rien à dire. Elle est
       * posée en absolu sur la rangée (qui porte `position: relative`) plutôt qu'insérée
       * dedans, pour une raison mécanique : le bouton micro doit rester **le même nœud du
       * DOM** du début à la fin du geste, sinon la capture de pointeur meurt avec lui et
       * le relâchement se perd.
       */}
      {enCours && (
        <div
          role="group"
          aria-label="Enregistrement en cours"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-2)",
            paddingInline: "var(--spacing-1)",
            background: "var(--color-background)",
            zIndex: 1,
          }}
        >
          {/* La poubelle est à l'autre bout de la rangée, là où le pouce doit aller la
              chercher : c'est la distance qui fait la sécurité du geste, pas un dialogue.
              Elle reste un vrai bouton — au clavier, l'annulation ne peut pas dépendre
              d'un glissement. */}
          <Button
            label="Annuler l'enregistrement"
            variant={arme ? "destructive" : "ghost"}
            isIconOnly
            icon={IconePoubelle}
            onClick={() => arreter(false)}
          />
          {/* Chiffres tabulaires : un compteur qui avance ne doit pas déplacer les boutons
              autour de lui (DESIGN.md). */}
          <Text type="supporting" className="tabulaire" aria-live="off">
            {dureeLisible(ecoule)}
          </Text>
          {/* L'instruction change au moment où le geste bascule : c'est le seul retour
              qu'on a pendant que le doigt masque la poubelle. */}
          <Text type="supporting" color="secondary" maxLines={1}>
            {arme ? "Relâchez pour annuler" : "Glissez vers la poubelle pour annuler"}
          </Text>
        </div>
      )}

      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          zIndex: 2,
          /* Sans quoi le navigateur lit le maintien comme un début de défilement, emporte
             le pointeur et annule le geste au premier pixel vertical. */
          touchAction: "none",
        }}
        onPointerDown={auDoigtPose}
        onPointerMove={auDoigtBouge}
        onPointerUp={auDoigtLeve}
        // Un appel qui arrive, une notification qui s'ouvre : le système reprend le
        // pointeur. On n'envoie pas un vocal que personne n'a décidé d'envoyer.
        onPointerCancel={() => enCours && arreter(false)}
      >
        <Button
          label={enCours ? "Envoyer le message vocal" : "Enregistrer un message vocal"}
          variant={enCours ? "primary" : "ghost"}
          isIconOnly
          icon={enCours ? IconeEnvoyer : IconeMicro}
          onClick={auClic}
        />
        {refus && (
          /* Au-dessus de la rangée, comme l'erreur d'envoi de `MediaPicker` : une phrase
             insérée *dans* la rangée en pousserait le champ hors de l'écran. */
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              insetInlineEnd: 0,
              width: "min(72vw, 22rem)",
              paddingBottom: "var(--spacing-1)",
            }}
          >
            <Text type="supporting" color="secondary">
              {REFUS[refus]}
            </Text>
          </div>
        )}
      </div>
    </>
  );
}
