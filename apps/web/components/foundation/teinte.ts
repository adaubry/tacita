import type { CSSProperties } from "react";

import type { Couple } from "./palette";

/**
 * **La teinte d'un salon ou d'une personne.** DESIGN.md § Colors, amendement du
 * La règle « une seule couleur » devient « la teinte dit *où tu es*, l'accent
 * dit *ce que tu fais* ». L'accent garde l'envoi, l'onglet actif, les coches et les liens ;
 * la teinte prend l'avatar, le nom de l'interlocuteur, le filet d'en-tête et vos bulles.
 *
 * **Pourquoi OKLCH et pas une liste de couleurs choisies à la main.** Les teintes sont
 * dérivées en faisant tourner **la seule teinte angulaire**, à clarté et chroma figés. Les
 * neuf couleurs ont donc le même poids perçu, et surtout leur contraste est bon *par
 * construction* — il n'y a aucune matrice à vérifier à la main, et aucune des pannes
 * classiques (« le violet est trop sombre », « le jaune est illisible ») ne peut se
 * produire. Mesuré : ≥ 7,4:1 en clair et ≥ 8,6:1 en sombre sur tous les pas de la roue,
 * là où DESIGN.md exige 4,5. `teinte.test.ts` garde la propriété sans navigateur.
 *
 * **Converti en hexadécimal ici, pas laissé en `oklch()` au navigateur.** La conversion
 * était de toute façon nécessaire au test de contraste, qui raisonne en canaux sRGB :
 * l'écrire une fois dans le module plutôt qu'une seconde fois dans le test évite deux
 * implémentations qui divergeraient. En prime, la palette, `light-dark()` et le test de
 * contraste existants continuent de marcher sans rien savoir d'OKLCH.
 */

/** sRGB → linéaire, et retour. Les deux courbes de la spécification sRGB, rien de plus. */
const gamma = (canal: number) =>
  canal <= 0.0031308 ? 12.92 * canal : 1.055 * canal ** (1 / 2.4) - 0.055;

/**
 * OKLCH → hexadécimal sRGB, avec écrêtage dans le gamut.
 *
 * Les deux matrices sont celles d'OKLab (Björn Ottosson). L'écrêtage est une sécurité :
 * aux clartés et chromas d'ici, aucun pas de la roue ne sort du gamut sRGB — le chroma
 * maximal atteignable est de l'ordre de 0,11 à L 0,42, et nous sommes à 0,09.
 */
export function oklchVersHex(L: number, C: number, H: number, alpha?: number): string {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const lCube = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (L - 0.0894841775 * a - 1.29148555 * b) ** 3;
  const canaux = [
    4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  ];
  const octets = canaux.map((canal) =>
    Math.round(255 * Math.min(1, Math.max(0, gamma(canal)))),
  );
  if (alpha !== undefined) octets.push(Math.round(255 * alpha));
  return `#${octets.map((octet) => octet.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * **La roue, à douze pas, moins les trois voisins de l'accent.**
 *
 * Douze pas et non trois cent soixante : deux salons voisins dans la liste doivent être
 * *distinguables*, pas uniques. Une teinte par salon exact donnerait des paires que l'œil
 * ne sépare pas, et la couleur ne dirait plus rien.
 *
 * 150, 180 et 210 sont retirés parce qu'ils tombent à moins de 45° de l'accent — mesuré,
 * pas supposé : `#155E4D` est à **H 173,3** et `#4FBD96` à **H 166,8**. Sans ce retrait,
 * un `roomId` malchanceux produirait un salon exactement de la couleur des actions, et
 * les deux rôles que cet amendement sépare se reconfondraient sur cet écran-là.
 */
export const TEINTES: readonly number[] = [0, 30, 60, 90, 120, 240, 270, 300, 330];

/** Clarté et chroma, figés. Seule la teinte angulaire tourne — c'est tout le mécanisme. */
const CLAIR = { L: 0.42, C: 0.09, voile: 0.1 } as const;
const SOMBRE = { L: 0.8, C: 0.1, voile: 0.22 } as const;

export interface Teinte {
  /** L'encre : nom de l'interlocuteur, initiales, filet d'en-tête. */
  encre: Couple;
  /** Le voile : fond d'avatar, de badge, et de vos bulles. */
  voile: Couple;
}

/**
 * Hachage FNV-1a 32 bits. Il faut une fonction **stable entre appareils** : la teinte est
 * dérivée d'un identifiant, jamais stockée ni synchronisée, et le même salon doit avoir la
 * même couleur sur le téléphone et sur le portable. `String.prototype.hashCode` n'existe
 * pas en JavaScript, et `Math.random` ou l'ordre d'arrivée ne tiendraient pas cette
 * promesse.
 */
function hachage(cle: string): number {
  let valeur = 0x811c9dc5;
  for (let rang = 0; rang < cle.length; rang += 1) {
    valeur ^= cle.charCodeAt(rang);
    valeur = Math.imul(valeur, 0x01000193);
  }
  return valeur >>> 0;
}

/**
 * La teinte d'une clé. **Un salon passe son `roomId`, une personne son identifiant
 * Matrix** — et c'est la raison d'être du paramètre plutôt que d'un `Conversation` :
 * dans la liste d'amis, les demandes reçues et le profil d'autrui, **il n'existe pas
 * encore de salon**. Avec l'identifiant de la personne, Camille a la même teinte avant et
 * après la première conversation ; avec le `roomId`, elle en changerait le jour où on lui
 * écrit.
 */
export function teinte(cle: string): Teinte {
  const H = TEINTES[hachage(cle) % TEINTES.length]!;
  return {
    encre: {
      clair: oklchVersHex(CLAIR.L, CLAIR.C, H),
      sombre: oklchVersHex(SOMBRE.L, SOMBRE.C, H),
    },
    voile: {
      clair: oklchVersHex(CLAIR.L, CLAIR.C, H, CLAIR.voile),
      sombre: oklchVersHex(SOMBRE.L, SOMBRE.C, H, SOMBRE.voile),
    },
  };
}

/**
 * La clé d'une conversation : **le correspondant en DM, le salon en groupe.**
 *
 * C'est la même règle que celle de l'avatar — en DM, on représente l'autre, pas le salon —
 * et elle vaut d'être écrite une fois : sans elle, Camille aurait une couleur dans la
 * liste des conversations (`roomId`) et une autre dans la liste d'amis (`userId`), alors
 * que c'est la même personne. Le modèle la porte déjà, `Conversation.peerId`.
 *
 * Le paramètre est structurel plutôt qu'un `Conversation` : cette couche ne connaît pas
 * le domaine, et n'a aucune raison de commencer.
 */
export const cleTeinte = (salon: { peerId?: string; roomId: string }): string =>
  salon.peerId ?? salon.roomId;

/**
 * Les deux variables, prêtes à poser sur **l'élément qui porte la teinte** — la racine de
 * l'écran de conversation, la ligne d'une liste, la carte d'une demande. Tout ce qui est
 * dessous lit `var(--tacita-teinte-encre)` et `var(--tacita-teinte-voile)` sans rien savoir
 * de la dérivation.
 *
 * Les valeurs sont posées **résolues**, en `light-dark()`, et non sous la forme d'une
 * référence à une variable de teinte angulaire. C'est obligatoire et ce n'est pas un
 * détail : la valeur calculée d'une propriété personnalisée substitue ses `var()` sur
 * l'élément où elle est *déclarée*. Une règle `--encre: oklch(... var(--h))` posée une fois
 * en haut serait donc figée avec le `--h` de la racine, et une ligne de liste qui
 * redéfinirait seulement `--h` hériterait quand même de la couleur de la racine — en
 * silence, et sans que rien à l'écran ne le dise.
 */
export function variablesTeinte(cle: string): CSSProperties {
  const { encre, voile } = teinte(cle);
  return {
    "--tacita-teinte-encre": `light-dark(${encre.clair}, ${encre.sombre})`,
    "--tacita-teinte-voile": `light-dark(${voile.clair}, ${voile.sombre})`,
  } as CSSProperties;
}
