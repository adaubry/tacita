/**
 * Un message à l'écran : la bulle, et ce qu'elle porte autour d'elle.
 *
 *  1. `Recu` — la coche d'accusé. Trois niveaux, et un cas « indécidable » qui
 *     n'affiche rien plutôt que d'inventer.
 *  2. `EtatEnvoi` — ce que dit une entrée encore dans la file : en cours, à
 *     réessayer, ou échouée avec un motif que l'utilisateur peut traiter.
 *  3. `MessageObject` — la bulle : corps, réponse citée, réactions, édition.
 */
"use client";

import type { ReactionTally } from "@tacita/messaging";
import { NOT_ENCRYPTED } from "@tacita/outbox";
import type { ReceiptStatus } from "@tacita/receipts";

import { heure } from "../../lib/dates";
import { useGlissement } from "../../lib/gestes";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { IconeCoche, IconeDoubleCoche } from "../foundation/icons";
import { MediaMessage } from "../media/MediaMessage";
import type { Media, Telecharger } from "../media/media";
import { Button, Text, ToggleButton } from "../foundation/primitives";
import { teinte } from "../foundation/teinte";
import { TexteMessage } from "./TexteMessage";
import { texteAffiche, type MessageAffiche } from "./message";

/**
 * **Le rayon d'une bulle, par ses quatre coins.** L'arête côté auteur est serrée — la
 * gauche pour un message reçu, la droite pour un message envoyé — sauf le coin *haut* de
 * la première bulle du groupe, qui reste rond parce que rien ne la précède.
 *
 * La règle ne dépend que de `moi` et de `entete` : `pied` ne sert pas ici. Une grappe se
 * lit par son arête continue, pas par un coin final — et un dernier coin spécial aurait
 * demandé de distinguer la bulle unique, qui est à la fois première et dernière.
 */
export function rayonBulle(moi: boolean, entete: boolean): string {
  const rond = "var(--tacita-radius-bulle)";
  const serre = "var(--tacita-radius-bulle-serre)";
  // haut-gauche, haut-droit, bas-droit, bas-gauche
  return moi
    ? `${rond} ${entete ? rond : serre} ${serre} ${rond}`
    : `${entete ? rond : serre} ${rond} ${rond} ${serre}`;
}

interface MessageObjectProps {
  message: MessageAffiche;
  /** calculé par `shouldShowHeader`, jamais deviné ici. */
  entete: boolean;
  /**
   * calculé par `finDeGroupe`, jamais deviné ici. Ferme la grappe : c'est la bulle qui
   * porte l'heure et l'accusé, et qui arrondit son coin bas côté auteur.
   */
  pied: boolean;
  /** la timeline entière révèle ses heures, pas une ligne isolée. */
  heureVisible: boolean;
  reactions?: ReactionTally[];
  /** fourni sur le dernier message envoyé, et sur lui seul. */
  recu?: { statut: ReceiptStatus; indecidable: boolean };
  onRepondre: () => void;
  onHold: () => void;
  onRevelerHeures: () => void;
  /**
   * Ouvrir le profil de l'auteur depuis son nom.
   *
   * Facultatif : les écrans qui rendent un message hors d'une conversation — la
   * recherche, les collections — n'ont pas de pile de navigation où pousser un profil, et
   * un nom cliquable qui ne mène nulle part serait pire que pas de lien.
   */
  onOuvrirProfil?: () => void;
  onReagir?: (emoji: string) => void;
  onRenvoyer?: () => void;
  onAbandonner?: () => void;
  /** déchiffrement d'une pièce jointe, injecté par le câblage (M-E). */
  telecharger?: Telecharger;
  onOuvrirMedia?: () => void;
  /** écrire la pièce jointe sur l'appareil. Rendu sur les fichiers, qui
   *  n'ouvrent pas de viewer et n'avaient donc aucune sortie. */
  onSauvegarderMedia?: (media: Media) => void;
}

/** `sending` n'y figure pas : ce statut ne rend aucune coche, il rend `null`. */
/**
 * DESIGN.md nomme la coche verte « trait d'identité ». C'étaient les caractères `✓` et
 * `✓✓` — des glyphes typographiques au milieu d'une interface dont toutes les autres
 * marques sont des SVG au trait : épaisseur, alignement vertical et dessin changeaient
 * d'une plateforme à l'autre. Le seul trait d'identité que l'équipe ne dessinait pas
 * (revue de conception E-08).
 */
const COCHE = {
  sent: IconeCoche,
  delivered: IconeDoubleCoche,
  read: IconeDoubleCoche,
} as const;

/**
 * les accusés, et **ce qu'ils ne disent pas**.
 *
 * « Délivré » est une extension à nous : Matrix ne définit que `m.read`.
 * L'aide contextuelle le dit au lieu de laisser croire à du standard. Et quand le
 * destinataire est en mode masqué, l'état reste `sent` pour toujours : `deliveryUnknowable`
 * distingue « pas encore » de « on ne saura jamais », que rien à l'écran ne séparerait.
 */
function Recu({ statut, indecidable }: { statut: ReceiptStatus; indecidable: boolean }) {
  if (statut === "sending") return null;

  const aide =
    statut === "sent" && indecidable
      ? "Envoyé. Ce destinataire n'émet pas d'accusé de réception : la progression s'arrête ici."
      : statut === "delivered"
        ? "Délivré — extension propre à Tacita, pas un accusé Matrix standard : reçu par un appareil du destinataire, pas forcément lu."
        : statut === "read"
          ? "Lu."
          : "Envoyé.";

  return (
    <span
      /*
       * `role="img"` : la coche est un SVG `aria-hidden`, donc le nom accessible
       * doit être porté par ce conteneur — sans rôle, un `<span>` étiqueté n'est exposé à
       * rien. `title` reste pour l'infobulle de bureau ; sur tactile elle ne s'affiche
       * jamais, et c'est « Limites connues » et « Confidentialité » qui portent
       * l'explication de « délivré » pour de bon.
       */
      role="img"
      title={aide}
      aria-label={aide}
      style={{
        // DESIGN.md : la coche verte est un trait d'identité, et elle ne l'est que pour
        // « lu ». Les états intermédiaires restent muets.
        color: statut === "read" ? "var(--color-text-accent)" : "var(--color-text-secondary)",
        // L'icône porte sa propre taille (16) : plus de `font-size` à régler ici.
        display: "flex",
      }}
    >
      {COCHE[statut]}
    </span>
  );
}

/** une entrée bloquée par le chiffrement ne se réessaie pas : elle s'explique. */
function EtatEnvoi({
  message,
  onRenvoyer,
  onAbandonner,
}: Pick<MessageObjectProps, "message" | "onRenvoyer" | "onAbandonner">) {
  if (message.envoi === undefined || message.envoi === "sending") return null;
  if (message.envoi === "queued")
    return (
      <Text type="supporting" color="secondary">
        En attente d'envoi
      </Text>
    );

  const bloque = message.errcode === NOT_ENCRYPTED;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-2)" }}>
      <Text type="supporting" color="secondary">
        {bloque
          ? "Non envoyé : ce salon n'est pas chiffré."
          : "Non envoyé. Vérifiez votre connexion."}
      </Text>
      {/* Un bouton « Réessayer » sur une entrée que la garde de chiffrement refusera
          toujours est une promesse non tenue (interdit n°13) : il n'apparaît pas. */}
      {!bloque && onRenvoyer && <Button label="Réessayer" variant="ghost" onClick={onRenvoyer} />}
      {onAbandonner && <Button label="Supprimer" variant="ghost" onClick={onAbandonner} />}
    </div>
  );
}

/**
 * Message object (composant 11), regroupement Discord **en bulles** (DESIGN.md §
 * Components).
 *
 * La règle des 5 minutes ne change pas — ce qu'elle produit, si : au lieu d'un blanc entre
 * deux prises de parole, une grappe de bulles dont l'arête côté auteur est continue. Reçu
 * à gauche sur la surface et son filet, envoyé à droite sur le voile du salon ; **un seul
 * côté est teinté**, colorier les deux ferait une salade de fruits dont on ne lirait plus
 * le sens.
 *
 * glissement gauche pour répondre, glissement droit pour révéler
 * les heures, avec la zone morte de 20 px au bord gauche.
 */
export function MessageObject({
  message,
  entete,
  pied,
  heureVisible,
  reactions = [],
  recu,
  onRepondre,
  onHold,
  onRevelerHeures,
  onOuvrirProfil,
  onReagir,
  onRenvoyer,
  onAbandonner,
  telecharger,
  onOuvrirMedia,
  onSauvegarderMedia,
}: MessageObjectProps) {
  // Lié une fois : `message.media` est optionnel, et le rebrancher dans chaque garde
  // redemanderait un `!` au compilateur à chaque usage.
  const media = message.media;
  const moi = message.moi;

  /**
   * **Le vocal est le seul média qui prend une bulle**.
   *
   * La règle « un média n'entre pas dans une bulle » vaut pour ce qui porte déjà son
   * propre cadre : une photo *est* un rectangle, l'entourer en ajoute un second. Un
   * lecteur vocal n'est pas un cadre, c'est une rangée de commandes — posée nue dans la
   * timeline, elle flotte sans rien qui dise où le message commence et où il finit. La
   * bulle lui donne ce bord, et au passage la teinte, qui dit de quel côté il vient.
   */
  const vocal = media?.msgtype === "m.audio";

  /*
   * La teinte **de l'auteur**, dérivée de son identifiant Matrix — pas celle du salon,
   * qui est posée plus haut et colore vos bulles. Dans un groupe, c'est ce qui sépare
   * trois interlocuteurs d'un coup d'œil, et c'est exactement la couleur que porte déjà
   * leur avatar à gauche du nom.
   */
  const { encre } = teinte(message.auteur);
  const encreAuteur = `light-dark(${encre.clair}, ${encre.sombre})`;

  /*
   * Le message cité. Il vit **dans** la bulle quand il y en a une, et au-dessus du média
   * sinon : c'est un rappel de ce à quoi on répond, il appartient au message, pas à la
   * colonne.
   */
  const cite = message.repondA && (
    <div
      style={{
        borderInlineStart: "2px solid var(--color-border)",
        paddingInlineStart: "var(--spacing-2)",
        marginBottom: "var(--spacing-1)",
        minWidth: 0,
      }}
    >
      <Text type="supporting" color="secondary" maxLines={1}>
        {message.repondA.nom
          ? `${message.repondA.nom} · ${message.repondA.extrait}`
          : message.repondA.extrait}
      </Text>
    </div>
  );

  const geste = useGlissement({
    onGauche: onRepondre,
    onDroite: onRevelerHeures,
    onAppuiLong: onHold,
    zoneMorteBord: true,
  });

  return (
    <article
      aria-label={`Message de ${message.nom}`}
      {...geste}
      style={{
        ...geste.style,
        display: "flex",
        // Le côté *est* l'information : c'est lui qui dit qui parle, avant la couleur et
        // avant l'avatar. Il n'y a pas de queue pointue — elle casserait l'empilement
        // d'une grappe, et c'est le détail qui date le plus vite une messagerie.
        justifyContent: moi ? "flex-end" : "flex-start",
        // L'alignement de l'avatar est réservé même sans en-tête : sans lui, un message
        // groupé rentrerait sous l'avatar et la colonne de texte danserait.
        gap: "var(--spacing-2)",
        /*
         * Un groupe s'ouvre sur `--spacing-3` et non `--spacing-2` : à 8 px, deux
         * groupes d'auteurs différents se touchaient presque, et le regroupement Discord
         * — qui repose entièrement sur l'écart — ne se lisait plus.
         *
         * **À l'intérieur d'un groupe, 2 px** et non zéro : les bulles doivent se toucher
         * sans fusionner. C'est ce mince filet de fond qui rend lisibles les deux coins
         * serrés de l'arête, et donc le fait qu'il y a là plusieurs messages.
         */
        padding: entete
          ? "var(--spacing-3) var(--spacing-3) 0"
          : "var(--spacing-0-5) var(--spacing-3) 0",
        // Un envoi en cours ou en échec est plus pâle : l'information est dans l'état,
        // pas dans une icône de plus.
        /*
         * **Plus d'opacité sur le bloc** (revue de conception E-07). Elle
         * valait 0,6 dès que l'envoi n'était plus « en attente », et s'appliquait donc au
         * texte du message, à la phrase qui explique l'échec et aux deux boutons
         * « Réessayer » et « Supprimer ». C'est le seul moment où l'on doit relire ce
         * qu'on a écrit pour décider si on le renvoie, et c'était le moment où le
         * contraste baissait. L'état se dit déjà en toutes lettres, sous le message.
         */
      }}
    >
      {/* La colonne d'avatar n'existe plus que du côté reçu : vos bulles sont à droite, et
          un avatar de vous-même contre chacune d'elles ne dirait rien que l'alignement ne
          dise déjà — il prendrait seulement 48 px de largeur de lecture. */}
      {!moi && (
        <div style={{ width: 40, flexShrink: 0 }}>
          {/* Un `useImageMxc` par en-tête, mais un seul `fetch` par auteur : le cache
              est mutualisé dans le hook. */}
          {entete && <ConversationAvatar nom={message.nom} mxc={message.avatar} direct taille={40} cle={message.auteur} />}
        </div>
      )}

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: moi ? "flex-end" : "flex-start",
          minWidth: 0,
          /*
           * Une bulle qui traverse l'écran n'est plus une bulle. La largeur fait partie de
           * ce qui se lit — elle dit « voilà une prise de parole » avant le texte — et une
           * ligne de 390 px se relit mal. `min()` borne les deux bouts : la proportion tient
           * sur un téléphone, la mesure absolue empêche la bulle de s'étaler sur un écran
           * large, où 78 % feraient des lignes de cent caractères.
           *
           * Un vocal respire un peu plus : sa forme d'onde a une largeur minimale en
           * dessous de laquelle les barres se tassent, et contrairement à une phrase, elle
           * ne peut pas passer à la ligne.
           */
          maxWidth: vocal ? "min(92%, 30rem)" : "min(78%, 30rem)",
        }}
      >
        {/* Le nom ne se répète pas dans un groupe, et **jamais pour soi** : on sait qui on
            est, et l'écrire au-dessus de chacune de ses propres bulles est le bruit que le
            regroupement sert justement à retirer. L'heure descend au pied de la grappe. */}
        {entete &&
          !moi &&
          /*
           * **Le nom mène au profil** (demande utilisateur). C'est le chemin qui manquait
           * depuis un groupe : on y lit un message de quelqu'un qu'on ne connaît pas
           * encore, et rien ne permettait d'aller voir qui c'est, ni d'ouvrir une
           * conversation privée avec lui.
           *
           * Un vrai `<button>` et non un `onClick` sur le texte : le nom devient une
           * cible de tabulation et s'annonce comme un contrôle, ce qu'un `span` cliquable
           * ne fait pas. Il garde l'apparence du nom — c'est le mot qui est la cible,
           * exactement comme dans toutes les messageries, et l'habiller en lien
           * l'alourdirait au-dessus de chaque grappe.
           *
           * Pas de bouton quand personne n'écoute : le composant sert aussi la recherche
           * et les collections, qui n'ont pas de pile où pousser un profil.
           */
          (onOuvrirProfil ? (
            <button
              type="button"
              onClick={onOuvrirProfil}
              aria-label={`Profil de ${message.nom}`}
              style={{
                padding: 0,
                border: 0,
                background: "none",
                font: "inherit",
                textAlign: "start",
                cursor: "pointer",
              }}
            >
              <Text type="supporting" weight="bold" style={{ color: encreAuteur }}>
                {message.nom}
              </Text>
            </button>
          ) : (
            <Text type="supporting" weight="bold" style={{ color: encreAuteur }}>
              {message.nom}
            </Text>
          ))}

        {/* **La pièce jointe n'entre pas dans une bulle** (DESIGN.md § Components) : dans
            la timeline, un média *est* le message, et il garde le cadrage de son auteur.
            Une bulle autour ajouterait un cadre à ce qui en porte déjà un, et une teinte
            derrière une photo ne se verrait pas. Le cité passe alors au-dessus. */}
        {media && telecharger && !vocal && (
          <>
            {cite}
            <MediaMessage
              media={media}
              telecharger={telecharger}
              onOuvrir={onOuvrirMedia}
              onSauvegarder={onSauvegarderMedia ? () => onSauvegarderMedia(media) : undefined}
            />
          </>
        )}

        {/* `minWidth: 0` sur la bulle : un enfant de flex refuse par défaut de descendre
            sous la largeur de son contenu, et un mot insécable — une URL, un « aaaaaaa… »
            — poussait donc la rangée hors de l'écran. */}
        {(!media || vocal) && (
          <div
            style={{
              minWidth: 0,
              // Le lecteur se dimensionne sur sa bulle : sa forme d'onde est en `flex: 1`,
              // et sans largeur définie au-dessus d'elle les barres se tassent.
              width: vocal ? "100%" : undefined,
              borderRadius: rayonBulle(moi, entete),
              padding: "var(--spacing-2) var(--spacing-3)",
              /*
               * Le voile du salon pour vos bulles — **posé plus haut, sur l'écran**, et lu
               * ici par héritage : ce composant n'a pas à savoir dans quelle conversation
               * il est. Le repli sur `accent-muted` n'est pas décoratif : il garde la
               * timeline lisible si la variable n'a pas été posée (un rendu isolé, un
               * test), au lieu d'un fond transparent sur fond transparent.
               */
              background: moi
                ? "var(--tacita-teinte-voile, var(--color-accent-muted))"
                : "var(--color-background-surface)",
              /*
               * Le filet ne va **que** du côté reçu, et c'est ce qui équilibre les deux :
               * la bulle teintée se détache par sa couleur, la bulle neutre par son trait.
               * Un filet sur la teintée ferait deux signaux pour une seule information.
               */
              border: moi ? undefined : "1px solid var(--color-border)",
            }}
          >
            {cite}
            {vocal && media && telecharger ? (
              <MediaMessage
                media={media}
                telecharger={telecharger}
                onOuvrir={onOuvrirMedia}
                onSauvegarder={onSauvegarderMedia ? () => onSauvegarderMedia(media) : undefined}
              />
            ) : (
              <TexteMessage texte={texteAffiche(message.texte)} />
            )}
          </div>
        )}

        {/* **Le pied de la grappe** : l'heure et l'accusé sous la dernière bulle, et non
            dans l'en-tête. C'est là qu'on les cherche — au bout de ce qui vient d'être dit,
            pas au-dessus de ce qui l'ouvre — et c'est ce qui donne à la grappe sa fin.
            Le geste de glissement révèle les heures des messages intermédiaires ; les
            afficher en permanence ferait une colonne de bruit. */}
        {(pied || heureVisible || recu) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-1)",
              paddingTop: "var(--spacing-0-5)",
              paddingInline: "var(--spacing-1)",
            }}
          >
            <Text type="supporting" color="secondary" hasTabularNumbers>
              {heure(message.horodatage)}
            </Text>
            {recu && <Recu statut={recu.statut} indecidable={recu.indecidable} />}
          </div>
        )}

        {reactions.length > 0 && (
          <div style={{ display: "flex", gap: "var(--spacing-1)", paddingTop: "var(--spacing-1)" }}>
            {/* Une réaction est un bouton à deux états : `ToggleButton` **est** cette
                primitive, et `aria-pressed` vient avec elle (DESIGN.md interdit de la
                recoder). Le tap retire la mienne ou ajoute la sienne. */}
            {reactions.map(({ key, count, mine }) => (
              <ToggleButton
                key={key}
                label={`${key} ${count}`}
                size="sm"
                isPressed={mine}
                onPressedChange={() => onReagir?.(key)}
              />
            ))}
          </div>
        )}

        <EtatEnvoi message={message} onRenvoyer={onRenvoyer} onAbandonner={onAbandonner} />
      </div>
    </article>
  );
}
