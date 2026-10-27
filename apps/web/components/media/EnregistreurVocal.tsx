"use client";

import { useEffect, useRef, useState } from "react";

import { fichierVocal, vocalDisponible } from "../../lib/vocal";
import { IconeEnvoyer, IconeFermer, IconeMicro } from "../foundation/icons";
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
 */
const DUREE_MIN_MS = 800;

interface EnregistreurVocalProps {
  /** Le fichier produit part par le même chemin qu'une pièce jointe choisie à la main. */
  onEnvoyer: (fichier: File) => void;
  /** Injecté en test : `MediaRecorder` n'existe pas dans jsdom. */
  portee?: typeof globalThis;
}

/**
 * **Le bouton micro, et l'enregistrement qu'il ouvre.**
 *
 * Toucher pour démarrer, toucher pour envoyer — pas de maintien du doigt. Le maintien
 * avec glissement d'annulation est un geste qui ne se découvre pas, qui n'a pas
 * d'équivalent au clavier, et que DESIGN.md obligerait donc à doubler d'un chemin
 * visible : autant n'avoir que celui-là. Deux appuis valent un geste qu'on rate.
 *
 * Le composant **ne se rend pas du tout** quand l'appareil n'offre aucun format : c'est la
 * règle que `Composer` posait déjà en refusant un micro inerte. Un bouton absent se
 * comprend ; un bouton qui échoue au moment d'envoyer, non.
 */
export function EnregistreurVocal({ onEnvoyer, portee = globalThis }: EnregistreurVocalProps) {
  const format = vocalDisponible(portee);

  const [enCours, setEnCours] = useState(false);
  const [ecoule, setEcoule] = useState(0);
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
    setEnCours(false);
    setEcoule(0);
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

  if (!format) return null;

  if (!enCours) {
    return (
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <Button
          label="Enregistrer un message vocal"
          variant="ghost"
          isIconOnly
          icon={IconeMicro}
          onClick={() => void demarrer()}
        />
        {refus && (
          /* Au-dessus de la rangée, comme l'erreur d'envoi de `MediaPicker` : une phrase
             insérée *dans* la rangée en pousserait le champ hors de l'écran. */
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              insetInlineStart: 0,
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
    );
  }

  return (
    <div
      role="group"
      aria-label="Enregistrement en cours"
      style={{ display: "flex", alignItems: "center", gap: "var(--spacing-1)" }}
    >
      {/* L'annulation est un geste destructif : elle vient en premier, loin du pouce qui
          vise « Envoyer », et porte l'icône de fermeture plutôt qu'un libellé qui
          élargirait la rangée. */}
      <Button
        label="Annuler l'enregistrement"
        variant="ghost"
        isIconOnly
        icon={IconeFermer}
        onClick={() => arreter(false)}
      />
      {/* Chiffres tabulaires : un compteur qui avance ne doit pas déplacer les boutons
          autour de lui (DESIGN.md). */}
      <Text type="supporting" className="tabulaire" aria-live="off">
        {dureeLisible(ecoule)}
      </Text>
      <Button
        label="Envoyer le message vocal"
        variant="primary"
        className="tacita-bouton-doux"
        isIconOnly
        icon={IconeEnvoyer}
        onClick={() => arreter(true)}
      />
    </div>
  );
}
