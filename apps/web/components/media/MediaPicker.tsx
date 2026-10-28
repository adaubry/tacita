"use client";

import { useRef } from "react";

import { IconePlus } from "../foundation/icons";
import { Button, Text } from "../foundation/primitives";

/**
 * Ce que le pipeline accepte — **la vidéo comprise, partout**.
 *
 * Elle était conditionnée à la capacité d'encodage de ce navigateur, mesurée avant
 * d'afficher quoi que ce soit. Depuis le chemin rapide, une source déjà conforme aux
 * cibles est **remuxée**, ce qui ne demande aucun encodeur : conditionner le choix
 * reviendrait à refuser d'avance des vidéos que l'appareil sait parfaitement traiter.
 *
 * Ce que ça déplace, et que impose de traiter : l'échec devient un **résultat**
 * et non plus un prédicat. Une source non conforme sur un appareil sans encodeur échoue,
 * et elle échoue avec sa phrase à elle (`erreur`), pas avec un bouton absent.
 */
export const TYPES_ACCEPTES = "image/*,video/*,application/pdf,application/zip,text/*";

interface MediaPickerProps {
  onFichiers: (fichiers: File[]) => void;
  /** Envoi en cours : le pipeline n'expose pas de progression, seulement un état. */
  enCours?: boolean;
  onAnnuler?: () => void;
  /**
   * l'échec dédié de la compression, quand il arrive. Distinct de l'absence
   * de bouton : « ça n'a pas marché ici » n'est pas « ce n'est pas proposé ».
   */
  erreur?: string;
  /** Mesuré au montage par le câblage, jamais supposé. */
}

/**
 * la sélection de pièces jointes.
 *
 * ponytail: état d'envoi binaire, pas de barre de progression. `uploadAttachment`
 * ne rapporte rien pendant la compression ni pendant le téléversement — une
 * barre serait une animation inventée, pas une mesure. Passer à une vraie barre le jour
 * où le paquet expose un rappel de progression.
 */
export function MediaPicker({
  onFichiers,
  enCours = false,
  onAnnuler,
  erreur,
}: MediaPickerProps) {
  const champ = useRef<HTMLInputElement>(null);

  /**
   * Les deux messages flottent **au-dessus** de la rangée du composer, jamais dedans.
   *
   * Dedans, « Envoi en cours… » et son bouton d'annulation prenaient la moitié d'un écran
   * de téléphone et écrasaient le champ de saisie le temps d'un téléversement — la barre
   * changeait de forme pendant qu'on écrit. Hors flux, la rangée garde la largeur du seul
   * bouton, et le message paraît là où l'indicateur de frappe paraît déjà.
   */
  const messageFlottant = {
    position: "absolute",
    bottom: "100%",
    insetInlineStart: 0,
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-2)",
    whiteSpace: "nowrap",
    paddingBottom: "var(--spacing-1)",
  } as const;

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <input
        ref={champ}
        type="file"
        multiple
        accept={TYPES_ACCEPTES}
        aria-label="Joindre des fichiers"
        hidden
        onChange={(evenement) => {
          const choisis = [...(evenement.target.files ?? [])];
          if (choisis.length > 0) onFichiers(choisis);
          evenement.target.value = "";
        }}
      />

      {/* Une icône seule, comme le « + » de WhatsApp et de Discord : dans une barre où
          l'on écrit dix fois plus souvent qu'on ne joint, un libellé coûterait la largeur
          qui revient au texte. Le bouton **reste en place** pendant l'envoi — il tourne au
          lieu de disparaître : une rangée dont un élément s'efface se réorganise sous le
          doigt, et c'est le champ voisin qui bouge. */}
      <Button
        label="Joindre"
        variant="ghost"
        isIconOnly
        icon={IconePlus}
        isLoading={enCours}
        onClick={() => champ.current?.click()}
      />

      {enCours && (
        <div style={messageFlottant}>
          <Text type="supporting" color="secondary">
            Envoi en cours…
          </Text>
          {onAnnuler && <Button label="Annuler l'envoi" variant="ghost" onClick={onAnnuler} />}
        </div>
      )}

      {erreur && !enCours && (
        /*
         * **Un avis passe à la ligne**, contrairement à « Envoi en cours… » : le sien est une
         * phrase, parfois deux, et en `nowrap` elle sortait de l'écran par la droite — on
         * n'en lisait que le début. Largeur de l'écran moins la marge de la barre, et un
         * fond, parce qu'elle se pose désormais sur plusieurs lignes de conversation.
         */
        <div
          style={{
            ...messageFlottant,
            whiteSpace: "normal",
            width: "calc(100vw - 2 * var(--spacing-2))",
            paddingTop: "var(--spacing-1)",
            background: "var(--color-background-body)",
          }}
        >
          <Text type="supporting" color="secondary">
            {erreur}
          </Text>
        </div>
      )}
    </div>
  );
}
