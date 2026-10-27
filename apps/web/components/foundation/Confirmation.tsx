"use client";

import { Sheet } from "./Sheet";
import { Button, Text } from "./primitives";

interface ConfirmationProps {
  ouvert: boolean;
  titre: string;
  /** Ce que le geste fait **réellement** — interdit n°13 : jamais ce qu'on espère. */
  corps: string;
  /** Le libellé du bouton qui agit. Un verbe, jamais « OK ». */
  action: string;
  /**
   * `false` quand le geste répare au lieu de casser (débloquer). Le bouton redevient
   * alors le primaire doux, et c'est la seule différence entre les deux cas.
   */
  destructif?: boolean;
  /** L'appel est en vol : le bouton tourne, et rien ne se referme avant la réponse. */
  enCours?: boolean;
  onConfirmer: () => void;
  onAnnuler: () => void;
}

/**
 * La modale d'interruption du destructif, en un seul endroit.
 *
 * DESIGN.md n'autorise la modale centrée que pour ce qu'on ne peut pas défaire, et
 * impose qu'un composant soit « un fichier nommé, réutilisé partout, variations par
 * props ». Le profil la posait déjà ; supprimer une conversation en demande la même,
 * mot pour mot. Deux copies auraient divergé à la première retouche — celle du profil
 * porte déjà un cas (`débloquer`) que l'autre n'a pas, et c'est exactement par là que
 * ça commence.
 *
 * Le texte reste à l'appelant : lui seul sait ce que son geste détruit, et un gabarit
 * générique dirait « êtes-vous sûr ? », ce que DESIGN.md refuse.
 */
export function Confirmation({
  ouvert,
  titre,
  corps,
  action,
  destructif = true,
  enCours = false,
  onConfirmer,
  onAnnuler,
}: ConfirmationProps) {
  return (
    <Sheet ouvert={ouvert} onFermer={onAnnuler} ancrage="centre" titre={titre}>
      <div style={{ display: "grid", gap: "var(--spacing-3)", padding: "var(--spacing-4)" }}>
        <Text type="body" color="secondary">
          {corps}
        </Text>
        <div style={{ display: "flex", gap: "var(--spacing-2)", justifyContent: "flex-end" }}>
          <Button label="Annuler" variant="ghost" onClick={onAnnuler} />
          <Button
            label={action}
            variant={destructif ? "destructive" : "primary"}
            isLoading={enCours}
            onClick={onConfirmer}
          />
        </div>
      </div>
    </Sheet>
  );
}
