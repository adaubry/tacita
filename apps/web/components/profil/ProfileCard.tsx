/**
 * La carte de profil : bandeau, avatar, et le fondu entre les deux.
 *
 * L'essentiel du fichier est de la géométrie — `TAILLE_AVATAR`, `MARGE_OMBRE`,
 * `QUEUE_FONDU`, `ZONE_OPAQUE` — parce que l'avatar chevauche le bandeau et que le
 * dégradé doit rester opaque exactement sous lui. Ces valeurs se répondent : en
 * changer une seule décolle l'ombre du cadre.
 */
"use client";

import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { identifiantCourt } from "../../lib/identifiants";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { variablesTeinte } from "../foundation/teinte";
import { useImageMxc } from "../foundation/useImageMxc";
import {
  IconeAjouterMembre,
  IconeBloque,
  IconeCoche,
  IconeRetour,
} from "../foundation/icons";
import { Button, Text } from "../foundation/primitives";

interface ProfileCardProps {
  nom: string;
  /** L'identifiant Matrix, affiché sous le nom sur son propre profil. */
  userId?: string;
  /**
   * La clé de teinte — l'identifiant Matrix de la personne regardée. **Absente sur son
   * propre profil** : la teinte distingue les autres les uns des autres, et se l'attribuer
   * à soi-même ne distingue rien. L'écran de soi garde donc l'aplat d'accent.
   */
  cle?: string;
  /** le `mxc://` de la photo. Absent → initiales. */
  avatarUrl?: string;
  /** le `mxc://` de la bannière. Absent → l'aplat d'accent doux. */
  bannerUrl?: string;
  /** Actions de droite : réglages pour soi, options relatives à la personne sinon. */
  actions?: ReactNode;
  /**
   * le statut ami/non-ami, **avant** les options. Absent sur son propre
   * profil : la question ne s'y pose pas.
   */
  statut?: "ami" | "non-ami" | "bloque";
  /**
   * Le bouton de retour. Présent partout où cette carte est une **page** ; absent là où
   * elle n'en est pas une — l'étape d'identité du parcours d'accueil (M-B), où il n'y a
   * aucun écran derrière et où `router.back()` sortirait de l'application. Un bouton qui
   * ne mène nulle part est pire qu'un bouton absent (même jurisprudence que l'engrenage
   * retiré de ce bandeau).
   */
  retour?: boolean;
}

/**
 * **Le statut est une icône, pas un mot** (30/08/2026, plainte : « le badge "ami" devrait
 * être une icône, pas du texte »).
 *
 * Trois raisons de céder. Le badge est posé sur une **photo choisie par l'utilisateur** :
 * un mot y demande un fond opaque pour rester lisible, une forme s'en passe mieux. Il
 * partage sa rangée avec le bouton d'options, qui est une icône : deux objets de même rang
 * dessinés dans deux registres. Et « Pas encore ami » est long — sur un nom qui remplit la
 * ligne, il poussait le bouton d'options vers le bord.
 *
 * Le mot reste, en étiquette accessible : ce qui se lit à l'œil devient une forme, ce qui
 * se lit à l'oreille ne perd rien.
 */
const STATUT = {
  ami: { libelle: "Ami", icone: IconeCoche },
  "non-ami": { libelle: "Pas encore ami", icone: IconeAjouterMembre },
  bloque: { libelle: "Bloqué", icone: IconeBloque },
} as const;

/**
 * Géométrie de l'en-tête, toute sur la grille de 4 pt (DESIGN.md § Overview).
 *
 * **La bannière ne se pose pas une hauteur : elle la déduit de ce qu'elle doit contenir.**
 * Une constante en dur ne pouvait pas tenir la promesse « l'avatar ne dépasse pas d'un
 * pixel de la partie non fondue » — sur un appareil à encoche la safe-area pousse le
 * bandeau vers le bas, l'avatar avec lui, et un nombre figé le faisait déborder dans le
 * fondu sans que rien ne le dise. La hauteur est donc une somme, et l'ordre des termes
 * **est** le dessin :
 *
 *     BANDEAU (safe-area + rail + bouton 36 + 24 sous le bouton)
 *   + TAILLE_AVATAR                                 ← fin de la zone opaque
 *   + QUEUE_FONDU
 *   = hauteur de la bannière
 *
 * `ZONE_OPAQUE` est donc à la fois le bas de l'avatar et le début du fondu de la
 * bannière : les deux dissolutions se déclenchent exactement sur la même ligne, et
 * l'avatar est contenu, au pixel, dans la partie pleine de l'image.
 */
const BANDEAU =
  "calc(env(safe-area-inset-top, 0px) + var(--spacing-3) + var(--spacing-9) + var(--spacing-6))";
/**
 * 128 et non 112 : l'échelle d'avatars d'Astryx est discrète (…96, 128, 144…) et on ne
 * force pas une valeur hors palier pour gagner 16 px.
 */
const TAILLE_AVATAR = 128;
/** La dissolution de la bannière, sous l'avatar. 72 px = grille de 4 pt, et c'est elle qui
 *  détache le nom de la photo — pas un `margin` de plus. */
const QUEUE_FONDU = 72;
/**
 * La place réservée **à l'intérieur** de la boîte masquée pour que l'ombre de l'avatar ait
 * où se peindre.
 *
 * Un masque ne clippe pas que son élément : tout ce qui est peint hors de la boîte du
 * masque disparaît, ombre portée comprise. Une ombre posée sans cette marge serait
 * simplement invisible — et invisible en silence, ce qui est pire. La marge est donc du
 * padding transparent, et les arrêts du dégradé se comptent depuis elle, en pixels absolus
 * plutôt qu'en pourcentages : un pourcentage se rapporterait à la boîte *avec* la marge, et
 * le fondu ne tomberait plus sur le bord de l'avatar.
 */
const MARGE_OMBRE = 24;
/** Fin de la partie pleine de l'avatar, puis son bord bas — repères du masque. */
const AVATAR_OPAQUE = MARGE_OMBRE + 88;
const AVATAR_BAS = MARGE_OMBRE + TAILLE_AVATAR;
const ZONE_OPAQUE = `calc(${BANDEAU} + ${TAILLE_AVATAR}px)`;
const HAUTEUR_BANNIERE = `calc(${ZONE_OPAQUE} + ${QUEUE_FONDU}px)`;

/**
 * **Le fondu, en courbe et non en pente.**
 *
 * Un `linear-gradient` à deux arrêts fait varier l'alpha à vitesse constante, ce qui
 * paraît doux au milieu mais casse aux deux bouts : là où l'opacité quitte 1 et là où
 * elle atteint 0, la dérivée saute d'un coup, et l'œil lit ces deux ruptures comme des
 * lignes — un bord haut de fondu au-dessus de l'avatar, un bord bas au ras du nom. C'est
 * précisément ce qu'on voyait : les deux masques *étaient* des dégradés, et paraissaient
 * quand même coupés.
 *
 * La rampe est donc échantillonnée sur un **smoothstep** (`t²(3−2t)`), dont la pente est
 * nulle aux deux extrémités : le fondu naît et meurt sans arête. C'est la forme la plus
 * douce qu'on puisse donner à une distance donnée — la contrepartie est un milieu 1,5 fois
 * plus raide, invisible parce que c'est justement là qu'il n'y a aucun repère.
 *
 * Échantillonné et non calculé par le navigateur : CSS n'a pas de fonction d'assouplissement
 * dans les dégradés (les « interpolation hints » ne donnent qu'une exponentielle, qui
 * adoucit un bout en durcissant l'autre). Douze paliers suffisent — l'écart au vrai
 * smoothstep reste sous le demi-pour-cent d'alpha, très en dessous du seuil de bande.
 *
 * `color-mix` sur `black` et `transparent` plutôt qu'un `rgb()` : dans un masque seule
 * l'alpha compte, et n'écrire que des mots-clés garde la règle de DESIGN.md littérale —
 * aucune valeur de couleur en dur dans un composant, pas même une qui ne sera jamais
 * rendue.
 */
const PALIERS = 12;
function fonduDoux(debut: string, longueur: number): string {
  const arrets = Array.from({ length: PALIERS + 1 }, (_, rang) => {
    const t = rang / PALIERS;
    // 1 − smoothstep(t) : opaque au départ, transparent à l'arrivée.
    const opacite = Math.round((1 - t * t * (3 - 2 * t)) * 100);
    return `color-mix(in srgb, black ${opacite}%, transparent) calc(${debut} + ${Math.round(longueur * t)}px)`;
  });
  return `linear-gradient(to bottom, ${arrets.join(", ")})`;
}

/**
 * Le rail gauche de l'écran. `--spacing-3` n'est pas un choix local : c'est la gouttière
 * de tous les écrans de l'app (listes, réglages, infos de conversation). L'avatar, le nom,
 * l'identifiant et le bouton de retour s'alignent donc sur **la même verticale** que les
 * cartes d'option qui suivent, sans qu'aucun des deux ne cède de 4 px.
 */
const RAIL = "var(--spacing-3)";

/**
 * composant 21, la « profile card ».
 *
 * Trois couches, dans cet ordre de profondeur :
 *
 * 1. **la bannière**, fond de la carte, qui se dissout par le bas dans le fond de page ;
 * 2. **le bandeau d'actions**, qui *flotte* par-dessus elle — il ne pousse rien, il ne
 *    prend pas de place, et on voit la bannière au travers ;
 * 3. **l'avatar**, posé *dans* la bannière et fondu lui aussi.
 *
 * **Composition sur un rail, et non sur un axe**. Tout était centré : la
 * bannière devait s'échapper du centrage par un `justifySelf`, et l'œil n'avait aucun
 * point d'entrée — une colonne symétrique n'a pas de premier élément. L'identité est
 * désormais alignée à gauche sur `RAIL`, ce qui donne à l'écran une arête verticale que
 * l'avatar, le nom, l'identifiant et le retour partagent. La position redevient un outil
 * de hiérarchie, au lieu d'être dépensée en symétrie.
 *
 * **L'avatar appartient à la bannière, le nom appartient à la page.** L'avatar chevauchait
 * le bord et dépassait dans le fond de page : il flottait entre les deux couches sans être
 * d'aucune, et le nom collé dessous en faisait un bloc unique de trois hauteurs de texte
 * différentes. Il est maintenant contenu, au pixel, dans la partie non fondue de l'image
 * (`ZONE_OPAQUE`) — donc positionné en absolu, ce qui est légitime ici parce que la
 * bannière réserve déjà la place ; c'était l'objection contre l'absolu, elle est tombée.
 * Ce qui sépare l'avatar du nom n'est pas une marge, c'est `QUEUE_FONDU` : les 72 px où
 * l'image s'éteint. La séparation est **de la matière**, pas du vide.
 *
 * Le fondu est un `mask-image` et non un calque posé par-dessus : un calque devrait
 * connaître la couleur du fond, donc la coder en dur, et casserait au changement de
 * thème. `black` et non `#000` : dans un masque, seule l'**alpha** compte — la couleur
 * n'est jamais rendue. Un littéral hexadécimal ici ferait croire à une couleur en dur, ce
 * que DESIGN.md interdit, et le garde-fou de `theme.test.ts` le refuse désormais.
 */
export function ProfileCard({
  nom,
  userId,
  cle,
  avatarUrl,
  bannerUrl,
  actions,
  statut,
  retour = true,
}: ProfileCardProps) {
  const router = useRouter();
  const banniere = useImageMxc(bannerUrl);
  // La rampe ne prend que les 40 derniers pixels des 128. Elle en a pris les deux tiers un
  // moment : depuis que l'avatar est **dans** la bannière, ce fondu ne se dissout plus dans
  // un fond neutre mais dans une photo, et une longue rampe d'image sur image ne lit pas
  // comme une dissolution — elle lit comme du flou. La distance ne bouge donc pas ; c'est
  // la **courbe** qui adoucit (voir `fonduDoux`), et elle le fait sans rien coûter au dessin.
  const fonduAvatar = fonduDoux(
    `${AVATAR_OPAQUE}px`,
    AVATAR_BAS - AVATAR_OPAQUE,
  );
  // La bannière est pleine sur toute la hauteur qui porte l'avatar, puis s'éteint sur les
  // 72 px de `QUEUE_FONDU`. Le départ n'est pas un pourcentage mais `ZONE_OPAQUE` : un
  // pourcentage aurait glissé dès que la safe-area change la hauteur, et l'avatar se serait
  // retrouvé dans le fondu sur un appareil à encoche et pas sur un autre.
  const fonduBanniere = fonduDoux(ZONE_OPAQUE, QUEUE_FONDU);

  // `overflow: hidden` : la boîte d'ombre de l'avatar dépasse de 12 px à gauche (rail de 12
  // moins marge de 24), et un dépassement horizontal fait défiler la page entière de côté.
  // L'ombre est coupée au bord de l'écran, où elle n'était de toute façon pas visible.
  return (
    <header
      style={{
        position: "relative",
        display: "grid",
        overflow: "hidden",
        // La teinte de la personne regardée, et rien sur son propre profil : c'est ce qui
        // fait qu'une bannière absente prend *sa* couleur plutôt que l'accent de l'app.
        ...(cle ? variablesTeinte(cle) : {}),
      }}
    >
      {/* La bannière est décorative : le nom et l'identifiant, juste dessous, disent qui
          on regarde. Une description alternative n'ajouterait rien et se lirait à chaque
          visite.

          Elle ne se rend qu'à demi (`.tacita-banniere`) : c'est un fond, et un fond qui
          lutte avec ce qu'il porte n'est plus un fond. La valeur vit dans tokens.css avec
          son pourquoi — et surtout **pas ici** : `opacity` est validée comme un nombre par
          le CSSOM, donc un `style` inline la réduirait à `NaN` sans rien dire. */}
      <div
        aria-hidden
        className="tacita-banniere"
        style={{
          height: HAUTEUR_BANNIERE,
          background: banniere
            ? `url(${JSON.stringify(banniere)}) center / cover no-repeat`
            : "var(--tacita-teinte-voile, var(--color-accent-muted))",
          maskImage: fonduBanniere,
          WebkitMaskImage: fonduBanniere,
        }}
      />

      {/* Le bandeau flotte : `position: absolute`, donc hors du flux — il se pose sur la
          bannière au lieu de la repousser. **Il n'a plus de fond** : une barre de verre
          pleine largeur voilait la bannière sur toute sa hauteur utile, alors que le
          bandeau est précisément ce qui doit la laisser voir. Le verre se resserre sur le
          seul retour (10/08/2026, cf. DESIGN.md §4). */}
      <div
        style={{
          position: "absolute",
          insetInline: 0,
          top: 0,
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--spacing-2)",
          padding: RAIL,
          paddingTop: `calc(${RAIL} + env(safe-area-inset-top, 0px))`,
        }}
      >
        {/* L'exception « glass » de DESIGN.md, réduite à sa portion nécessaire : le retour
            est le seul élément qui doive rester lisible quelle que soit la photo derrière,
            parce qu'il est le seul dont on ne peut pas se passer.

            Le verre, le disque et le survol vivent dans `.tacita-retour` (tokens.css) et
            non dans un `style` inline : un style inline gagne sur `:hover`, donc il
            **interdit** tout état de survol. C'est la seule raison — pas une préférence de
            rangement. */}
        {retour ? (
        <Button
          label="Retour"
          variant="ghost"
          isIconOnly
          // `lg`, soit 36 px : le haut de l'échelle d'Astryx, et désormais le plancher
          // tactile du produit. Une contrainte à 44 px faisait de celui-ci le seul bouton
          // hors barème, pour une pastille de verre deux fois plus large que son chevron.
          size="lg"
          className="tacita-retour"
          icon={IconeRetour}
          onClick={() => router.back()}
        />
        ) : (
          // La place du retour reste tenue : sans elle, le badge et les actions
          // remonteraient à gauche sous l'encoche. Un `span` vide, pas un `div` — il n'y a
          // rien à annoncer.
          <span />
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-2)",
          }}
        >
          {statut && (
            <span
              role="img"
              aria-label={STATUT[statut].libelle}
              title={STATUT[statut].libelle}
              // DESIGN.md : encre sur `accent-soft`, et le bloqué en `error` — c'est le
              // seul des trois statuts qui doive se remarquer sans être lu. Le disque
              // reprend la taille du bouton voisin : deux pastilles de même rang.
              style={{
                display: "grid",
                placeItems: "center",
                width: "var(--size-element-lg)",
                height: "var(--size-element-lg)",
                borderRadius: "var(--radius-full)",
                background:
                  statut === "bloque"
                    ? "var(--color-error-muted)"
                    : "var(--color-accent-muted)",
                color: "var(--color-text-primary)",
              }}
            >
              {STATUT[statut].icone}
            </span>
          )}
          {actions}
        </div>
      </div>

      {/* L'avatar est **dans** la bannière : `top` le colle sous le bandeau, et son bas
          tombe pile sur `ZONE_OPAQUE`, là où l'image commence à s'éteindre. Aucun pixel
          d'avatar en dehors de la partie pleine — c'est une conséquence de l'arithmétique
          des constantes, pas d'un réglage à l'œil qu'il faudrait refaire à chaque écran. */}
      <div
        style={{
          position: "absolute",
          // La marge d'ombre est retirée des deux côtés : l'avatar *visible* reste à
          // `BANDEAU` et sur `RAIL`, la boîte est seulement plus grande autour de lui.
          top: `calc(${BANDEAU} - ${MARGE_OMBRE}px)`,
          insetInlineStart: `calc(${RAIL} - ${MARGE_OMBRE}px)`,
          padding: MARGE_OMBRE,
          // `fit-content` : sans lui la boîte occupe toute la largeur et le masque
          // s'applique à du vide. Ici le masque épouse l'avatar et sa marge d'ombre.
          width: "fit-content",
          maskImage: fonduAvatar,
          WebkitMaskImage: fonduAvatar,
        }}
      >
        {/* L'ombre est portée par cette boîte-ci et pas par le parent : le parent est
            élargi par la marge, une ombre dessus tracerait un carré de 176 px autour du
            vide. Le rayon reprend le token d'avatar (25 %), donc l'ombre suit exactement
            la forme du carré arrondi — un rayon recopié dériverait au premier changement.
            `flex` évite l'espace de descendante qu'un enfant en ligne ajouterait sous la
            boîte, ce qui décalerait l'ombre du bas de quelques pixels. */}
        <div
          style={{
            display: "flex",
            borderRadius: "var(--tacita-radius-avatar)",
            boxShadow: "var(--tacita-ombre-avatar)",
            padding: "var(--spacing-3)",
          }}
        >
          <ConversationAvatar
            nom={nom}
            mxc={avatarUrl}
            direct
            taille={TAILLE_AVATAR}
            cle={cle}
          />
        </div>
      </div>

      <div
        style={{
          display: "grid",
          justifyItems: "start",
          // 8 px entre le nom et l'identifiant — le seul écart serré du bloc, parce que
          // c'est la seule paire qui désigne une même chose.
          gap: "var(--spacing-2)",
          // 24 px sous la bannière, **en plus** des 72 px où l'image s'éteint : le fondu
          // sépare, il ne dégage pas. Le nom se posait sur la ligne exacte où la bannière
          // atteint zéro, ce qui est mathématiquement propre et visuellement collé.
          paddingTop: "var(--spacing-6)",
          /*
           * 32 px à gauche, et non le rail de 12.
           *
           * Le repère n'est pas le bord de l'écran mais **le texte des cartes de réglages
           * qui suivent** : une `Card` d'Astryx porte 16 px de padding par défaut, donc
           * leur libellé commence à 12 + 16 = 28 px. À 12 px le nom se retrouvait à gauche
           * de tout ce que l'écran écrit ensuite, ce qui le faisait lire comme une marge
           * ratée plutôt que comme un décrochement. À 32 il est franchement à droite des
           * deux, et le décalage se lit comme voulu.
           */
          paddingInlineStart: "var(--spacing-8)",
          paddingInlineEnd: RAIL,
        }}
      >
        {/* nom et identifiant **juxtaposés avec des styles distincts** :
            l'un est choisi et change, l'autre est l'adresse et ne change jamais. Les
            rendre semblables laisserait croire qu'on peut éditer les deux. */}
        {/* `display-2` porte le pas `display-large` de DESIGN.md — 28/32/600, un cran
            au-dessus des titres d'écran. Ce n'est pas un titre : c'est le sujet de la
            page, et la seule chose de l'écran qui doive se lire avant tout le reste. */}
        <Text type="display-2" weight="bold">
          {nom}
        </Text>
        {/* l'identifiant, sans le domaine : il est le même pour tout le
            monde (fédération désactivée) et n'apprend rien à personne. */}
        {userId && (
          /* Sélectionnable : c'est ce qu'on recopie pour transmettre quelqu'un à
             quelqu'un d'autre. Le reste de l'interface ne l'est pas (`tokens.css`). */
          <Text type="supporting" color="secondary" className="tacita-selectionnable">
            {identifiantCourt(userId)}
          </Text>
        )}
      </div>
    </header>
  );
}
