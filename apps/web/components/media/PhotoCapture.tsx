"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";

import { IconeFermer, IconeRetour, IconeRetournerCamera, IconeTexte } from "../foundation/icons";
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

/**
 * **Le texte posé sur la photo**, et ses mesures. Les mêmes valeurs servent à l'écran et
 * à l'incrustation dans l'image : la police surtout, écrite ici plutôt que lue dans
 * `--font-family-body` — un canvas ne lit pas les variables CSS, et deux polices
 * différentes ne couperaient pas les lignes aux mêmes endroits.
 */
const POLICE = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const TAILLE_TEXTE = 28;
const INTERLIGNE = 1.25;
/** Le texte ne s'étend pas au-delà de cette part de la largeur de l'écran. */
const LARGEUR_TEXTE = 0.8;
const OMBRE_TEXTE = "rgba(0, 0, 0, 0.5)";

/** Position en fractions de l'écran, centre du texte : elle vaut pour n'importe quelle taille. */
interface TexteSurPhoto {
  valeur: string;
  x: number;
  y: number;
}

/** Les lignes telles que le navigateur les couperait : aux sauts de ligne, puis aux mots. */
function couper(contexte: CanvasRenderingContext2D, texte: string, largeurMax: number): string[] {
  const lignes: string[] = [];
  for (const paragraphe of texte.split("\n")) {
    let ligne = "";
    for (const mot of paragraphe.split(" ")) {
      const essai = ligne ? `${ligne} ${mot}` : mot;
      if (ligne && contexte.measureText(essai).width > largeurMax) {
        lignes.push(ligne);
        ligne = mot;
      } else {
        ligne = essai;
      }
    }
    lignes.push(ligne);
  }
  return lignes;
}

/**
 * **Le texte entre dans l'image**, là où on l'a vu. La photo est affichée en
 * `object-fit: cover` : chaque point de l'écran se ramène à un pixel de l'image par la
 * même échelle, et la taille du texte avec lui.
 *
 * ponytail: un seul texte, blanc, une taille. Plusieurs textes, des couleurs et le
 * pincement pour agrandir le jour où on les demande.
 */
async function incruster(
  photo: Blob,
  texte: TexteSurPhoto,
  ecran: { largeur: number; hauteur: number },
): Promise<Blob> {
  const image = await createImageBitmap(photo);
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const contexte = canvas.getContext("2d");
  if (!contexte) return photo;
  contexte.drawImage(image, 0, 0);

  const echelle = Math.max(ecran.largeur / image.width, ecran.hauteur / image.height);
  const decalageX = (ecran.largeur - image.width * echelle) / 2;
  const decalageY = (ecran.hauteur - image.height * echelle) / 2;
  const centreX = (texte.x * ecran.largeur - decalageX) / echelle;
  const centreY = (texte.y * ecran.hauteur - decalageY) / echelle;
  const taille = TAILLE_TEXTE / echelle;

  contexte.font = `700 ${taille}px ${POLICE}`;
  contexte.textAlign = "center";
  contexte.textBaseline = "middle";
  contexte.fillStyle = "white";
  contexte.shadowColor = OMBRE_TEXTE;
  contexte.shadowBlur = 8 / echelle;

  const lignes = couper(contexte, texte.valeur, (LARGEUR_TEXTE * ecran.largeur) / echelle);
  const hauteurLigne = taille * INTERLIGNE;
  lignes.forEach((ligne, rang) =>
    contexte.fillText(ligne, centreX, centreY + (rang - (lignes.length - 1) / 2) * hauteurLigne),
  );

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob ?? photo), "image/jpeg", 1));
}

const STYLE_TEXTE: CSSProperties = {
  fontFamily: POLICE,
  fontWeight: 700,
  fontSize: TAILLE_TEXTE,
  lineHeight: INTERLIGNE,
  textAlign: "center",
  color: "white",
  textShadow: `0 0 8px ${OMBRE_TEXTE}`,
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
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
  const [texte, setTexte] = useState<TexteSurPhoto | null>(null);
  /** La saisie en cours ; `null` hors saisie. */
  const [saisie, setSaisie] = useState<string | null>(null);
  const glisse = useRef<{ x: number; y: number; depuisX: number; depuisY: number; bouge: boolean } | null>(
    null,
  );

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
      setTexte(null);
      setSaisie(null);
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

  /** Ce qui part et ce qui s'enregistre : la prise, texte incrusté s'il y en a un. */
  const photoFinale = async (blob: Blob) => {
    const element = boite.current;
    if (!texte || !element) return blob;
    // Une incrustation qui échoue rend la photo sans texte plutôt que rien du tout.
    return incruster(blob, texte, { largeur: element.clientWidth, hauteur: element.clientHeight }).catch(
      () => blob,
    );
  };

  const validerSaisie = () => {
    const valeur = (saisie ?? "").trim();
    setTexte(valeur ? { x: 0.5, y: 0.4, ...texte, valeur } : null);
    setSaisie(null);
  };

  /*
   * **Le texte se déplace au doigt**, et un toucher bref le rouvre en saisie. La position
   * est en fractions de l'écran : c'est elle que l'incrustation relit.
   */
  const gestesTexte = {
    onPointerDown(evenement: PointerEvent<HTMLDivElement>) {
      if (!texte) return;
      evenement.currentTarget.setPointerCapture?.(evenement.pointerId);
      glisse.current = {
        x: evenement.clientX,
        y: evenement.clientY,
        depuisX: texte.x,
        depuisY: texte.y,
        bouge: false,
      };
    },
    onPointerMove(evenement: PointerEvent<HTMLDivElement>) {
      const depart = glisse.current;
      const element = boite.current;
      if (!depart || !texte || !element?.clientWidth || !element.clientHeight) return;
      const ecartX = evenement.clientX - depart.x;
      const ecartY = evenement.clientY - depart.y;
      if (!depart.bouge && Math.hypot(ecartX, ecartY) < 4) return;
      depart.bouge = true;
      // Jamais tout à fait au bord : un texte qu'on ne peut plus attraper ne se rattrape pas.
      const borner = (valeur: number) => Math.min(Math.max(valeur, 0.05), 0.95);
      setTexte({
        ...texte,
        x: borner(depart.depuisX + ecartX / element.clientWidth),
        y: borner(depart.depuisY + ecartY / element.clientHeight),
      });
    },
    onPointerUp() {
      const depart = glisse.current;
      glisse.current = null;
      if (depart && !depart.bouge && texte) setSaisie(texte.valeur);
    },
  };

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
            <>
              <img src={prise.url} alt="Photo prise" style={PLEIN_ECRAN} />
              {texte && saisie === null && (
                <div
                  aria-label={`Texte sur la photo : ${texte.valeur}`}
                  {...gestesTexte}
                  style={{
                    ...STYLE_TEXTE,
                    position: "absolute",
                    left: `${texte.x * 100}%`,
                    top: `${texte.y * 100}%`,
                    transform: "translate(-50%, -50%)",
                    maxWidth: `${LARGEUR_TEXTE * 100}%`,
                    touchAction: "none",
                    cursor: "grab",
                  }}
                >
                  {texte.valeur}
                </div>
              )}
              {saisie !== null && (
                // La saisie : l'image se voile, le champ prend le centre — et le clavier.
                <div
                  style={{
                    ...PLEIN_ECRAN,
                    display: "grid",
                    placeItems: "center",
                    background: "rgba(0, 0, 0, 0.4)",
                  }}
                >
                  <textarea
                    aria-label="Texte à poser sur la photo"
                    autoFocus
                    rows={3}
                    value={saisie}
                    onChange={(evenement) => setSaisie(evenement.target.value)}
                    style={{
                      ...STYLE_TEXTE,
                      width: `${LARGEUR_TEXTE * 100}%`,
                      background: "transparent",
                      border: 0,
                      outline: "none",
                      resize: "none",
                      caretColor: "white",
                    }}
                  />
                </div>
              )}
            </>
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
                isDisabled={saisie !== null}
                onClick={() => {
                  setPrise(undefined);
                  setTexte(null);
                }}
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
            {prise && saisie === null && (
              <Button
                label={texte ? "Modifier le texte" : "Ajouter du texte"}
                variant="ghost"
                isIconOnly
                icon={IconeTexte}
                className="tacita-retour"
                onClick={() => setSaisie(texte?.valeur ?? "")}
              />
            )}
            {saisie !== null && <Button label="Terminé" variant="primary" onClick={validerSaisie} />}
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

          {!refus && saisie === null && (
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
                    onClick={() =>
                      void photoFinale(prise.blob).then((photo) => {
                        onEnvoyer(new File([photo], prise.nom, { type: "image/jpeg" }));
                        onFermer();
                      })
                    }
                  />
                  <Button
                    label="Enregistrer sur votre appareil (original)"
                    variant="secondary"
                    width="100%"
                    onClick={() => void photoFinale(prise.blob).then((photo) => onEnregistrer(photo, prise.nom))}
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
