/**
 * Les icônes, en SVG inline — une constante par icône, rien d'autre dans ce fichier.
 *
 * Inline plutôt qu'un paquet : elles héritent alors de `currentColor`, donc du thème,
 * sans qu'aucune couleur ne soit écrite ici. Chacune est `aria-hidden` — le nom
 * accessible appartient au contrôle qui la porte, jamais à l'icône.
 */
import type { ReactNode } from "react";

/**
 * Les quatre icônes de la navbar. Astryx en livre 26, mais ni « accueil »,
 * ni « mentions », ni « profil » — et sa liste de noms est un type fermé, donc on ne
 * peut pas l'étendre. `NavIcon` accepte n'importe quel nœud : on lui donne les nôtres.
 *
 * DESIGN.md : icône au trait monochrome. Les quatre partagent exactement la même
 * géométrie — 24×24, trait de 1,5, extrémités rondes — parce qu'une navbar dont les
 * traits n'ont pas la même épaisseur se voit immédiatement, même sans savoir pourquoi.
 * `currentColor` : la couleur vient du token, jamais d'ici.
 */
const trait = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const IconeAccueil: ReactNode = (
  <svg {...trait}>
    <path d="M3.5 10.5 12 4l8.5 6.5V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
  </svg>
);

export const IconeRecherche: ReactNode = (
  <svg {...trait}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </svg>
);

export const IconeMentions: ReactNode = (
  <svg {...trait}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M15.5 8.5v4.75a2.75 2.75 0 0 0 4.5 2.13A9 9 0 1 0 16 20" />
  </svg>
);

/** Appels (M-D) — Astryx n'a ni téléphone ni caméra, et sa liste de noms est fermée. */
export const IconeAppel: ReactNode = (
  <svg {...trait}>
    <path d="M6.5 4h3l1.5 3.5-2 1.5a11 11 0 0 0 6 6l1.5-2 3.5 1.5v3a1.5 1.5 0 0 1-1.7 1.5A16 16 0 0 1 5 5.7 1.5 1.5 0 0 1 6.5 4" />
  </svg>
);

export const IconeVideo: ReactNode = (
  <svg {...trait}>
    <rect x="3" y="6.5" width="12" height="11" rx="2" />
    <path d="m15 11 5-3v8l-5-3z" />
  </svg>
);

/** Création (M-C) — même géométrie que les quatre de la navbar, sans exception. */
export const IconePlus: ReactNode = (
  <svg {...trait}>
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
);

/**
 * Les deux icônes de la barre d'écriture (M-E, M-D). Astryx n'a ni appareil photo ni
 * avion — sa liste de noms reste un type fermé, même motif qu'`IconeVideo` plus haut.
 *
 * L'avion plutôt que la flèche vers le haut d'Astryx (`arrowUp`) : la flèche est le
 * signe des assistants, où l'on « soumet » une requête. Ici on **envoie** un message à
 * quelqu'un, et c'est l'avion que toutes les messageries ont appris à leurs
 * utilisateurs.
 */
/**
 * Média sans aperçu — la tuile terminale de `MediaMessage`, quand l'expéditeur n'a pas pu
 * produire de vignette. Même géométrie que les autres : 24×24, trait de 1,5.
 */
export const IconeImage: ReactNode = (
  <svg {...trait}>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m4 17 4.5-4.5 3.5 3.5 3-3L20 17" />
  </svg>
);

export const IconeCamera: ReactNode = (
  <svg {...trait}>
    <path d="M3.5 8.5h3l1.5-2h6l1.5 2h3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1" />
    <circle cx="12" cy="13" r="3.25" />
  </svg>
);

/**
 * Le micro de la barre d'écriture. Une capsule, son arc de maintien et son pied — la
 * forme que tout le monde reconnaît, au trait des autres, sans onde ni pastille rouge :
 * l'état d'enregistrement se dit par le compteur, pas par un clignotant.
 */
export const IconeMicro: ReactNode = (
  <svg {...trait}>
    <rect x="9.25" y="3" width="5.5" height="11" rx="2.75" />
    <path d="M5.75 11.5a6.25 6.25 0 0 0 12.5 0" />
    <path d="M12 17.75V21" />
  </svg>
);

export const IconeEnvoyer: ReactNode = (
  <svg {...trait}>
    <path d="M20 12 4.5 5.5l2.5 6.5-2.5 6.5z" />
    <path d="M7 12h13" />
  </svg>
);

export const IconeProfil: ReactNode = (
  <svg {...trait}>
    <circle cx="12" cy="8" r="3.75" />
    <path d="M4.75 20a7.25 7.25 0 0 1 14.5 0" />
  </svg>
);

/**
 * La clé de récupération (M-B) — Astryx n'a pas de clé, et sa liste de noms reste fermée.
 *
 * **La seule icône de l'app rendue en grand** : elle est le sujet de l'écran, pas un
 * ornement de contrôle. D'où la taille portée ici plutôt que par l'appelant.
 *
 * Le trait reste celui des autres, 1,5 : à 56 px il rend 3,5 px à l'écran, soit une ligne
 * plus franche qu'à 44 px sans qu'on ait à sortir de la géométrie commune. C'est
 * l'agrandissement qui donne le poids, pas un trait d'exception.
 */
export const IconeCle: ReactNode = (
  <svg {...trait} width={56} height={56}>
    <circle cx="12" cy="6.75" r="3.75" />
    <path d="M12 10.5V20.5" />
    <path d="M12 14.5h3" />
    <path d="M12 17.5h2.25" />
  </svg>
);

/**
 * Les deux actions de son propre profil. Astryx n'a ni crayon ni sortie, et
 * sa liste de noms reste un type fermé.
 *
 * Le trait du crayon traverse le corps de bord à bord — c'est la virole, et c'est elle
 * qui empêche la forme de se lire comme une simple flèche. La sortie garde le battant
 * ouvert du côté de la flèche : une porte fermée traversée par une flèche dit l'entrée.
 */
export const IconeEdition: ReactNode = (
  <svg {...trait}>
    <path d="m4.5 19.5 1-4 11-11a1.8 1.8 0 0 1 2.5 0l.5.5a1.8 1.8 0 0 1 0 2.5l-11 11z" />
    <path d="m14.5 6.5 3 3" />
  </svg>
);

export const IconeDeconnexion: ReactNode = (
  <svg {...trait}>
    <path d="M15.5 7.5v-2A1.5 1.5 0 0 0 14 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h8a1.5 1.5 0 0 0 1.5-1.5v-2" />
    <path d="M9 12h11" />
    <path d="m17 9 3 3-3 3" />
  </svg>
);

/**
 * Les trois icônes des Info buttons (M-H). Astryx n'a ni cloche, ni
 * réglages, ni « ajouter quelqu'un », et sa liste de noms reste un type fermé.
 *
 * La cloche est **barrée** : le bouton ouvre le réglage de notification, et l'état
 * « en silence » se lit alors sans ouvrir. Une cloche pleine dirait l'inverse.
 */
export const IconeMuet: ReactNode = (
  <svg {...trait}>
    <path d="M18 15.5V11a6 6 0 0 0-9.2-5.1M6 9.7V15.5l-1.5 2h15" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    <path d="m4 4 16 16" />
  </svg>
);

export const IconeOptions: ReactNode = (
  <svg {...trait}>
    <circle cx="12" cy="12" r="2.75" />
    <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
  </svg>
);

export const IconeAjouterMembre: ReactNode = (
  <svg {...trait}>
    <circle cx="10" cy="8" r="3.75" />
    <path d="M3.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M18.5 6.5v6M15.5 9.5h6" />
  </svg>
);

/**
 * **Les six icônes reprises à Astryx** (ajoutées, revue de conception R-01).
 *
 * Elles existaient dans le jeu de la bibliothèque, et c'était le problème : `chevronLeft`
 * et `info` d'Astryx voisinaient `IconeAppel` et `IconeVideo` d'ici dans la **même** barre
 * d'outils de l'écran Conversation — deux grilles, deux épaisseurs de trait, deux tailles
 * optiques, séparées par 4 px de gouttière. L'œil ne sait pas nommer une différence de
 * provenance, il la voit en une demi-seconde.
 *
 * Redessinées sur le `trait` ci-dessus, donc : 24×24, 1,5, extrémités rondes. Le jeu de
 * l'application est désormais **entier** — plus aucun composant n'importe `Icon`.
 */
export const IconeRetour: ReactNode = (
  <svg {...trait}>
    <path d="m14.5 5-7 7 7 7" />
  </svg>
);

export const IconeChevron: ReactNode = (
  <svg {...trait}>
    <path d="m9.5 5 7 7-7 7" />
  </svg>
);

export const IconeFermer: ReactNode = (
  <svg {...trait}>
    <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />
  </svg>
);

export const IconeInfo: ReactNode = (
  <svg {...trait}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v6" />
    <path d="M12 7.6v.1" />
  </svg>
);

export const IconeCopier: ReactNode = (
  <svg {...trait}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M16 5.5H6a2.5 2.5 0 0 0-2.5 2.5v10" />
  </svg>
);

export const IconeDavantage: ReactNode = (
  <svg {...trait}>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </svg>
);

/**
 * **Les coches d'accusé de réception** (30/08/2026, revue de conception E-08).
 *
 * Elles étaient les caractères `✓` et `✓✓`, posés dans un `<span>` : des glyphes
 * typographiques au milieu d'une interface dont toutes les autres marques sont des SVG au
 * trait. Épaisseur différente, alignement vertical différent, et un dessin qui change
 * d'une plateforme à l'autre — DESIGN.md nomme pourtant la coche verte « trait
 * d'identité », et c'était le seul que l'équipe ne dessinait pas.
 *
 * Grille de 16 plutôt que de 24, à trait égal (1,5 en unités utilisateur) : à la taille
 * où elles se rendent — la ligne du message —, une géométrie de 24 réduite donnerait un
 * trait plus fin que celui de toutes les autres icônes. La grille change, le trait non.
 */
const traitPetit = { ...trait, width: 16, height: 16, viewBox: "0 0 16 16" } as const;

export const IconeCoche: ReactNode = (
  <svg {...traitPetit}>
    <path d="m3 8.5 3.5 3.5L13 5" />
  </svg>
);

export const IconeDoubleCoche: ReactNode = (
  <svg {...traitPetit}>
    <path d="m1.5 8.5 3.5 3.5L11.5 5" />
    <path d="m8 12 6.5-7" />
  </svg>
);

/**
 * Lecture et pause du message vocal (30/08/2026, revue de conception R-03). Le bouton
 * portait un `label` sans `icon` ni `isIconOnly` : Astryx rendait donc la phrase « Lire le
 * message vocal » en toutes lettres, collée à une forme d'onde dessinée au pixel. Le
 * libellé reste — il devient l'étiquette accessible, motif du bouton d'envoi du composer.
 */
export const IconeLecture: ReactNode = (
  <svg {...trait} fill="currentColor" stroke="none">
    <path d="M7.5 5.2 18 12 7.5 18.8z" />
  </svg>
);

export const IconePause: ReactNode = (
  <svg {...trait} fill="currentColor" stroke="none">
    <rect x="7" y="5.5" width="3.5" height="13" rx="1" />
    <rect x="13.5" y="5.5" width="3.5" height="13" rx="1" />
  </svg>
);

/**
 * **Les quatre icônes d'état vide** (30/08/2026, revue de conception R-04).
 *
 * DESIGN.md prescrit « Placeholder — icône au trait monochrome, pas d'illustration
 * cartoon », et le composant accepte bien une prop `icone`. Sur seize appels, aucun ne la
 * passait : tous les états vides de l'application étaient du texte centré sans ancre
 * visuelle, ce qui les fait lire comme une erreur d'affichage plutôt que comme une
 * réponse. La règle était écrite, le composant prêt, et personne ne s'en servait.
 *
 * Les autres états vides réutilisent des icônes déjà là — recherche, muet, appel, ajout de
 * membre. Ces quatre-ci manquaient.
 */
export const IconeConversation: ReactNode = (
  <svg {...trait}>
    <path d="M20.5 4.5h-17v13h5v4l5-4h7z" />
  </svg>
);

export const IconeFichier: ReactNode = (
  <svg {...trait}>
    <path d="M6 3.5h7l5 5v12H6z" />
    <path d="M13 3.5v5h5" />
  </svg>
);

export const IconeLien: ReactNode = (
  <svg {...trait}>
    <path d="M10.2 13.8a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
    <path d="M13.8 10.2a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
  </svg>
);

export const IconeEpingle: ReactNode = (
  <svg {...trait}>
    <path d="M9 3.5h6l-1 6 3.5 3.5H6.5L10 9.5z" />
    <path d="M12 13v7.5" />
  </svg>
);

/**
 * **Deux icônes de statut et un chevron** (30/08/2026, plaintes utilisateur).
 *
 * `IconeChevronBas` remplace la roue crantée sur le bouton « Options » des informations
 * d'une conversation : ce bouton **fait défiler la page** jusqu'aux cartes d'options, il ne
 * réglait jamais rien. Une roue crantée promet des réglages ; un chevron vers le bas
 * promet ce qui se passe.
 *
 * `IconeBloque` et `IconeCoche` servent au statut de l'écran profil, où le mot était
 * écrit en toutes lettres dans un badge.
 */
export const IconeChevronBas: ReactNode = (
  <svg {...trait}>
    <path d="m5 9.5 7 7 7-7" />
  </svg>
);

export const IconeBloque: ReactNode = (
  <svg {...trait}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 6 12 12" />
  </svg>
);
