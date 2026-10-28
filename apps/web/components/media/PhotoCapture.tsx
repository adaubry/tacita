"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { IconeFermer, IconeRetour, IconeRetournerCamera } from "../foundation/icons";
import { Button, Text } from "../foundation/primitives";

/**
 * Deux causes distinctes, deux phrases : un refus se rattrape dans les réglages du
 * navigateur, une API absente ne se rattrape pas du tout. Les confondre enverrait
 * quelqu'un chercher une autorisation qui n'existe pas sur son appareil (interdit n°13).
 */
const REFUS = {
  refuse:
    "L'accès à la caméra a été refusé. Autorisez-le dans les réglages de votre navigateur, puis rouvrez cet écran.",
  indisponible:
    "Ce navigateur ne donne pas accès à la caméra. Vous pouvez joindre une photo déjà prise avec le bouton « + ».",
} as const;

type Face = "environment" | "user";

/** Le flux et la photo prise occupent **tout** l'écran, comme sur Instagram ou Snapchat. */
const PLEIN_ECRAN: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

/** Les barres posées sur l'image, en haut et en bas, au-delà des zones système. */
const BARRE_HAUT: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  display: "flex",
  justifyContent: "space-between",
  padding: "calc(env(safe-area-inset-top, 0px) + var(--spacing-3)) var(--spacing-3) 0",
};
const BARRE_BAS: CSSProperties = {
  position: "absolute",
  bottom: 0,
  left: 0,
  right: 0,
  display: "grid",
  justifyItems: "center",
  gap: "var(--spacing-2)",
  padding: "var(--spacing-8) var(--spacing-4) calc(env(safe-area-inset-bottom, 0px) + var(--spacing-6))",
  // Un dégradé plutôt qu'un bandeau : les boutons restent lisibles sur une photo claire
  // sans couper l'image d'un trait.
  background: "linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent)",
};

interface PhotoCaptureProps {
  ouvert: boolean;
  onFermer: () => void;
  /**
   * deux gestes distincts sur la **même** prise : l'original non compressé
   * reste sur l'appareil, la version compressée part au correspondant.
   */
  onEnregistrer: (original: Blob, nom: string) => Promise<void> | void;
  onEnvoyer: (photo: File) => void;
}

/**
 * La partie de l'image que l'aperçu montre vraiment. `object-fit: cover` rogne le flux
 * pour remplir l'écran : la photo est rognée de la même façon, sinon on découvrirait au
 * déclenchement des bords qu'on n'avait pas cadrés.
 */
function cadrageVisible(element: HTMLVideoElement) {
  const { videoWidth: largeur, videoHeight: hauteur, clientWidth, clientHeight } = element;
  if (!largeur || !hauteur || !clientWidth || !clientHeight) {
    return { x: 0, y: 0, largeur, hauteur };
  }
  const echelle = Math.max(clientWidth / largeur, clientHeight / hauteur);
  const visibleL = clientWidth / echelle;
  const visibleH = clientHeight / echelle;
  return { x: (largeur - visibleL) / 2, y: (hauteur - visibleH) / 2, largeur: visibleL, hauteur: visibleH };
}

/**
 * capture photo in-app, **en plein écran**.
 *
 * Elle vivait dans une feuille, l'aperçu borné à la moitié de l'écran : on cadrait dans
 * un carré, à l'inverse de toute application de messagerie actuelle. C'est désormais un
 * `<dialog>` modal qui couvre l'écran — couche supérieure, Échap, focus piégé, le tout
 * fourni par la plateforme —, l'image dessous et les contrôles par-dessus.
 *
 * **La permission est demandée au moment de l'usage**, jamais à l'avance (DESIGN.md), et
 * un refus est expliqué et rattrapable : il n'y a pas d'écran mort.
 *
 * ponytail: photo seulement, pas de vidéo. La capture vidéo produirait du WebM ou du
 * MP4/AAC selon l'appareil, qu'il faudrait transcoder pour envoyer — et
 * ce transcodage n'existe pas dans le shard (ESCALATIONS § E-10). Le bouton n'existe donc
 * pas non plus.
 */
export function PhotoCapture({ ouvert, onFermer, onEnregistrer, onEnvoyer }: PhotoCaptureProps) {
  const boite = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [flux, setFlux] = useState<MediaStream>();
  const [refus, setRefus] = useState<keyof typeof REFUS>();
  const [prise, setPrise] = useState<{ blob: Blob; url: string; nom: string }>();
  const [face, setFace] = useState<Face>("environment");

  useEffect(() => {
    const element = boite.current;
    if (!element) return;
    if (ouvert && !element.open) element.showModal();
    if (!ouvert && element.open) element.close();
  }, [ouvert]);

  useEffect(() => {
    if (!ouvert) {
      // **La prise ne survit pas à la fermeture.** Sans cette remise à zéro, l'écran
      // rouvert affichait la photo précédente à la place de la caméra : `<dialog>` garde
      // son contenu dans le DOM même fermé, donc rien ne la retirait de lui-même.
      setPrise(undefined);
      setRefus(undefined);
      setFace("environment");
      return;
    }

    let vivant = true;
    let ouvert_: MediaStream | undefined;

    // Hors contexte sécurisé — et sur les navigateurs qui ne l'implémentent pas —
    // `mediaDevices` est absent. L'optionnel court-circuitait toute la chaîne : aucun
    // flux, aucune erreur, et un bouton désactivé sans un mot d'explication.
    if (!navigator.mediaDevices) {
      setRefus("indisponible");
      return;
    }

    void navigator.mediaDevices
      .getUserMedia({
        // **Une définition demandée.** Sans elle, Safari donne 640 × 480 : la photo
        // « originale » enregistrée sur l'appareil l'était à peine. `ideal` et non
        // `exact` : une caméra qui n'atteint pas la cible rend ce qu'elle a, sans échouer.
        video: { facingMode: face, width: { ideal: 1920 }, height: { ideal: 1080 } },
      })
      .then((obtenu) => {
        if (!vivant) return obtenu.getTracks().forEach((piste) => piste.stop());
        ouvert_ = obtenu;
        setFlux(obtenu);
        if (video.current) video.current.srcObject = obtenu;
      })
      .catch(() => vivant && setRefus("refuse"));

    return () => {
      vivant = false;
      // La caméra s'éteint avec l'écran — et à chaque retournement, avant que l'autre ne
      // s'allume : une pastille d'enregistrement qui reste allumée après la fermeture est
      // une trahison de confiance, pas une fuite mémoire.
      ouvert_?.getTracks().forEach((piste) => piste.stop());
      setFlux(undefined);
    };
  }, [ouvert, face]);

  useEffect(() => () => {
    if (prise) URL.revokeObjectURL(prise.url);
  }, [prise]);

  // L'aperçu est démonté pendant qu'on regarde la photo prise : à « Reprendre », le
  // nouvel élément `<video>` n'a plus de source, et la caméra, pourtant allumée, restait
  // noire. Le flux lui est rebranché chaque fois qu'il réapparaît.
  useEffect(() => {
    if (!prise && flux && video.current && video.current.srcObject !== flux) {
      video.current.srcObject = flux;
    }
  }, [prise, flux]);

  // Le selfie se voit en miroir, comme dans un miroir — et se prend comme il se voit.
  const miroir = face === "user";

  const capturer = async () => {
    const element = video.current;
    if (!element) return;
    const cadre = cadrageVisible(element);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(cadre.largeur);
    canvas.height = Math.round(cadre.hauteur);
    const contexte = canvas.getContext("2d");
    if (miroir) {
      contexte?.translate(canvas.width, 0);
      contexte?.scale(-1, 1);
    }
    contexte?.drawImage(element, cadre.x, cadre.y, cadre.largeur, cadre.hauteur, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 1));
    // Le nom est figé **avec la prise**, pas recalculé à chaque rendu : la copie
    // enregistrée sur l'appareil et celle envoyée au correspondant — la même photo —
    // sortaient sous deux noms différents dès qu'une seconde séparait les deux clics.
    const nom = `photo-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.jpg`;
    if (blob) setPrise({ blob, url: URL.createObjectURL(blob), nom });
  };

  return (
    <dialog
      ref={boite}
      aria-label="Prendre une photo"
      // Échap : le navigateur ferme le dialogue de lui-même. On le laisse au parent, qui
      // tient `ouvert` — sinon les deux divergeraient.
      onCancel={(evenement) => {
        evenement.preventDefault();
        onFermer();
      }}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100dvh",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: 0,
        // Les jetons du visionneur plein écran : sombres dans les deux thèmes, faits pour
        // une image sur fond neutre — c'est exactement ce qu'est la caméra.
        background: "var(--tacita-viewer)",
        // La caméra est un écran sombre quel que soit le thème : les jetons en
        // `light-dark()` y prennent leur valeur sombre, et le verre se lit sur l'image.
        colorScheme: "dark",
        color: "var(--tacita-sur-viewer)",
        overflow: "hidden",
        // Ni défilement ni zoom au doigt sous la caméra.
        touchAction: "none",
      }}
    >
      {ouvert && (
        <>
          {refus ? (
            <div style={{ ...PLEIN_ECRAN, display: "grid", placeItems: "center", padding: "var(--spacing-6)" }}>
              <Text type="body">{REFUS[refus]}</Text>
            </div>
          ) : prise ? (
            <img src={prise.url} alt="Photo prise" style={PLEIN_ECRAN} />
          ) : (
            /*
             * Flux de la caméra : aucune piste de sous-titres à fournir, et l'aperçu est
             * décrit par son `aria-label`. La taille est **imposée** par l'écran, jamais
             * par le flux — un `<video>` prend sinon la résolution du flux comme taille
             * intrinsèque, et débordait de tout son conteneur.
             */
            <video
              ref={video}
              autoPlay
              playsInline
              muted
              aria-label="Aperçu de la caméra"
              style={{ ...PLEIN_ECRAN, transform: miroir ? "scaleX(-1)" : undefined }}
            />
          )}

          <div style={BARRE_HAUT}>
            {prise ? (
              <Button
                label="Reprendre"
                variant="ghost"
                isIconOnly
                icon={IconeRetour}
                className="tacita-retour"
                onClick={() => setPrise(undefined)}
              />
            ) : (
              <Button
                label="Fermer la caméra"
                variant="ghost"
                isIconOnly
                icon={IconeFermer}
                className="tacita-retour"
                onClick={onFermer}
              />
            )}
            {!prise && !refus && (
              <Button
                label={face === "environment" ? "Passer à la caméra avant" : "Passer à la caméra arrière"}
                variant="ghost"
                isIconOnly
                icon={IconeRetournerCamera}
                className="tacita-retour"
                onClick={() => setFace(face === "environment" ? "user" : "environment")}
              />
            )}
          </div>

          {!refus && (
            <div style={BARRE_BAS}>
              {prise ? (
                <>
                  {/* les deux libellés sont **distincts et explicites** : ce qui reste sur
                      l'appareil est l'original, ce qui part est compressé. Confondre les
                      deux ferait croire que le correspondant reçoit la pleine qualité.
                      L'envoi est la primaire : c'est ce qu'on vient faire ici. */}
                  <Button
                    label="Envoyer (version compressée)"
                    variant="primary"
                    width="100%"
                    onClick={() => {
                      onEnvoyer(new File([prise.blob], prise.nom, { type: "image/jpeg" }));
                      onFermer();
                    }}
                  />
                  <Button
                    label="Enregistrer sur votre appareil (original)"
                    variant="secondary"
                    width="100%"
                    onClick={() => void onEnregistrer(prise.blob, prise.nom)}
                  />
                </>
              ) : (
                /*
                 * Le déclencheur : un anneau blanc autour d'un disque, la forme que tout le
                 * monde reconnaît. Écrit à la main parce qu'aucune primitive d'Astryx n'a
                 * cette forme — et il n'a rien à hériter de la règle des primaires : il n'est
                 * pas un bouton parmi d'autres, il est l'écran.
                 */
                <button
                  type="button"
                  aria-label="Prendre la photo"
                  disabled={!flux}
                  onClick={() => void capturer()}
                  className="tacita-declencheur"
                />
              )}
            </div>
          )}
        </>
      )}
    </dialog>
  );
}
