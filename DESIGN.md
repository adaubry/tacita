# DESIGN.md

Les règles visuelles de Tacita. Elles sont ici pour qu'on puisse les tenir — et pour
qu'on sache ce qu'on casse quand on en change une.

**Les valeurs vivent dans les tokens, pas dans cette page.** `components/foundation/palette.ts`
porte la table de couleurs, `theme.ts` la traduit, `tokens.css` tient ce qui n'a pas de
logement ailleurs. Ce fichier dit à quoi chaque token sert et ce qu'il interdit ; le token
dit combien. Un nombre écrit aux deux endroits finit par diverger, et c'est alors la prose
qu'on croit.

## L'intention

**Un instrument de précision.** L'app ne cherche pas à avoir l'air moderne — c'est la voie
la plus courte vers l'air daté. Elle vise la qualité perçue d'un bel outil : neutre, exact,
silencieux.

1. **Clair par défaut.** Le sombre existe en réglage, mais ce n'est pas l'identité.
2. **Un accent, et une teinte par conversation.** Rien d'autre. Voir § Couleur.
3. **La géométrie est la signature.** Grille de 4 pt, rayons constants, filets de 1 px
   plutôt qu'ombres, alignements exacts, chiffres tabulaires pour toute heure et tout
   compteur. La précision *est* le style.
4. **Zéro effet de mode.** Interdits : dégradés décoratifs, glassmorphism, blobs, néon,
   ombres portées molles, emoji dans l'UI, animations démonstratives. Si un effet se
   remarque, il est de trop.

Deux exceptions, nommées et bornées, toutes deux sur l'écran profil et toutes deux pour la
même raison — **une photo fournie par l'utilisateur derrière un élément qui doit rester
lisible**, où aucun contraste n'est vérifiable à l'avance : le verre du bouton de retour
(`--tacita-verre`) et l'ombre diffuse de l'avatar (`--tacita-ombre-avatar`). S'il en
apparaît une troisième ailleurs, c'est que la règle a cédé, pas qu'elle a une famille.

## Couleur

Neutres à très léger sous-ton vert. Le clair est le thème de référence ; le sombre en
dérive, neutre lui aussi — jamais bleuté, jamais noir pur.

| Token | Usage |
|---|---|
| `bg` | fond d'application |
| `surface` | cartes, listes, bulles reçues, champ d'écriture |
| `surface-raised` | modales, menus, feuilles |
| `hairline` | filets, contours, séparateurs |
| `text` / `text-muted` | encre principale / aperçus, dates, méta |
| `accent` | **actions** : envoi, onglet actif, liens, coches « lu » |
| `accent-soft` | fonds d'action atténués, mention, sélection |
| `danger` | supprimer, refuser, quitter, bloquer — **jamais** pour de l'emphase |
| `warning` | avertissements et limites connues |
| `highlight` | occurrences de recherche et `@moi` |
| `scrim` | voile de lisibilité sur fond d'écran personnalisé |
| `viewer` / `on-viewer` | visionneur plein écran — **sombre dans les deux thèmes** |
| `glass` | bouton de retour du profil, et lui seul |

### La teinte d'une conversation

**La teinte dit *où tu es*, l'accent dit *ce que tu fais*.** C'est la règle, et elle ne
souffre pas d'exception : un bouton teinté ferait des deux la même chose.

La teinte prend l'avatar, le nom de l'interlocuteur, le filet d'en-tête, le badge de
non-lus et vos bulles. L'accent garde l'envoi, l'onglet actif, les coches, les liens et le
surlignage de recherche — trouver est une fonction, pas une identité.

Elle se dérive d'une clé — **le correspondant en message direct, le salon en groupe** — et
non d'un réglage : rien n'est stocké, rien n'est synchronisé, et la même conversation a la
même couleur sur tous les appareils. Voir `components/foundation/teinte.ts`.

Trois propriétés qui ne sont pas négociables :

- **Seule la teinte angulaire tourne.** Clarté et chroma sont figés (OKLCH). Les couleurs
  ont donc le même poids perçu, et leur contraste est bon *par construction* — pas de
  matrice à vérifier à la main, pas de « le violet est trop sombre ».
- **Neuf pas, pas trois cent soixante.** Deux conversations voisines doivent être
  distinguables, pas uniques.
- **Aucune teinte à moins de 45° de l'accent.** Sans ce retrait, une conversation
  malchanceuse prendrait exactement la couleur des actions.

`teinte.test.ts` tient les trois sans navigateur. Si l'accent change un jour, c'est ce test
qui dira que la roue doit bouger.

Règles communes : contraste AA vérifié pour chaque paire ; badges de non-lus en encre sur
voile, jamais de pastille rouge ; aucune autre couleur n'existe.

## Typographie

Pile système, aucune webfont : native, rapide, intemporelle — la personnalité vient de la
composition, pas d'une fonte. Mono pour les identifiants et la clé de récupération.

**Deux graisses, 400 et 600.** La hiérarchie se fait par taille, espace et couleur, jamais
par accumulation de graisses. **Chiffres tabulaires obligatoires** pour heures, dates,
compteurs et durées : rien ne doit bouger quand les chiffres changent.

| Style | Taille / interligne | Graisse | Usage |
|---|---|---|---|
| display-large | 28/32 | 600 | le nom sur l'écran profil, et lui seul |
| display | 22/28 | 600 | titres d'écran |
| title | 17/24 | 600 | titres de layout |
| body-strong | 15/20 | 600 | noms d'auteurs, titres de cartes |
| body | 15/20 | 400 | messages, contenu courant |
| secondary | 13/18 | 400 | aperçus, notes, méta |
| caption | 12/16 | 600 | heures, badges, séparateur de date |

Pas d'italique pour l'information critique, pas de capitales espacées, pas de texte en
accent hors liens et actions.

## Élévation

La profondeur s'exprime d'abord par le **filet** ; l'ombre est un murmure. Quatre niveaux.

| | Usage |
|---|---|
| e0 | fond, timeline |
| e1 | cartes, aperçus, bulles, champ d'écriture |
| e2 | menus, modales, feuilles |
| e3 | toasts, bannière d'appel |

Jamais d'ombre sans filet — à l'exception nommée en § L'intention.

## Géométrie

Espacement en multiples de 4 uniquement. Contrôles r6, cartes et modales r10, feuilles r12.
**Avatars en carré arrondi** (`--tacita-radius-avatar`), signature délibérée face aux
cercles de toutes les messageries. Cibles tactiles ≥ 36 px — la barre de navigation pose
44 px à la main. Safe-areas iOS en mode installé. Séparation par filet ou par espace,
jamais par un changement de fond gratuit.

## Les formes qui portent l'identité

**La timeline est en bulles, groupées à 5 minutes.** Reçu à gauche sur `surface` et son
filet, envoyé à droite sur le voile de la conversation — **un seul côté est teinté**,
colorier les deux fait une salade de fruits dont on ne lit plus le sens.

L'arête **côté auteur** est serrée (`--tacita-radius-bulle-serre`), l'opposée ronde
(`--tacita-radius-bulle`), et le coin haut de la première bulle d'un groupe reste rond :
c'est ce qui fait lire une grappe comme une seule prise de parole. 2 px entre deux bulles
d'une même grappe — elles doivent se toucher sans fusionner. **Pas de queue pointue** :
elle casse l'empilement, et c'est le détail qui date le plus vite une messagerie. Le nom ne
se répète pas dans un groupe et ne s'écrit jamais pour soi ; l'heure et l'accusé de
réception se posent au pied de la grappe.

**Un média n'entre pas dans une bulle** : dans la timeline il *est* le message et garde le
cadrage de son auteur. Dans une galerie il devient une planche contact — trois carrés par
ligne, rognés au centre, sans arrondi, séparés par le plus petit écart de l'échelle.

**L'action primaire d'une paire est une teinte, pas un pavé.** L'accent doit occuper moins
de 5 % d'un écran courant ; une liste de demandes avec un aplat plein par carte le rend
ambiant, ce qui est un défaut de conception. Le primaire prend `accent-soft` avec l'encre
d'accent (`.tacita-bouton-doux`), son voisin reste nu. Deux poids, une seule famille.

**Toute feuille et toute modale offrent deux sorties** : un bouton de fermeture *et* le
clic sur le fond. Il n'y a pas de touche Échap sur un téléphone.

**La barre d'écriture est une rangée**, au bas d'un écran de hauteur fixée dont seule la
timeline défile : `[+] [champ] [photo] [envoyer]`. Le champ est la seule surface de la
rangée ; les boutons sont nus autour, trois cadres côte à côte feraient trois boîtes à
lire.

**Un appel entrant est une bannière, pas un plein écran**, posée sous la barre d'en-tête —
jamais dessus, sinon elle masque la seule sortie de l'écran. L'action destructive n'est
jamais la première sous le pouce. Un appel passé est une ligne de séparateur, pas un
message : un appel terminé est du contexte.

Chaque composant doit rendre ses états de chargement (squelette de même géométrie que le
contenu final, zéro décalage), vide, erreur et hors ligne, et être correct dans les deux
thèmes.

## À faire, à ne pas faire

**À faire**

- Passer par les tokens. Une couleur nouvelle est une modification de ce fichier *et* de la
  palette, jamais une valeur en dur dans un composant.
- Aligner sur la grille de 4. En cas de doute, plus d'espace plutôt qu'un trait de plus.
- Animer en 120–180 ms, ease-out, `transform` et `opacity` seules. Le mouvement confirme,
  il ne divertit pas.
- Donner à chaque geste un équivalent visible.
- Dire les limites en une phrase sobre, non modale.
- Demander les permissions au moment de l'usage, avec un rattrapage en réglages.

**À ne pas faire**

- Pas de Tailwind, shadcn, Bootstrap ni CSS-in-JS tiers. Pas de copie des couleurs
  WhatsApp ou iMessage : notre vert est profond et rare, pas un vert d'état.
- Pas de dégradés, de verre, de néon, de mode sombre « stylé ». Le sombre est un réglage
  d'usage, pas une esthétique.
- Pas de spinner plein écran : des squelettes localisés. Pas d'état vide brut.
- Pas d'option grisée sans explication, pas de « bientôt disponible », rien d'affiché qui
  ne marche pas.
- Pas de pastille rouge de culpabilisation. `danger` est réservé au destructif.
- Jamais de contenu déchiffré dans les journaux, la télémétrie ou le cache du service
  worker — aucun corps de message dans un message d'erreur.
