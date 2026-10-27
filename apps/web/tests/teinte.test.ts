import { describe, expect, it } from "vitest";

import { PALETTE } from "../components/foundation/palette";
import { TEINTES, oklchVersHex, teinte, variablesTeinte } from "../components/foundation/teinte";

/**
 * **Le garde-fou de l'amendement « une teinte par salon ».**
 *
 * Il tient ce que la dérivation promet : neuf couleurs de même poids, toutes lisibles dans
 * les deux thèmes, et aucune assez proche de l'accent pour qu'on confonde *où l'on est*
 * avec *ce que l'on fait*. jsdom ne calcule aucune couleur — sans ce fichier, un réglage
 * de clarté ou de chroma pourrait faire passer les neuf sous le seuil AA sans que rien ne
 * le dise, écran par écran et seulement chez les utilisateurs.
 */

const canaux = (hexa: string) =>
  [0, 1, 2].map((rang) => Number.parseInt(hexa.slice(1 + rang * 2, 3 + rang * 2), 16) / 255);

const lineaire = (canal: number) =>
  canal <= 0.04045 ? canal / 12.92 : ((canal + 0.055) / 1.055) ** 2.4;

const luminance = (hexa: string) => {
  const [r, v, b] = canaux(hexa).map(lineaire) as [number, number, number];
  return 0.2126 * r + 0.7152 * v + 0.0722 * b;
};

const contraste = (a: string, b: string) => {
  const [clair, sombre] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (clair + 0.05) / (sombre + 0.05);
};

/** Un voile n'est pas une couleur : c'est une couleur *par-dessus une autre*. */
const composer = (dessus: string, dessous: string) => {
  const alpha = Number.parseInt(dessus.slice(7, 9), 16) / 255;
  const [haut, bas] = [canaux(dessus), canaux(dessous)];
  const melange = haut.map((canal, rang) => canal * alpha + bas[rang]! * (1 - alpha));
  return `#${melange.map((canal) => Math.round(canal * 255).toString(16).padStart(2, "0")).join("")}`;
};

/** sRGB → OKLab, l'inverse de ce que fait le module : il sert à *situer* l'accent. */
const teinteAngulaire = (hexa: string) => {
  const [r, v, b] = canaux(hexa).map(lineaire) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * v + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * v + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * v + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bOk = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return ((Math.atan2(bOk, a) * 180) / Math.PI + 360) % 360;
};

/** L'écart angulaire le plus court sur la roue : 350° et 10° sont à 20° l'un de l'autre. */
const ecart = (a: number, b: number) => {
  const brut = Math.abs(a - b) % 360;
  return brut > 180 ? 360 - brut : brut;
};

const CLES = [
  "!gwGdxZBuGBaZdYfRFq:spleen.blog",
  "!abcdefghijklmn:spleen.blog",
  "@camille:spleen.blog",
  "@mehdi:spleen.blog",
  "@lea:spleen.blog",
  "@hugo:spleen.blog",
  "!atelier-du-jeudi:spleen.blog",
];

describe("la teinte d'un salon ou d'une personne", () => {
  it("se tient à l'écart de l'accent, dans les deux thèmes", () => {
    // Mesuré et non supposé : #155E4D est à 173,3° et #4FBD96 à 166,8°.
    const accents = [PALETTE.accent.clair, PALETTE.accent.sombre].map(teinteAngulaire);
    expect(TEINTES).toHaveLength(9);
    for (const H of TEINTES) {
      for (const accent of accents) {
        expect(ecart(H, accent), `teinte ${H}° contre l'accent ${accent.toFixed(1)}°`)
          .toBeGreaterThanOrEqual(45);
      }
    }
  });

  it("donne une encre lisible sur le fond et sur la surface, dans les deux thèmes", () => {
    for (const cle of CLES) {
      const { encre } = teinte(cle);
      for (const mode of ["clair", "sombre"] as const) {
        for (const fond of ["bg", "surface"] as const) {
          const ratio = contraste(encre[mode], PALETTE[fond][mode]);
          expect(ratio, `${cle} : encre sur ${fond} en ${mode}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  /**
   * Le voile porte le texte courant — c'est le fond de vos bulles. Si cette paire casse,
   * ce sont vos propres messages qui deviennent illisibles.
   */
  it("laisse l'encre du thème lisible par-dessus le voile", () => {
    for (const cle of CLES) {
      const { voile } = teinte(cle);
      for (const mode of ["clair", "sombre"] as const) {
        const fond = composer(voile[mode], PALETTE.surface[mode]);
        const ratio = contraste(PALETTE.text[mode], fond);
        expect(ratio, `${cle} : texte sur voile en ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("est stable : la même clé donne toujours la même couleur", () => {
    for (const cle of CLES) expect(teinte(cle)).toStrictEqual(teinte(cle));
  });

  it("ne sort jamais de la roue des neuf", () => {
    const permises = new Set(TEINTES.map((H) => oklchVersHex(0.42, 0.09, H)));
    for (const cle of CLES) expect(permises).toContain(teinte(cle).encre.clair);
  });

  /**
   * Deux salons ne doivent pas se ressembler *parce que la dérivation est mauvaise*. Neuf
   * couleurs pour sept clés : des collisions sont normales, une couleur unique pour tout le
   * monde ne l'est pas.
   */
  it("répartit les clés sur la roue plutôt que de les empiler", () => {
    const vues = new Set(CLES.map((cle) => teinte(cle).encre.clair));
    expect(vues.size).toBeGreaterThanOrEqual(4);
  });

  it("pose les deux variables résolues, jamais une référence à recalculer", () => {
    const variables = variablesTeinte("@camille:spleen.blog") as Record<string, string>;
    expect(variables["--tacita-teinte-encre"]).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/);
    expect(variables["--tacita-teinte-voile"]).toMatch(/^light-dark\(#[0-9a-f]{8}, #[0-9a-f]{8}\)$/);
    expect(variables["--tacita-teinte-encre"]).not.toContain("var(");
  });
});
