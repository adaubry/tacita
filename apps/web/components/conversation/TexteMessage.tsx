"use client";

import { Fragment } from "react";

import { Text } from "../foundation/primitives";

/**
 * Ce qui compte pour un lien : le schéma explicite, ou un `www.` que tout le monde écrit
 * sans schéma. Rien d'autre — un `a.b` attrapé au vol transformerait « fin.Le » en lien.
 *
 * Les parenthèses et les chevrons sont exclus du corps : ils encadrent une URL bien plus
 * souvent qu'ils n'en font partie.
 */
const MOTIF_LIEN = /(?:https?:\/\/|www\.)[^\s<>()[\]«»]+/gi;

/** La ponctuation qui termine une phrase, jamais une URL. */
const PONCTUATION_FINALE = /[.,;:!?'"…]+$/;

export interface MorceauTexte {
  texte: string;
  /** L'URL absolue à ouvrir. Absente = le fragment est du texte ordinaire. */
  lien?: string;
}

/**
 * découpe un corps de message en texte et liens. **Fonction pure**, éprouvée
 * sans DOM : c'est elle qui décide ce qui est cliquable, et c'est le seul endroit où
 * cette décision se prend.
 *
 * Le `href` est toujours absolu et toujours en `http(s)` : un `www.example.org` sans
 * schéma serait interprété comme un chemin relatif et enverrait sur `/c/www.example.org`.
 * Aucun autre schéma n'est reconnu — `javascript:` n'a jamais à devenir cliquable parce
 * que quelqu'un l'a écrit dans un message.
 */
export function decouperLiens(texte: string): MorceauTexte[] {
  const fragments: MorceauTexte[] = [];
  let curseur = 0;

  for (const trouve of texte.matchAll(MOTIF_LIEN)) {
    const debut = trouve.index;
    // « Regarde https://exemple.org. » — le point appartient à la phrase, pas à l'URL.
    const brut = trouve[0].replace(PONCTUATION_FINALE, "");
    if (brut === "") continue;

    if (debut > curseur) fragments.push({ texte: texte.slice(curseur, debut) });
    fragments.push({ texte: brut, lien: brut.startsWith("www.") ? `https://${brut}` : brut });
    curseur = debut + brut.length;
  }

  if (curseur < texte.length) fragments.push({ texte: texte.slice(curseur) });
  return fragments;
}

/**
 * Le corps d'un message, liens compris.
 *
 * Le texte était rendu tel quel : une URL s'affichait en encre ordinaire et n'était
 * cliquable nulle part — il fallait la sélectionner à la main pour l'ouvrir. Signalé par
 * les utilisateurs comme « les liens n'apparaissent pas en bleu et on ne peut pas cliquer
 * dessus ».
 *
 * **Accent et non bleu** : DESIGN.md § Colors range les liens dans `accent`, et § Typography
 * n'autorise l'encre d'accent que pour eux et les actions. Un bleu serait une couleur de
 * plus dans un système qui n'en a pas — l'écart se verrait autant que le lien.
 *
 * `target="_blank"` : la conversation est une PWA, et quitter l'écran pour un lien y perd
 * la position de lecture comme la barre d'écriture. `rel` couvre les deux risques de
 * l'ouverture externe — le `window.opener` et le référent.
 */
export function TexteMessage({ texte }: { texte: string }) {
  return (
    /* L'interface ne se sélectionne pas, le contenu si (`tokens.css`) : c'est ici que la
       sélection est rendue, parce que c'est ici qu'est le texte de quelqu'un. */
    <Text type="body" className="tacita-selectionnable">
      {decouperLiens(texte).map((fragment, rang) =>
        fragment.lien ? (
          <a
            key={rang}
            href={fragment.lien}
            target="_blank"
            rel="noreferrer noopener"
            /* Le geste de glissement porte sur le message entier ; sans cet arrêt, viser
               un lien arme aussi la réponse. */
            onPointerDown={(evenement) => evenement.stopPropagation()}
            style={{ color: "var(--color-text-accent)", textDecoration: "underline" }}
          >
            {fragment.texte}
          </a>
        ) : (
          <Fragment key={rang}>{fragment.texte}</Fragment>
        ),
      )}
    </Text>
  );
}
