"use client";

import type { Conversation } from "@tacita/messaging";
import { useState } from "react";

import { ButtonsList } from "../foundation/ButtonsList";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { cleTeinte, variablesTeinte } from "../foundation/teinte";
import { Sheet } from "../foundation/Sheet";
import { Badge, ClickableCard, Text } from "../foundation/primitives";
import { dateApercu } from "../../lib/dates";
import { useGlissement } from "../../lib/gestes";

interface ConversationPreviewProps {
  conversation: Conversation;
  onOuvrir: (roomId: string) => void;
  onEpingler: (roomId: string, epingle: boolean) => void;
  /** Injecté en test, pour que « aujourd'hui » ne dépende pas de l'heure du CI. */
  maintenant?: number;
  /**
   * Variation « résultat de recherche » (M-F) : ni badge, ni geste d'épingle.
   * Une prop plutôt qu'une copie du composant — la règle du plan frontend.
   */
  simple?: boolean;
}

/**
 * le badge. La mention **prime** sur le nombre : savoir qu'on vous a
 * nommé compte plus que savoir combien de messages ont passé. Au-delà de neuf, le
 * compte exact n'apporte plus rien — « 9+ » suffit et la largeur cesse de bouger.
 *
 * DESIGN.md : encre sur `accent-soft`, jamais de pastille rouge (PRODUCT.md — pas de
 * culpabilisation).
 */
function BadgeNonLus({ unread, mention }: { unread: number; mention: boolean }) {
  if (!mention && unread === 0) return null;

  return (
    <Badge
      className="tabulaire"
      aria-label={mention ? "Mention non lue" : `${unread} non lus`}
      label={mention ? "@" : unread > 9 ? "9+" : String(unread)}
      // Le `Badge` d'Astryx est la primitive ; seules ses deux couleurs sont reposées,
      // aucune variante ne donnant « encre sur accent-soft ».
      style={{
        // Le voile du salon plutôt que l'accent : un compteur de non-lus dit *où* il y a
        // du nouveau, et c'est précisément ce que la teinte porte. Le repli garde
        // l'ancien fond partout où la variable n'est pas posée.
        background: "var(--tacita-teinte-voile, var(--color-accent-muted))",
        color: "var(--color-text-primary)",
      }}
    />
  );
}

/**
 * la carte « conversation preview » (composant 3) : avatar, nom, aperçu
 * tronqué, date localisée, badge.
 *
 * un glissement vers la droite l'épingle. Le geste n'est pas le seul
 * chemin : l'appui long ouvre un hold menu qui porte la même action (DESIGN.md — chaque
 * geste a un équivalent visible). Sans lui, épingler serait invisible au clavier et à
 * qui ne connaît pas le geste.
 */
export function ConversationPreview({
  conversation,
  onOuvrir,
  onEpingler,
  maintenant,
  simple = false,
}: ConversationPreviewProps) {
  const [menuOuvert, setMenuOuvert] = useState(false);
  const geste = useGlissement(
    simple
      ? {}
      : {
          onDroite: () => onEpingler(conversation.roomId, !conversation.pinned),
          /*
           * **Glissement gauche : les actions** (30/08/2026, demande utilisateur — « on
           * aimerait avoir des actions au glissement gauche/droite d'une conversation »).
           *
           * La droite épingle depuis le début ; la gauche n'était branchée sur rien, et le
           * seul chemin vers les actions était l'appui long — un geste qu'on ne découvre
           * pas. Elle ouvre la même feuille, donc aucune action n'existe uniquement au
           * doigt (DESIGN.md : « chaque geste a un équivalent visible »).
           */
          onGauche: () => setMenuOuvert(true),
          onAppuiLong: () => setMenuOuvert(true),
        },
  );

  return (
    <>
      <ClickableCard
        label={conversation.name}
        padding={3}
        onClick={() => onOuvrir(conversation.roomId)}
        {...geste}
      >
        {/* La teinte du salon, posée sur la ligne : l'avatar la dérive lui-même de la même
            clé, le badge la lit ici par héritage. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-3)",
            ...variablesTeinte(cleTeinte(conversation)),
          }}
        >
          <ConversationAvatar
            nom={conversation.name}
            mxc={conversation.avatarUrl}
            direct={conversation.direct}
            cle={cleTeinte(conversation)}
          />

          {/* `minWidth: 0` : sans lui, un aperçu long élargit la ligne au lieu d'être
              tronqué — la troncature d'un enfant de flex ne s'applique pas autrement. */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text type="body" weight="bold">
              {conversation.name}
            </Text>
            {/* `maxLines` est la troncature d'Astryx : une ligne, ellipse comprise.
                La recoder en CSS serait recoder la primitive (DESIGN.md). */}
            <Text type="supporting" color="secondary" maxLines={1}>
              {conversation.preview}
            </Text>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "var(--spacing-1)",
            }}
          >
            {/* Chiffres tabulaires : une heure qui change ne doit pas déplacer la
                colonne (DESIGN.md). */}
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {conversation.timestamp === 0 ? "" : dateApercu(conversation.timestamp, maintenant)}
            </Text>
            {!simple && (
              <BadgeNonLus unread={conversation.unread} mention={conversation.mention} />
            )}
          </div>
        </div>
      </ClickableCard>

      <Sheet
        ouvert={menuOuvert}
        onFermer={() => setMenuOuvert(false)}
        nom={`Actions sur la conversation ${conversation.name}`}
      >
        <ButtonsList
          boutons={[
            {
              cle: "epingler",
              libelle: conversation.pinned ? "Désépingler" : "Épingler",
              onClick: () => {
                setMenuOuvert(false);
                onEpingler(conversation.roomId, !conversation.pinned);
              },
            },
          ]}
        />
      </Sheet>
    </>
  );
}
