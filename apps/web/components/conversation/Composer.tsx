/**
 * La barre d'écriture : champ, actions, et l'intention en cours.
 *
 * `ContexteComposer` dit ce que la barre est en train de faire — écrire, répondre à
 * un message, ou en modifier un — et l'écran en dispose. Le composer n'envoie rien
 * lui-même : il rend le contenu, l'écran le confie à la file.
 */
"use client";

import type { MentionCandidate } from "@tacita/messaging";
import { useMemo, useState, type ReactNode } from "react";

import { IconeEnvoyer } from "../foundation/icons";
import { Button, ChatComposerInput, Text, createStaticSource } from "../foundation/primitives";

/**
 * Ce que le composer est en train de faire à un message existant : répondre
 * ou modifier. **Un seul bandeau pour les deux** — ce sont deux fois la même
 * chose du point de vue de l'écran : un message cité, un moyen d'annuler.
 */
export interface ContexteComposer {
  libelle: string;
  extrait: string;
  onAnnuler: () => void;
}

interface ComposerProps {
  /** membres du salon + `@everyone`, tels que le paquet les fournit. */
  mentions: MentionCandidate[];
  contexte?: ContexteComposer;
  /** Texte de départ — le corps du message quand on le modifie. */
  texteInitial?: string;
  onEnvoyer: (texte: string) => void;
  /** une frappe, pas une émission : le throttling vit dans le paquet. */
  onFrappe: () => void;
  /** qui écrit en face, déjà filtré par le paquet. */
  ecrivent?: string[];
  /** les pièces jointes, **à gauche du champ**. Fourni par M-E. */
  actions?: ReactNode;
  /** la capture photo, entre le champ et l'envoi. Fournie par M-E. */
  actionsEnvoi?: ReactNode;
  /**
   * Le micro, rendu **à la place** du bouton d'envoi tant que le champ est vide.
   *
   * Pas à côté : la rangée porte déjà quatre contrôles, et un cinquième permanent se
   * prendrait sur la largeur du champ — celle qui revient au texte, puisqu'on écrit dix
   * fois plus souvent qu'on ne joint. Ce qu'il remplace est un bouton **désactivé**, donc
   * une case morte : l'échange est gagnant des deux côtés.
   *
   * Absent quand l'appareil ne sait rien enregistrer : le bouton d'envoi grisé reprend
   * alors sa place, et aucun micro inerte n'est affiché.
   */
  vocal?: ReactNode;
}

/**
 * Conversation input (composant 9).
 *
 * **Une seule rangée** — `[+] [champ] [photo] [envoyer]` —, parce que c'est la forme
 * qu'ont WhatsApp, Discord, iMessage et Telegram, et qu'elle n'est pas un goût : dans une
 * messagerie on écrit dix fois plus souvent qu'on ne joint, donc le champ prend toute la
 * largeur restante et les gestes rares se réduisent à des cibles carrées à ses deux bouts.
 * Le champ grandit vers le haut jusqu'à `maxRows` puis défile, et les boutons restent
 * alignés sur sa dernière ligne (`flex-end`) — sinon ils flottent au milieu d'un pavé.
 *
 * **Pourquoi pas `ChatComposer`** : son corps
 * est une colonne `[en-tête] [champ] [rangée d'actions]`, et la rangée d'actions est
 * rendue **inconditionnellement**, bouton d'envoi compris. C'est la forme d'un composer
 * d'assistant — ChatGPT, Claude —, pas celle d'une messagerie, et aucun de ses props ne
 * la met sur une ligne : `density` ne change que le rembourrage, `xstyle` n'atteint que
 * le corps. Y ranger nos icônes les mettait sur une **seconde ligne sous le champ**.
 *
 * Ce qui reste d'Astryx est ce qui est difficile, et rien n'est recodé : `ChatComposerInput`
 * porte les mentions, Entrée-pour-envoyer, la garde de composition IME, le collage et les
 * jetons. Il lit le contexte du shell en **optionnel** et expose un prop pour chacune de
 * ses valeurs — hors du shell, il fonctionne pleinement. Ce qu'on écrit à sa place, c'est
 * une rangée flex et le prédicat `canSend` : quelques lignes, contre un composant dont la
 * forme est celle d'un autre produit.
 *
 * **Le bouton vocal a pris sa place** : il remplace le bouton d'envoi tant
 * que le champ est vide, et ne se rend pas du tout quand l'appareil ne sait rien
 * enregistrer. La règle qui le retenait n'a pas bougé — un micro inerte serait une
 * fonction affichée qui ne marche pas ; c'est l'enregistreur qui existe désormais, et
 * c'est lui qui décide s'il s'affiche.
 */
export function Composer({
  mentions,
  contexte,
  texteInitial = "",
  onEnvoyer,
  onFrappe,
  ecrivent = [],
  actions,
  actionsEnvoi,
  vocal,
}: ComposerProps) {
  const [texte, setTexte] = useState(texteInitial);
  const source = useMemo(() => createStaticSource(mentions), [mentions]);

  const envoyer = (valeur: string) => {
    const message = valeur.trim();
    if (message === "") return;
    onEnvoyer(message);
    setTexte("");
  };

  return (
    // La barre est au bas de la fenêtre, donc au-dessus de la barre de gestes en PWA
    // installée : sans ce dégagement, le bouton d'envoi tombe dessous et devient
    // inatteignable — même réserve que la navbar des onglets.
    <div
      style={{
        display: "grid",
        gap: "var(--spacing-1)",
        padding: "var(--spacing-2)",
        paddingBottom: "calc(var(--spacing-2) + env(safe-area-inset-bottom, 0px))",
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {/* l'indicateur est au-dessus du composer, là où l'œil revient entre
          deux phrases. Les identifiants ne sont pas jolis, mais ils sont exacts : le nom
          d'affichage se résout dans la timeline, pas ici. */}
      {ecrivent.length > 0 && (
        <Text type="supporting" color="secondary">
          {ecrivent.length === 1
            ? `${ecrivent[0]} est en train d'écrire…`
            : `${ecrivent.length} personnes sont en train d'écrire…`}
        </Text>
      )}

      {/* Le message cité occupe sa propre ligne **au-dessus** de la rangée, comme dans
          toutes les messageries : c'est un bloc de texte, il n'a pas la même largeur
          qu'une icône et ne peut pas partager la ligne du champ sans l'écraser. */}
      {contexte && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-2)",
            // Sans `overflow: hidden` sur la rangée, un extrait insécable — une URL —
            // élargit la ligne au lieu d'être tronqué, et pousse « Annuler » hors du
            // cadre (30/08/2026, plainte : « écran de réponse : overflow »).
            overflow: "hidden",
          }}
        >
          {/* Le filet reprend celui de la citation en timeline : c'est le même objet à
              deux moments — ce qu'on va citer, puis ce qu'on a cité. */}
          <div
            style={{
              flex: 1,
              // Une ligne tronquée ne s'enroule pas : sans `minWidth: 0`, un long message
              // cité pousse le bouton « Annuler » hors de l'écran au lieu d'être coupé.
              minWidth: 0,
              borderInlineStart: "2px solid var(--color-border)",
              paddingInlineStart: "var(--spacing-2)",
            }}
          >
            <Text type="supporting" color="secondary" maxLines={1}>
              {contexte.libelle} : {contexte.extrait}
            </Text>
          </div>
          {/* `flexShrink: 0` : c'est la citation qui cède, jamais la sortie. */}
          <div style={{ flexShrink: 0 }}>
            <Button label="Annuler" variant="ghost" onClick={contexte.onAnnuler} />
          </div>
        </div>
      )}

      {/* `flex-end` et non `center` : quand le champ grandit sur plusieurs lignes, les
          quatre boutons restent au niveau de la ligne qu'on est en train d'écrire.

          `position: relative` : la rangée est le repère de la barre d'enregistrement, que
          `EnregistreurVocal` pose en absolu par-dessus pendant qu'on parle. Elle a besoin
          de couvrir la rangée **entière** — poubelle à un bout, micro à l'autre —, et
          seule la rangée en connaît les bords. */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "flex-end",
          gap: "var(--spacing-1)",
        }}
      >
        {actions}

        {/* DESIGN.md e1 — le champ est la seule surface de la rangée : `surface` + filet,
            au rayon `--radius-chat`, qui existe pour lui. Les boutons sont nus autour,
            comme sur Discord : trois cadres côte à côte feraient trois boîtes à lire. */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            padding: "var(--spacing-1) var(--spacing-2)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-chat)",
            background: "var(--color-background-surface)",
          }}
        >
          <ChatComposerInput
            label="Message"
            placeholder="Message"
            // Hors du shell, l'état est ici : `ChatComposerInput` lit son contexte en
            // optionnel et chaque valeur a son prop. Une seule source pour le texte, un
            // seul endroit où `onFrappe` peut être oublié.
            value={texte}
            onChange={(valeur) => {
              setTexte(valeur);
              onFrappe();
            }}
            onSubmit={envoyer}
            triggers={[
              {
                character: "@",
                searchSource: source,
                onSelect: (item) => `@${item.label} `,
              },
            ]}
          />
        </div>

        {actionsEnvoi}

        {/* `Button` et non `ChatSendButton` : ce dernier tire son libellé du dictionnaire
            d'Astryx, dont le `fr-FR.json` **n'a pas la clé** — et il repose son propre
            `aria-label` *après* les props reçues, donc le libellé n'est pas remplaçable.
            Un lecteur d'écran annonçait « Send » au milieu d'une interface française. Le
            défaut passait inaperçu tant que le bouton venait implicitement du shell.

            `canSend` du shell disparu avec lui, la règle est ici — et c'est la même que
            celle d'`envoyer` : un message blanc ne part pas. La tenir à deux endroits
            serait une divergence en attente ; elle tient en un `trim`. */}
        {vocal && texte.trim() === "" ? (
          vocal
        ) : (
          <Button
            label="Envoyer"
            variant="primary"
            isIconOnly
            icon={IconeEnvoyer}
            isDisabled={texte.trim() === ""}
            onClick={() => envoyer(texte)}
          />
        )}
      </div>
    </div>
  );
}
