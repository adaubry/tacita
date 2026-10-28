"use client";

import { OptionCard } from "../foundation/OptionCard";

/**
 * les options d'une conversation.
 *
 * **« Messages éphémères » n'existe pas** : E-03 l'a abandonné, pas reporté. Il
 * est donc absent du DOM, et surtout pas grisé — une option grisée est une promesse non
 * tenue affichée (interdit n°13). Ce commentaire est la seule trace qu'il en reste, et
 * c'est voulu : sans lui, quelqu'un le rajoutera en croyant à un oubli.
 */
export type OptionConversation =
  | "theme"
  | "notifications"
  | "groupe"
  | "lien"
  | "membres"
  | "quitter";

/**
 * **Supprimer la conversation, c'est la quitter.** Matrix n'efface rien : le salon
 * continue d'exister, l'autre voit le départ, et ce qu'on perd est l'historique local.
 * La confirmation le dit tel quel — promettre une suppression serait l'interdit n°13.
 *
 * Une seule source pour les deux chemins qui la posent : `/c/infos` et l'appui long de
 * l'accueil.
 */
export function texteQuitter(direct: boolean) {
  return direct
    ? {
        titre: "Supprimer cette conversation ?",
        corps:
          "Vous quitterez la conversation. Son historique ne vous sera plus accessible sur cet appareil, et votre interlocuteur verra que vous l'avez quittée.",
        action: "Supprimer",
      }
    : {
        titre: "Quitter ce groupe ?",
        corps:
          "Vous quitterez le groupe, qui continuera sans vous. Son historique ne vous sera plus accessible sur cet appareil, et les membres verront votre départ.",
        action: "Quitter",
      };
}

interface OptionsConversationProps {
  direct: boolean;
  /** l'état courant se lit sous l'option, sans avoir à l'ouvrir. */
  niveauLibelle: string;
  onOuvrir: (option: OptionConversation) => void;
}

interface Carte {
  cle: OptionConversation;
  titre: string;
  detail: string;
}

/**
 * composant 15 du wireframe : les Options, en `OptionCard`.
 *
 * Deux jeux, une seule liste : les variations sont des props, jamais des copies (règle
 * du plan frontend). Ce qui change entre 1:1 et groupe est l'appartenance à la liste,
 * pas le rendu d'une carte — lequel vit dans `OptionCard`, partagé avec les réglages de
 * l'application, qui posent exactement la même carte.
 */
export function OptionsConversation({
  direct,
  niveauLibelle,
  onOuvrir,
}: OptionsConversationProps) {
  const cartes: Carte[] = direct
    ? [
        { cle: "theme", titre: "Thème de la conversation", detail: "Fond d'écran, sur cet appareil" },
        { cle: "notifications", titre: "Notifications", detail: niveauLibelle },
        {
          cle: "groupe",
          titre: "Créer un groupe avec cette personne",
          detail: "Elle sera déjà sélectionnée",
        },
        /*
         * **Supprimer la conversation** (demande utilisateur : « il n'est pas possible de
         * supprimer une conversation avec quelqu'un »).
         *
         * Le geste existait côté paquet depuis le début (`leaveConversation`) et n'avait
         * aucun chemin pour un 1:1 : le seul bouton qui le déclenchait était « retirer des
         * amis », dans un sous-menu du profil — une autre intention, qui ne se cherche pas
         * quand on veut effacer une discussion. Un groupe, lui, n'avait aucun chemin du
         * tout.
         *
         * Le détail dit la conséquence vraie et pas la rassurante (interdit n°13) : chez
         * Matrix on **quitte**, on n'efface pas — l'autre voit le départ, et c'est
         * l'historique local qu'on perd.
         */
        {
          cle: "quitter",
          titre: "Supprimer la conversation",
          detail: "Vous la quittez ; son historique sera perdu sur cet appareil",
        },
      ]
    : [
        { cle: "theme", titre: "Thème de la conversation", detail: "Fond d'écran, sur cet appareil" },
        { cle: "lien", titre: "Lien d'invitation", detail: "Créer, voir l'expiration, révoquer" },
        { cle: "membres", titre: "Membres", detail: "Voir qui est là" },
        { cle: "notifications", titre: "Notifications", detail: niveauLibelle },
        // Le mot change avec la variante, l'effet non : « supprimer » mentirait sur un
        // groupe, qui continue d'exister sans vous.
        {
          cle: "quitter",
          titre: "Quitter le groupe",
          detail: "Les autres y restent ; son historique sera perdu sur cet appareil",
        },
      ];

  return (
    <section
      aria-label="Options"
      style={{ display: "grid", gap: "var(--spacing-2)", padding: "var(--spacing-3)" }}
    >
      {cartes.map(({ cle, titre, detail }) => (
        <OptionCard key={cle} titre={titre} detail={detail} onClick={() => onOuvrir(cle)} />
      ))}
    </section>
  );
}
