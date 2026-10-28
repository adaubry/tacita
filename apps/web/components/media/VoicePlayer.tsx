"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";

import { IconeLecture, IconePause } from "../foundation/icons";
import { Button, Text } from "../foundation/primitives";
import { dureeLisible } from "./media";

interface VoicePlayerProps {
  /** URL d'objet du blob **déchiffré**. Jamais une URL serveur. */
  source?: string;
  dureeMs: number;
  /** pics 0–1024 calculés à l'envoi, transportés dans l'événement. */
  ondes?: number[];
}

const HAUTEUR = 28;
const ECHELLE = 1024;

/** Les vitesses proposées, dans l'ordre où la pastille les fait défiler. */
const VITESSES = [1, 1.5, 2] as const;
const libelleVitesse = (vitesse: number) => `${String(vitesse).replace(".", ",")}×`;

/** Tenu au-delà, un appui sur la forme d'onde est une recherche, plus un toucher. */
const DUREE_MAINTIEN_MS = 250;
/** Un glissement horizontal plus franc que ça est une recherche, même avant le délai. */
const SEUIL_GLISSEMENT_PX = 4;

/**
 * lecteur vocal avec forme d'onde et durée.
 *
 * DESIGN.md : « barres verticales strictes sur la grille ». Les pics viennent de
 * l'événement (le paquet les a calculés à l'envoi) — les recalculer à la
 * lecture demanderait de décoder tout l'audio pour dessiner un rectangle.
 *
 * La barre lue est en accent, le reste en filet : la progression se lit sans curseur.
 *
 * **Trois gestes, comme sur Instagram** :
 * - toucher n'importe où sur le vocal le lance ou le met en pause — le bouton reste,
 *   c'est lui que trouvent le clavier et le lecteur d'écran ;
 * - maintenir ou glisser sur la forme d'onde choisit l'endroit, et la lecture reprend
 *   de là au relâcher ;
 * - la pastille de vitesse fait défiler 1×, 1,5×, 2×.
 */
export function VoicePlayer({ source, dureeMs, ondes = [] }: VoicePlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const forme = useRef<HTMLDivElement>(null);
  const [lecture, setLecture] = useState(false);
  const [ecoulee, setEcoulee] = useState(0);
  const [vitesse, setVitesse] = useState<number>(1);
  /** La position sous le doigt pendant une recherche, 0–1 ; `null` hors recherche. */
  const [visee, setVisee] = useState<number | null>(null);

  const appui = useRef<{ x: number; debut: number } | null>(null);
  const maintien = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lacherMaintien = () => {
    if (maintien.current) clearTimeout(maintien.current);
    maintien.current = null;
  };
  /** Une recherche vient de finir : le clic qui suit le relâcher ne doit rien basculer. */
  const rechercheFinie = useRef(false);

  useEffect(() => {
    // Un changement de source (nouveau message rendu au même endroit) remet le lecteur
    // à zéro : sans ça, la progression du précédent reste affichée sur le suivant.
    setEcoulee(0);
    setLecture(false);
  }, [source]);

  // Un `<audio>` remet sa vitesse à 1 quand il charge une source : elle est reposée ici
  // plutôt qu'une fois pour toutes.
  useEffect(() => {
    if (audio.current) audio.current.playbackRate = vitesse;
  }, [vitesse, source]);

  const progression = visee ?? (dureeMs > 0 ? Math.min(ecoulee / dureeMs, 1) : 0);

  const lire = () => {
    const element = audio.current;
    if (!element || source === undefined) return;
    element.playbackRate = vitesse;
    void element.play();
    setLecture(true);
  };

  const basculer = () => {
    if (lecture) {
      audio.current?.pause();
      setLecture(false);
    } else {
      lire();
    }
  };

  /** La fraction de la forme d'onde sous le doigt, bornée à ses bords. */
  const fractionSous = (clientX: number) => {
    const cadre = forme.current?.getBoundingClientRect();
    if (!cadre || cadre.width === 0) return 0;
    return Math.min(Math.max((clientX - cadre.left) / cadre.width, 0), 1);
  };

  /*
   * **La forme d'onde garde ses événements pour elle.** La bulle qui l'entoure répond au
   * glissement (répondre) et à l'appui long (menu) : sans `stopPropagation`, choisir un
   * endroit du vocal ouvrait le menu, et un glissement vers la gauche devenait une
   * réponse. Le menu reste à un appui long partout ailleurs sur la bulle.
   */
  const gestes = {
    onPointerDown(evenement: PointerEvent<HTMLDivElement>) {
      evenement.stopPropagation();
      if (source === undefined) return;
      appui.current = { x: evenement.clientX, debut: Date.now() };
      // Tenu sans bouger, le doigt choisit déjà : la forme le montre sans attendre un
      // mouvement qui ne viendra pas.
      const { clientX, pointerId, currentTarget } = evenement;
      lacherMaintien();
      maintien.current = setTimeout(() => {
        currentTarget.setPointerCapture?.(pointerId);
        setVisee(fractionSous(clientX));
      }, DUREE_MAINTIEN_MS);
    },
    onPointerMove(evenement: PointerEvent<HTMLDivElement>) {
      evenement.stopPropagation();
      const depart = appui.current;
      if (!depart) return;
      const enRecherche =
        visee !== null ||
        Math.abs(evenement.clientX - depart.x) > SEUIL_GLISSEMENT_PX ||
        Date.now() - depart.debut >= DUREE_MAINTIEN_MS;
      if (!enRecherche) return;
      lacherMaintien();
      if (visee === null) evenement.currentTarget.setPointerCapture?.(evenement.pointerId);
      setVisee(fractionSous(evenement.clientX));
    },
    onPointerUp(evenement: PointerEvent<HTMLDivElement>) {
      evenement.stopPropagation();
      const depart = appui.current;
      appui.current = null;
      lacherMaintien();
      if (!depart) return;

      // Maintenu sans bouger : c'est une recherche aussi, sur le point tenu.
      const tenu = Date.now() - depart.debut >= DUREE_MAINTIEN_MS;
      if (visee === null && !tenu) return; // un toucher : le clic fera la bascule

      const fraction = visee ?? fractionSous(evenement.clientX);
      setVisee(null);
      rechercheFinie.current = true;
      const element = audio.current;
      if (!element) return;
      element.currentTime = (fraction * dureeMs) / 1000;
      setEcoulee(fraction * dureeMs);
      lire();
    },
    // Le défilement vertical a repris la main (`touch-action: pan-y`) : rien n'est choisi.
    onPointerCancel(evenement: PointerEvent<HTMLDivElement>) {
      evenement.stopPropagation();
      appui.current = null;
      lacherMaintien();
      setVisee(null);
    },
  };

  const restant = visee !== null ? dureeMs * (1 - visee) : lecture || ecoulee > 0 ? dureeMs - ecoulee : dureeMs;

  return (
    <div
      onClick={() => {
        if (rechercheFinie.current) {
          rechercheFinie.current = false;
          return;
        }
        basculer();
      }}
      style={{ display: "flex", alignItems: "center", gap: "var(--spacing-2)", cursor: "pointer" }}
    >
      {/* Sans `onClick` à lui : le clic remonte au vocal entier, qui bascule une fois. */}
      <Button
        label={lecture ? "Pause" : "Lire le message vocal"}
        variant="ghost"
        isIconOnly
        icon={lecture ? IconePause : IconeLecture}
        isDisabled={source === undefined}
      />

      {/*
       * Les barres **se partagent la largeur** au lieu d'imposer la leur : 61 barres de
       * 2 px + 2 px d'écart réclamaient ~244 px, plus que certaines bulles à 393 px. Et la
       * recherche a besoin que chaque abscisse de la forme corresponde exactement à un
       * instant du vocal — `space-between` étale les barres d'un bord à l'autre.
       */}
      <div
        ref={forme}
        aria-hidden
        data-forme-onde
        {...gestes}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: HAUTEUR,
          flex: 1,
          minWidth: 0,
          touchAction: "pan-y",
        }}
      >
        {ondes.map((pic, rang) => (
          <span
            key={rang}
            style={{
              flex: "0 1 2px",
              minWidth: 1,
              // Une barre de hauteur nulle disparaît : le minimum de 2 px garde la
              // grille lisible sur un silence.
              height: Math.max(2, Math.round((pic / ECHELLE) * HAUTEUR)),
              borderRadius: 1,
              background:
                rang / ondes.length <= progression
                  ? "var(--color-accent)"
                  : "var(--color-border-emphasized)",
            }}
          />
        ))}
      </div>

      {/*
       * Le temps ne cède jamais : `body` pose `overflow-wrap: anywhere`, qui compte dans la
       * largeur minimale — la colonne pouvait donc se réduire à un caractère, et « 0:03 »
       * s'écrivait sur deux lignes. C'est la forme d'onde qui rétrécit, pas lui.
       */}
      <div style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
        <Text type="supporting" color="secondary" hasTabularNumbers>
          {dureeLisible(restant)}
        </Text>
      </div>

      {/* La vitesse n'a de sens qu'une fois le vocal lancé : avant, elle prendrait la
          place de la forme d'onde pour une question que personne ne se pose encore. */}
      {(lecture || ecoulee > 0) && (
        <Button
          label={`Vitesse de lecture : ${libelleVitesse(vitesse)}`}
          variant="secondary"
          size="sm"
          onClick={(evenement) => {
            evenement.stopPropagation();
            setVitesse(VITESSES[(VITESSES.indexOf(vitesse as (typeof VITESSES)[number]) + 1) % VITESSES.length]!);
          }}
        >
          {libelleVitesse(vitesse)}
        </Button>
      )}

      {/* Élément de lecture nu : le contrôle accessible est le bouton ci-dessus, et un
          vocal n'a pas de piste de sous-titres à fournir. */}
      <audio
        ref={audio}
        src={source}
        onTimeUpdate={(evenement) => setEcoulee(evenement.currentTarget.currentTime * 1000)}
        onEnded={() => {
          setLecture(false);
          setEcoulee(0);
        }}
      />
    </div>
  );
}
