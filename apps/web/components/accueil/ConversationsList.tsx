"use client";

import type { Conversation } from "@tacita/messaging";

import { IconeConversation } from "../foundation/icons";
import { Placeholder } from "../foundation/Placeholder";
import { Button } from "../foundation/primitives";
import { ConversationPreview } from "./ConversationPreview";
import { Skeleton } from "../foundation/Skeleton";

export type Tri = "recentes" | "anciennes";

interface ConversationsListProps {
  conversations: Conversation[];
  /** Skeletons tant que le premier /sync n'a rien rendu. */
  chargement?: boolean;
  tri?: Tri;
  onOuvrir: (roomId: string) => void;
  onEpingler: (roomId: string, epingle: boolean) => void;
  onQuitter?: (roomId: string) => Promise<void>;
  /** L'action de l'état vide — « démarrez votre première conversation ». */
  onDemarrer?: () => void;
  maintenant?: number;
}

/**
 * Épinglées en tête, tri appliqué au reste (contrainte M-C). Le package rend déjà la
 * liste de la plus récente à la plus ancienne : « anciennes » est cette liste à
 * l'envers, et les épingles s'en extraient avant, sinon le tri les déplacerait.
 */
export function ordonner(conversations: Conversation[], tri: Tri): Conversation[] {
  const ordonnees = tri === "recentes" ? conversations : [...conversations].reverse();
  return [
    ...ordonnees.filter((conversation) => conversation.pinned),
    ...ordonnees.filter((conversation) => !conversation.pinned),
  ];
}

/**
 * la liste des conversations (composant 3).
 *
 * ponytail: rendu intégral, sans virtualisation. Astryx `0.2.0` n'expose aucune liste
 * virtualisée (ses 123 sous-chemins ont été relus) et la contrainte M-C prévoyait ce
 * cas : « sinon pagination simple ». Le plafond est le nombre de conversations d'un
 * utilisateur — quelques centaines au pire, pas des milliers de messages. Paginer le
 * jour où une liste réelle rame, pas avant.
 */
export function ConversationsList({
  conversations,
  chargement = false,
  tri = "recentes",
  onOuvrir,
  onEpingler,
  onQuitter,
  onDemarrer,
  maintenant,
}: ConversationsListProps) {
  if (chargement) {
    return (
      // Même géométrie que les cartes finales : zéro décalage à l'arrivée des données
      // (DESIGN.md). Trois lignes suffisent à dire « ça vient ».
      <div
        aria-label="Chargement des conversations"
        aria-busy="true"
        style={{ display: "grid", gap: "var(--spacing-2)", padding: "var(--spacing-2)" }}
      >
        {[0, 1, 2].map((rang) => (
          <Skeleton key={rang} height={64} />
        ))}
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <Placeholder
        icone={IconeConversation}
        titre="Démarrez votre première conversation"
        explication="Ajoutez quelqu'un, et vos messages apparaîtront ici."
        action={
          onDemarrer ? <Button label="Nouvelle conversation" onClick={onDemarrer} /> : undefined
        }
      />
    );
  }

  return (
    <div
      role="list"
      aria-label="Conversations"
      style={{ display: "grid", gap: "var(--spacing-1)", padding: "var(--spacing-2)" }}
    >
      {ordonner(conversations, tri).map((conversation) => (
        /* `minWidth: 0` : un élément de grille refuse par défaut de descendre sous la
           largeur minimale de son contenu, et l'aperçu tronqué d'un long message — que
           `maxLines` rend insécable (`white-space: nowrap`) — élargissait donc la piste,
           puis la page. Le `overflow-wrap` global de `tokens.css` ne peut rien pour une
           ligne qui ne s'enroule pas : c'est ici que la largeur se laisse contraindre. */
        <div role="listitem" key={conversation.roomId} style={{ minWidth: 0 }}>
          <ConversationPreview
            conversation={conversation}
            onOuvrir={onOuvrir}
            onEpingler={onEpingler}
            onQuitter={onQuitter}
            maintenant={maintenant}
          />
        </div>
      ))}
    </div>
  );
}
