"use client";

import type { CSSProperties } from "react";

import { Avatar } from "./primitives";
import { teinte } from "./teinte";
import { useImageMxc } from "./useImageMxc";

interface ConversationAvatarProps {
  /**
   * Le nom **de la conversation**, pas d'un membre : en DM le SDK y met déjà le nom de
   * l'autre utilisateur, en groupe celui du groupe. C'est toute la règle d'avatar.
   */
  nom: string;
  /**
   * Le `mxc://` de la photo, quand on l'a. Absent ou illisible → les initiales, qui sont
   * toujours vraies. C'est la primitive Astryx qui fait ce repli, pas nous.
   */
  mxc?: string;
  /** DM ou groupe. Change ce qui est représenté, pas la forme. */
  direct: boolean;
  /** Paliers de l'échelle d'Astryx, et eux seuls — pas de taille hors barreau. */
  taille?: 24 | 36 | 40 | 48 | 96 | 128;
  /**
   * La clé dont se dérive la teinte : **le `roomId` pour un salon, l'identifiant Matrix
   * pour une personne**. Absente — un avatar qui ne représente ni l'un ni l'autre, comme
   * le vôtre sur votre propre profil — les initiales gardent les neutres d'Astryx : on ne
   * s'attribue pas une couleur d'identité à soi-même, elle ne distinguerait rien.
   */
  cle?: string;
}

/**
 * **Le seul endroit de l'app qui rend un avatar** (DESIGN.md).
 *
 * La règle qu'il encapsule est celle tranchée par le design owner (ESCALATIONS,
 * décisions design) : en DM, l'avatar de conversation est celui de l'autre utilisateur ;
 * en groupe, celui du groupe — distinct des avatars des membres. Une seule ligne de code
 * en dépend, ici, pour qu'aucun écran n'en invente une variante.
 *
 * Forme : carré arrondi à 25 %, jamais un cercle. Astryx lit `--radius-full` pour ses
 * avatars ; on le redéfinit dans cette portée, ce qui reforme la primitive sans la
 * recoder — DESIGN.md interdit de recoder ce qu'Astryx livre.
 *
 * L'image passe par `useImageMxc` et non par `src={mxc}` : un `mxc://` n'est pas une URL
 * que le navigateur sait suivre, et l'endpoint média demande le jeton. C'est
 * ce chaînon qui manquait — jusqu'ici ce composant ne rendait que des initiales, et une
 * photo de profil pouvait être téléversée, posée et relue sans jamais s'afficher.
 *
 * **La teinte passe par les deux crochets d'Astryx** (`--_avatar-fallback-background` et
 * `--_avatar-fallback-color`), exactement comme la forme passe par `--radius-full` juste
 * au-dessus : la primitive est reteintée dans cette portée, pas réécrite. Sans eux il
 * faudrait rivaliser de spécificité avec des classes atomiques régénérées à chaque build.
 * Elle ne touche que les **initiales** — une photo de profil n'a besoin d'aucune couleur
 * derrière elle, et le repli d'Astryx la recouvre de toute façon.
 */
export function ConversationAvatar({
  nom,
  mxc,
  direct,
  taille = 40,
  cle,
}: ConversationAvatarProps) {
  const src = useImageMxc(mxc);
  const couleurs = cle === undefined ? undefined : teinte(cle);

  return (
    <Avatar
      name={nom}
      src={src}
      size={taille}
      tooltip={false}
      alt={direct ? nom : `Groupe ${nom}`}
      style={
        {
          "--radius-full": "var(--tacita-radius-avatar)",
          ...(couleurs && {
            "--_avatar-fallback-background": `light-dark(${couleurs.voile.clair}, ${couleurs.voile.sombre})`,
            "--_avatar-fallback-color": `light-dark(${couleurs.encre.clair}, ${couleurs.encre.sombre})`,
          }),
        } as CSSProperties
      }
    />
  );
}
