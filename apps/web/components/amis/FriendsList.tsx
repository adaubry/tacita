"use client";

import type { Profile } from "@tacita/messaging";

import type { Demande } from "../../lib/contacts";
import { identifiantCourt } from "../../lib/identifiants";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { Button, ClickableCard, Text } from "../foundation/primitives";

interface SuggestionsProps {
  profils: Profile[];
  onOuvrirProfil: (userId: string) => void;
}

/**
 * composant 16, variation **suggestion** : une carte cliquable qui mène au
 * profil. Elle ne porte aucune action directe — ajouter quelqu'un se décide sur son
 * profil, après l'avoir regardé, pas depuis une ligne de résultat.
 */
export function Suggestions({ profils, onOuvrirProfil }: SuggestionsProps) {
  return (
    <div
      role="list"
      aria-label="Résultats"
      style={{ display: "grid", gap: "var(--spacing-1)", padding: "var(--spacing-3)" }}
    >
      {profils.map((profil) => (
        <div role="listitem" key={profil.userId}>
          <ClickableCard
            label={profil.displayName}
            padding={3}
            onClick={() => onOuvrirProfil(profil.userId)}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-3)" }}>
              <ConversationAvatar nom={profil.displayName} direct taille={40} cle={profil.userId} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text type="body" weight="bold" maxLines={1}>
                  {profil.displayName}
                </Text>
                {/* sans le domaine : c'est le même pour tout le monde. */}
                <Text type="supporting" color="secondary" maxLines={1}>
                  {identifiantCourt(profil.userId)}
                </Text>
              </div>
            </div>
          </ClickableCard>
        </div>
      ))}
    </div>
  );
}

interface DemandesListProps {
  demandes: Demande[];
  onAccepter: (demande: Demande) => void;
  onRefuser: (demande: Demande) => void;
}

/**
 * composant 16, variation **demande** : accepter en vert, refuser en rouge.
 *
 * Les deux couleurs sont les seules de l'app à porter un sens par elles-mêmes ; elles
 * sont doublées par leur libellé, parce qu'une paire vert/rouge seule est illisible pour
 * une bonne part des daltonismes.
 */
export function DemandesList({ demandes, onAccepter, onRefuser }: DemandesListProps) {
  return (
    <div
      role="list"
      aria-label="Demandes"
      style={{ display: "grid", gap: "var(--spacing-1)", padding: "var(--spacing-3)" }}
    >
      {demandes.map((demande) => (
        <div
          role="listitem"
          key={demande.roomId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-3)",
            padding: "var(--spacing-2)",
          }}
        >
          <ConversationAvatar nom={demande.nom} direct taille={40} cle={demande.userId ?? demande.roomId} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text type="body" weight="bold" maxLines={1}>
              {demande.nom}
            </Text>
            {demande.userId && (
              <Text type="supporting" color="secondary" maxLines={1}>
                {identifiantCourt(demande.userId)}
              </Text>
            )}
          </div>

          <div style={{ display: "flex", gap: "var(--spacing-2)" }}>
            <Button
              label="Accepter"
              variant="primary"
              size="sm"
              /*
               * **Aucune surcharge de fond** (revue de conception E-10). Le
               * commentaire qui vivait ici disait l'inverse de DESIGN.md : la table pose
               * `success` = `accent`, « pas de second vert ». La ligne repeignait donc un
               * bouton primaire de sa propre couleur — sans effet, mais en laissant croire
               * qu'une seconde famille de vert existait. Son voisin « Refuser » repasse en
               * `secondary` : `danger` est réservé au destructif, et refuser une demande
               * n'efface aucune donnée de l'utilisateur.
               */
              className="tacita-bouton-doux"
              onClick={() => onAccepter(demande)}
            />
            {/* `ghost` et non `secondary` : le poids suffit à dire laquelle des deux
                actions est la principale — et refuser n'efface rien, donc pas de `danger`.
                Le contour ne lui rend pas ce poids, il lui rend la forme de son voisin :
                une pilule à côté d'un libellé nu ne se lit plus comme une paire. */}
            <Button
              label="Refuser"
              variant="ghost"
              size="sm"
              className="tacita-bouton-contour"
              onClick={() => onRefuser(demande)}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
