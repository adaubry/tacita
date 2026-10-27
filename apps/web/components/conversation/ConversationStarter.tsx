import { ButtonsList, type Bouton } from "../foundation/ButtonsList";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { Text } from "../foundation/primitives";

interface ConversationStarterProps {
  nom: string;
  /** La clé de teinte du salon — le correspondant en DM, le salon en groupe. */
  cle?: string;
  /** Identifiant Matrix en DM, nombre de membres en groupe : deux natures, deux rendus. */
  sousTitre: string;
  direct: boolean;
  /** Actions déléguées aux interfaces de M-G (social) et M-H (réglages). */
  onBloquer?: () => void;
  onRetirer?: () => void;
  onMuter?: () => void;
  onQuitter?: () => void;
}

/**
 * Conversation starter (composant 10) : le premier élément de la timeline.
 *
 * **Aligné à gauche comme les messages**, pas centré : c'est le début de la conversation,
 * pas un en-tête d'écran. L'avatar y est à sa plus grande occurrence de l'app — c'est le
 * seul endroit où l'on regarde *qui* avant de lire *quoi*.
 *
 * Les quatre actions sont rendues par un seul composant, variations par props (règle du
 * plan frontend) : 1:1 donne bloquer/retirer, groupe donne muter/quitter.
 */
export function ConversationStarter({
  nom,
  cle,
  sousTitre,
  direct,
  onBloquer,
  onRetirer,
  onMuter,
  onQuitter,
}: ConversationStarterProps) {
  // Une action sans destination n'entre pas dans la liste — un bouton inerte est une
  // promesse non tenue (interdit n°13). Le `?` construit le tableau au lieu de le
  // filtrer ensuite, ce qui évitait un `!` sur chaque `onClick`.
  const actions: Bouton[] = direct
    ? [
        ...(onBloquer ? [{ cle: "bloquer", libelle: "Bloquer", destructif: true, onClick: onBloquer }] : []),
        ...(onRetirer
          ? [{ cle: "retirer", libelle: "Retirer l'ami", destructif: true, onClick: onRetirer }]
          : []),
      ]
    : [
        ...(onMuter ? [{ cle: "muter", libelle: "Muter", onClick: onMuter }] : []),
        ...(onQuitter
          ? [{ cle: "quitter", libelle: "Quitter", destructif: true, onClick: onQuitter }]
          : []),
      ];

  return (
    <section
      aria-label="Début de la conversation"
      style={{ display: "grid", gap: "var(--spacing-3)", padding: "var(--spacing-4) var(--spacing-3)" }}
    >
      <ConversationAvatar nom={nom} direct={direct} taille={48} cle={cle} />

      <div>
        {/* `display` (22/600) puis `secondary` (13/400) : la hiérarchie se fait par
            taille et couleur, jamais par une graisse de plus (DESIGN.md). */}
        <Text type="display-3">{nom}</Text>
        <Text type="supporting" color="secondary">
          {sousTitre}
        </Text>
      </div>

      <Text type="body" color="secondary">
        {direct
          ? "C'est le début de votre conversation. Les messages sont chiffrés de bout en bout."
          : "C'est le début de ce groupe. Les messages sont chiffrés de bout en bout."}
      </Text>

      {/* M-G et M-H branchent ces actions ; celles qui ne le sont pas n'existent pas. */}
      <ButtonsList boutons={actions} />
    </section>
  );
}
