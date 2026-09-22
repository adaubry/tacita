# DESIGN.md

## Overview

**Stratégie d'identité : l'instrument de précision.** L'app ne cherche pas à avoir l'air « moderne » — c'est la voie la plus courte vers l'air daté. Elle vise la qualité perçue d'un bel outil : neutre, exact, silencieux. Quatre principes non négociables :

1. **Clair par défaut.** Fond neutre, texte encre. Le sombre existe (réglage, REQ-UI-03) mais n'est pas l'identité. La lumière est ce qui vieillit le mieux et ce qui paraît poli au plus grand nombre.
2. **Une seule couleur.** Un vert profond, rare et constant. Tout le reste est neutre. La retenue chromatique est ce qui distingue un produit fini d'un prototype.
3. **Géométrie stricte — c'est la signature.** Grille de 4 pt partout, rayons faibles et constants, filets fins (hairlines de 1 px) plutôt qu'ombres, alignements exacts, chiffres tabulaires pour toute heure et tout compteur. La précision EST le style.
4. **Zéro effet de mode.** Interdits définitifs : dégradés, glassmorphism/flou décoratif, blobs, néon, ombres portées molles, coins très arrondis, emoji décoratifs dans l'UI, animations démonstratives. Si un effet se remarque, il est de trop.

Géométrie de référence : contrôles r6, cartes et modals r10, bottom-sheets r12 ; **avatars en carré arrondi (rayon 25 %)** — signature délibérée face aux cercles de toutes les messageries ; espacement uniquement en multiples de 4 ; séparation par hairline ou par espace, jamais par changement de fond gratuit. Timeline Discord-style sans bulles, inchangée. Toute couleur passe par les tokens ci-dessous (mappés sur le thème Astryx au spike M-A) ; **aucune valeur hexadécimale dans le code des composants**. Cibles tactiles ≥ 44 px, safe-areas iOS en standalone.

## Colors

Neutres à très léger sous-ton vert (invisible consciemment, cohérent avec l'accent). Le clair est le thème de référence ; le sombre en dérive, neutre lui aussi — jamais bleuté, jamais noir pur.

| Token | Clair (défaut) | Sombre | Usage |
|---|---|---|---|
| `bg` | #F6F7F6 | #131514 | fond d'application |
| `surface` | #FFFFFF | #1B1E1D | cartes, listes, composer |
| `surface-raised` | #FFFFFF | #232726 | modals, dropdowns, bottom-sheets |
| `hairline` | #E2E5E3 | #303534 | filets, contours, séparateurs |
| `text` | #1A1D1C | #E9ECEA | texte principal (encre) |
| `text-muted` | #5E6663 | #9AA39F | aperçus, dates, user ids, méta |
| `accent` | #155E4D | #4FBD96 | actions primaires, état actif, liens, coches « délivré/lu » |
| `accent-pressed` | #0E463A | #3EA381 | état pressé de l'accent |
| `accent-soft` | #155E4D à 10 % | #4FBD96 à 16 % | fonds de mention, selector actif, badge @ |
| `read` | = `accent` | = `accent` | double coche « lu » — la coche verte est un trait d'identité |
| `success` | = `accent` | = `accent` | accepter, états positifs (pas de second vert) |
| `danger` | #B3352C | #E5716A | supprimer, refuser, quitter, bloquer |
| `warning` | #9A6A00 | #D9A441 | avertissements (limites connues) |
| `highlight` | #155E4D à 14 %, texte `text` | #4FBD96 à 22 %, texte `text` | occurrences de recherche, `@me` |
| `scrim` | #FFFFFF à 40 % | #131514 à 60 % | voile de lisibilité sur fond d'écran personnalisé |

Règles : l'accent occupe moins de 5 % de tout écran courant — s'il devient ambiant, c'est un bug de design ; `danger` jamais pour de l'emphase non destructive ; badges de non-lus en `text` sur `accent-soft` (pas de pastille rouge, cf. PRODUCT.md) ; contraste AA vérifié pour chaque paire ; aucune autre couleur n'existe.

## Typography

Pile système, aucune webfont : native, rapide, intemporelle — la personnalité vient de la composition, pas d'une fonte de caractère. `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`. Mono pour user ids et clé de récupération : `ui-monospace, "SF Mono", Consolas, monospace`.

**Deux graisses seulement : 400 et 600.** La hiérarchie se fait par taille, espace et couleur (`text` vs `text-muted`), pas par accumulation de graisses. **Chiffres tabulaires** (`font-variant-numeric: tabular-nums`) obligatoires pour heures, dates, compteurs et durées — rien ne bouge quand les chiffres changent.

| Style | Taille/interligne | Graisse | Usage |
|---|---|---|---|
| display | 22/28 | 600 | nom dans Conversation starter et Profile card |
| title | 17/24 | 600 | titres de layout (header) |
| body-strong | 15/20 | 600 | noms d'auteurs, titres de cartes |
| body | 15/20 | 400 | messages, contenu courant |
| secondary | 13/18 | 400 | aperçus, notes, méta |
| caption | 12/16 | 600 | heures, badges, séparateur de date, libellés d'Info buttons |

Pas d'italique pour l'information critique, pas de capitales de tracking, pas de texte en accent hors liens et actions.

## Elevation

La profondeur s'exprime d'abord par le **filet** (hairline), l'ombre est un murmure. Quatre niveaux, pas plus.

| Niveau | Usage | Clair | Sombre |
|---|---|---|---|
| e0 | fond, timeline | aucun | aucun |
| e1 | cartes, previews, composer | `surface` + hairline | `surface` + hairline |
| e2 | dropdowns, hold menu, modals, sheets | `surface-raised` + hairline + ombre 0 2 8 à 8 % | `surface-raised` + hairline |
| e3 | toasts, bannière d'appel en cours | `surface-raised` + hairline + ombre 0 4 12 à 10 % | `surface-raised` + hairline + ombre 0 4 12 à 40 % |

Jamais d'ombre sans hairline. Le bouton actif de la navbar est « surélevé » (wireframe) par translation de −1 px + `accent` sur l'icône — pas d'ombre, pas de halo. Le séparateur de date est l'élévation zéro incarnée : hairline — caption — hairline, centré.

## Components

Primitives Astryx imposées (wireframe) : `SegmentedControl` (fond `accent-soft` sur l'option active), `DropdownMenu` (icône à gauche), `NavIcon` (navbar, listes de boutons), `ClickableCard`, `Toolbar` (headers), `PowerSearch` (tokens selon contexte), `Chat` (composer). Interdiction de recoder une primitive existante d'Astryx.

Composants composés (les 26 du wireframe, mappés dans `specs/ui/00-plan-frontend.md`) : un composant = un fichier nommé, réutilisé partout, variations par props. Obligations transverses : états chargement (Skeleton de même géométrie que le contenu final, zéro layout shift), vide (Placeholder — icône au trait monochrome, pas d'illustration cartoon), erreur et hors ligne ; rendu correct dans les deux thèmes ; avatars en carré arrondi 25 % partout (ConversationAvatar est le seul endroit qui rend un avatar). Traits signature à préserver : regroupement Discord des messages (règle des 5 minutes), coches vertes, séparateur de date au filet, forme d'onde des vocaux en barres verticales strictes sur la grille.

## Do's and Don'ts

**Do**
- Tokens uniquement ; nouvelle couleur = modification de ce fichier (validée Tech Lead), jamais du composant.
- Aligner tout sur la grille de 4 pt ; en cas de doute, plus d'espace plutôt qu'un trait de plus.
- Animations 120–180 ms, ease-out, transform/opacity uniquement ; le mouvement confirme, il ne divertit pas.
- Gestes : seuils d'axe et de distance, zone morte de 20 px au bord gauche pour le swipe droit sur message ; chaque geste a un équivalent visible.
- Libellés honnêtes sur les limites (réactions en clair, « délivré » non standard, note locale, périmètre de recherche) — une phrase sobre, non modale.
- Permissions demandées au moment de l'usage, chemin de rattrapage en réglages.

**Don't**
- Pas de Tailwind, shadcn, Bootstrap, CSS-in-JS tiers ; pas de copie des couleurs WhatsApp/iMessage — notre vert est profond et rare, pas un vert d'état.
- Pas de dégradés, glass, néon, blobs, mode sombre « stylé » : le sombre est un réglage d'usage, pas une esthétique.
- Pas de spinner plein écran : skeletons localisés. Pas d'état vide brut : toujours Placeholder.
- Pas d'option grisée sans explication, pas de « coming soon », rien d'affiché qui ne marche pas.
- Pas de pastille rouge de culpabilisation ; `danger` réservé au destructif ; pas de modale d'interruption hors action destructive.
- Jamais de contenu déchiffré dans les logs, la télémétrie ou le cache SW — aucun corps de message dans un message d'erreur.
