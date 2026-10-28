import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { MODE_DEFAUT } from "../app/providers";
import { PALETTE as COULEURS_DESIGN } from "../components/foundation/palette";
import { FAMILLES_CHROMATIQUES, tacitaTheme } from "../components/foundation/theme";
import { ecrireTheme, lireTheme } from "../lib/preferences";
import { lire, sourcesLivrees, sansCommentaires } from "./sources";

const tokens = tacitaTheme.tokens as Record<string, string>;
/** `defineTheme` résout un couple clair/sombre en une valeur `light-dark()`. */
const couple = ({ clair, sombre }: { clair: string; sombre: string }) => `light-dark(${clair}, ${sombre})`;

describe("le thème porte les valeurs de DESIGN.md, et rien d'autre", () => {
  const { bg, surface, surfaceRaised, hairline, text, textMuted, accent, accentSoft, danger, warning } =
    COULEURS_DESIGN;

  it("chaque token mappé porte la valeur de la table de M-A", () => {
    expect(tokens["--color-background-body"]).toBe(couple(bg));
    expect(tokens["--color-background-surface"]).toBe(couple(surface));
    expect(tokens["--color-background-popover"]).toBe(couple(surfaceRaised));
    expect(tokens["--color-border"]).toBe(couple(hairline));
    expect(tokens["--color-text-primary"]).toBe(couple(text));
    expect(tokens["--color-text-secondary"]).toBe(couple(textMuted));
    expect(tokens["--color-accent"]).toBe(couple(accent));
    expect(tokens["--color-accent-muted"]).toBe(couple(accentSoft));
    expect(tokens["--color-error"]).toBe(couple(danger));
    expect(tokens["--color-warning"]).toBe(couple(warning));
  });

  it("`success` est l'accent : DESIGN.md refuse un second vert", () => {
    expect(tokens["--color-success"]).toBe(tokens["--color-accent"]);
    expect(tokens["--color-success-muted"]).toBe(tokens["--color-accent-muted"]);
  });

  it("`disabled` réutilise le muet plutôt qu'un gris de plus", () => {
    expect(tokens["--color-text-disabled"]).toBe(couple(textMuted));
    expect(tokens["--color-icon-disabled"]).toBe(couple(textMuted));
  });

  /**
   * Le défaut d'Astryx suppose un jaune vif et met du texte sombre dessus. Notre ambre
   * est sombre en clair : sans inversion, le texte d'avertissement est illisible —
   * précisément là où on documente une limite connue (interdit n°13).
   */
  it("le texte sur avertissement est inversé par rapport au défaut d'Astryx", () => {
    expect(tokens["--color-on-warning"]).toBe(couple(COULEURS_DESIGN.surWarning));
  });

  /**
   * Le test que le PM a demandé nommément : un contrôle qui ne vérifierait que l'accent
   * laisserait passer les quarante autres, et le bleu sortirait écran par écran.
   */
  it("les quarante tokens chromatiques sont posés sur les neutres", () => {
    expect(FAMILLES_CHROMATIQUES).toHaveLength(10);
    for (const famille of FAMILLES_CHROMATIQUES) {
      /*
       * **`gray` fait exception, et seulement sur le fond** (30/08/2026, plainte : « le
       * bouton mode masqué de confidentialité ne se rend pas en light »).
       *
       * La neutralisation posait les dix fonds sur `surface`. Or `Switch` d'Astryx lit
       * `--color-background-gray` pour sa **piste éteinte** : celle-ci était donc peinte
       * en blanc, sur une feuille elle-même blanche, avec un curseur blanc dessus. Le
       * contrôle existait et ne se voyait pas.
       *
       * `gray` n'est pas une famille chromatique comme les neuf autres : c'est le neutre
       * de la bibliothèque. Il rejoint `--color-track` sur le filet, qui est le neutre du
       * nôtre. L'intention du garde ne bouge pas — aucune couleur d'Astryx n'entre.
       */
      expect(tokens[`--color-background-${famille}`], famille).toBe(
        couple(famille === "gray" ? hairline : surface),
      );
      expect(tokens[`--color-border-${famille}`], famille).toBe(couple(hairline));
      expect(tokens[`--color-icon-${famille}`], famille).toBe(couple(textMuted));
      expect(tokens[`--color-text-${famille}`], famille).toBe(couple(textMuted));
    }
  });

  it("aucune couleur hors palette ne subsiste dans les anneaux inset", () => {
    // Quatre ombres d'Astryx portent des couleurs en dur, dont un bleu : même piège que
    // les familles chromatiques, et il ne se voit qu'au focus ou à la sélection.
    for (const nom of ["hover", "selected", "success", "warning", "error"]) {
      expect(tokens[`--shadow-inset-${nom}`], nom).toMatch(/var\(--color-/);
    }
  });

  it("la géométrie suit DESIGN.md — et `--radius-chat` n'est plus 28px", () => {
    expect(tokens["--radius-element"]).toBe("6px"); // contrôles
    expect(tokens["--radius-container"]).toBe("10px"); // cartes, modals
    expect(tokens["--radius-chat"]).toBe("12px");
    expect(tokens["--radius-chat"]).not.toBe("28px"); // « coins très arrondis », interdit
  });

  it("deux graisses seulement, et la règle est mécanique", () => {
    // Un composant qui demande `medium` ou `bold` retombe sur 400 et 600 : il ne peut
    // plus sortir de la palette typographique, même en le voulant.
    expect(tokens["--font-weight-medium"]).toBe("400");
    expect(tokens["--font-weight-bold"]).toBe("600");
  });

  /**
   * La table de typographie de DESIGN.md, sur les tokens qu'Astryx rend **réellement**.
   *
   * Les `--font-size-*` seuls ne suffisaient pas : les styles de `Text` lisent une
   * seconde famille (`--text-<style>-*`), dérivée une fois pour toutes de l'échelle par
   * défaut d'Astryx, ancrée sur 14 px. Tout le texte de l'app sortait un cran trop petit,
   * et les titres d'écran en 29 px graisse 400 au lieu de 22/28 en 600. Ce test regarde
   * la famille qui décide.
   */
  it("les styles de texte portent les tailles de la table de DESIGN.md", () => {
    // display 22/28/600 — et la graisse, que le défaut d'Astryx laissait à 400.
    expect(tokens["--text-display-3-size"]).toBe("1.375rem");
    expect(tokens["--text-display-3-weight"]).toBe("var(--font-weight-bold)");
    expect(tokens["--text-heading-3-size"]).toBe("1.0625rem"); // title 17
    expect(tokens["--text-body-size"]).toBe("0.9375rem"); // body 15
    expect(tokens["--text-supporting-size"]).toBe("0.8125rem"); // secondary 13
    expect(tokens["--text-label-size"]).toBe("0.9375rem"); // libellés et boutons
    expect(tokens["--text-code-size"]).toBe("0.9375rem"); // mono, au corps du texte
    // Les interlignes de la table, au pixel : 28/22, 24/17, 20/15, 18/13.
    for (const [style, rapport] of [
      ["display-3", 28 / 22],
      ["heading-3", 24 / 17],
      ["body", 20 / 15],
      ["supporting", 18 / 13],
    ] as const) {
      expect(Number(tokens[`--text-${style}-leading`]), style).toBeCloseTo(rapport, 3);
    }
  });

  /**
   * DESIGN.md : « contraste AA vérifié pour chaque paire ». Le texte posé **sur** une
   * couleur pleine est le seul endroit où la palette peut se contredire sans que rien ne
   * le montre — et c'est ce qui était arrivé : blanc sur l'accent sombre (#4FBD96, un vert
   * pâle) tombait à 2,3:1, sur tous les boutons primaires du thème sombre.
   */
  it("le texte posé sur une couleur pleine tient le seuil AA, dans les deux modes", () => {
    const luminance = (hexa: string) => {
      const canal = (i: number) => Number.parseInt(hexa.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      const [r, v, b] = [0, 1, 2].map((i) => {
        const c = canal(i);
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * v + 0.0722 * b;
    };
    const contraste = (a: string, b: string) => {
      const [clair, sombre] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
      return (clair + 0.05) / (sombre + 0.05);
    };

    for (const mode of ["clair", "sombre"] as const) {
      for (const [texte, fond] of [
        ["surAccent", "accent"],
        ["surWarning", "warning"],
      ] as const) {
        const ratio = contraste(COULEURS_DESIGN[texte][mode], COULEURS_DESIGN[fond][mode]);
        expect(ratio, `${texte} sur ${fond} en ${mode}`).toBeGreaterThanOrEqual(4.5);
      }
    }

    /*
     * Le couple du visionneur (DESIGN.md § Colors, `viewer` / `on-viewer`) ne vient pas de
     * la palette : il est **figé** dans la feuille de tokens, parce qu'il ne suit pas le
     * thème — une photo se regarde sur un fond sombre dans les deux modes.
     *
     * C'est la paire qui manquait, et qui était en défaut de la pire façon : le fond
     * valait `--color-background-inverted`, c'est-à-dire exactement `text`, la couleur que
     * les boutons d'Astryx posent dessus. Rapport de contraste **1:1** — les commandes du
     * viewer, « Fermer » comprise, étaient invisibles dans les deux thèmes.
     */
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    const token = (nom: string) => {
      const trouve = feuille.match(new RegExp(`${nom}:\\s*(#[0-9a-f]{6})`));
      expect(trouve, `${nom} absent de tokens.css`).not.toBeNull();
      return trouve![1]!;
    };
    for (const encre of ["--tacita-sur-viewer", "--tacita-sur-viewer-muet"]) {
      const ratio = contraste(token(encre), token("--tacita-viewer"));
      expect(ratio, `${encre} sur --tacita-viewer`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("la pile de polices est celle de DESIGN.md, sans webfont", () => {
    expect(tokens["--font-family-body"]).toMatch(/^system-ui,/);
    expect(tokens["--font-family-code"]).toMatch(/^ui-monospace,/);
    for (const cle of ["--font-family-body", "--font-family-heading", "--font-family-code"]) {
      expect(tokens[cle]).not.toMatch(/url\(|@import/);
    }
  });

  /**
   * DESIGN.md : « aucune valeur hexadécimale dans le code des composants ».
   *
   * Les quatre longueurs, pas seulement six : l'audit impeccable a trouvé
   * un `#000` dans un masque de `ProfileCard`, que la version à `{6}` laissait passer.
   * La forme courte est précisément celle qu'on écrit sans y penser.
   *
   * Commentaires retirés, comme partout ailleurs (`tests/sources.ts`) : « les interdits
   * portent sur ce que le shard exécute, pas sur ce qu'il explique ». Un commentaire qui
   * cite la valeur bannie pour dire de ne pas l'écrire n'est pas une couleur en dur.
   */
  it("aucune couleur en dur hors du fichier de thème", () => {
    for (const { chemin, code } of sourcesLivrees()) {
      if (chemin.endsWith("/palette.ts")) continue;
      expect(sansCommentaires(code).match(/#[0-9a-fA-F]{3,8}\b/g), chemin).toBeNull();
    }
  });

  /**
   * DESIGN.md : « espacement uniquement en multiples de 4 ». Un titre qui porte la marge
   * par défaut du navigateur (`margin-block: 0.67em`, soit ~15 px à 22 px de corps) la
   * **cumule** avec le `gap` de son `VStack` — les marges d'un enfant flex ne fusionnent
   * pas. L'écart écrit dans le composant et l'écart rendu divergeaient donc sur chaque
   * écran à titre, et rien dans le dépôt ne pouvait le dire : jsdom ne rend aucune
   * géométrie, et le défaut vient de la feuille de l'agent utilisateur.
   *
   * Le test lit la feuille plutôt que le rendu, faute de navigateur — c'est ce que le
   * dépôt fait déjà pour les valeurs de configuration. Il ne prouve pas la géométrie ;
   * il empêche la ligne qui la tient de disparaître sans que personne ne le voie.
   */
  /**
   * **Aucune variable CSS inventée.**
   *
   * Une `var(--nom)` qui ne désigne rien ne produit ni erreur, ni avertissement, ni
   * repli : la déclaration entière devient invalide et disparaît. Un fond devient
   * transparent, une couleur d'erreur cesse d'être rouge, et **rien ne le dit** — ni la
   * console du navigateur, ni jsdom, qui ne calcule aucune couleur. C'est le mode de
   * panne le plus silencieux de toute la feuille de style.
   *
   * Trouvé par trois fois en une session : le fond de la barre d'enregistrement vocal
   * laissait voir le champ d'écriture au travers (`--color-background`, qui n'existe pas
   * — c'est `--color-background-body`), et trois messages d'erreur n'étaient pas rouges
   * (`--color-danger` au lieu de `--color-error`). Aucun des trois n'était visible
   * autrement qu'à l'œil, sur le bon écran, au bon moment.
   *
   * Le vocabulaire admis est la réunion de trois sources, et pas une liste à tenir à la
   * main : ce qu'Astryx déclare dans sa feuille, ce que notre thème pose, et ce que nos
   * propres fichiers écrivent — `tokens.css` en `:root`, et les styles qui posent une
   * variable sur un élément (`"--tacita-teinte-encre": …`, les crochets d'avatar).
   *
   * Une `var(--x, repli)` est hors de portée : elle **a** un repli, donc elle dégrade au
   * lieu de disparaître. Et le motif n'attrape que les noms littéraux : `var(--taille-${n})`
   * se termine par une interpolation, qu'aucune analyse de texte ne peut résoudre.
   */
  it("aucune variable CSS inventée : chaque `var(--x)` sans repli désigne un token qui existe", () => {
    // Par le lien que pnpm pose dans `apps/web/node_modules`, pas par le magasin : le
    // nom du dossier du magasin porte un hachage de résolution propre à la machine, et
    // le chemin écrit en dur ici n'existait pas sur la CI — rouge depuis des mois.
    const feuilleAstryx = lire("node_modules/@astryxdesign/core/dist/astryx.css");
    const declarees = (source: string) =>
      (source.match(/--[a-zA-Z0-9_-]+(?=\s*:)/g) ?? []).map((nom) => nom.trim());

    const connues = new Set([
      ...declarees(feuilleAstryx),
      ...Object.keys(tokens),
      ...declarees(lire("components/foundation/tokens.css")),
      // Ce que le shard pose lui-même sur un élément : `"--x": valeur` dans un style.
      ...sourcesLivrees().flatMap(({ code }) =>
        [...code.matchAll(/"(--[a-zA-Z0-9_-]+)"\s*:/g)].map((trouve) => trouve[1]!),
      ),
    ]);

    const inventees = new Set<string>();
    for (const { chemin, code } of sourcesLivrees()) {
      for (const [, nom, suite] of sansCommentaires(code).matchAll(
        /var\(\s*(--[a-zA-Z0-9_-]+)\s*([,)])/g,
      )) {
        if (suite === ",") continue;
        if (!connues.has(nom!)) inventees.add(`${nom} (${chemin.split("/web/")[1]})`);
      }
    }

    expect([...inventees]).toEqual([]);
  });

  /**
   * **L'interface ne se sélectionne pas, le contenu si.**
   *
   * Signalé sur iPhone : un appui long sur le séparateur de date le surlignait en bleu.
   * La date n'était pas seule — l'heure sous les bulles, le nom de l'auteur, les titres
   * d'en-tête et le compteur de membres étaient dans le même cas, parce que c'est le
   * défaut du web et qu'il n'avait jamais été renversé.
   *
   * Le test lit la feuille, faute de navigateur : jsdom ne calcule aucune sélection. Il
   * ne prouve donc pas le comportement ; il empêche les deux moitiés de la règle de
   * disparaître séparément — et c'est la seconde qui compte, puisque la perdre rendrait
   * un composer dans lequel on ne peut plus replacer son curseur.
   */
  it("la sélection est refusée par défaut, et rendue au contenu", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));

    const corps = feuille.match(/\bbody\s*{([^}]*)}/);
    expect(corps?.[1], "aucune règle sur `body`").toMatch(/user-select:\s*none/);

    const rendue = feuille.match(/([^}]*)\{[^}]*user-select:\s*text/);
    expect(rendue?.[1], "la sélection n'est rendue à personne").toBeDefined();
    for (const quoi of ["input", "textarea", "contenteditable", "tacita-selectionnable"]) {
      expect(rendue?.[1], quoi).toContain(quoi);
    }
  });

  /**
   * L'autre moitié : la classe doit être **posée** quelque part, sinon la règle ci-dessus
   * est vraie et sans effet — le texte des messages resterait insélectionnable, ce qui
   * est exactement l'inverse de la demande.
   */
  it("le corps d'un message porte la classe qui lui rend la sélection", () => {
    expect(sansCommentaires(lire("components/conversation/TexteMessage.tsx"))).toContain(
      "tacita-selectionnable",
    );
  });

  it("les marges d'agent utilisateur des titres sont neutralisées", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    const regle = feuille.match(/:where\(([^)]*h1[^)]*)\)\s*{([^}]*)}/);

    expect(regle, "aucune règle ne remet les marges de titre à zéro").not.toBeNull();
    expect(regle?.[2]).toMatch(/margin-block:\s*0/);
    // Les six niveaux et le paragraphe : le titre du prochain écran ne doit pas naître
    // décalé parce qu'il est en `h2`.
    for (const balise of ["h1", "h2", "h3", "h4", "h5", "h6", "p"]) {
      expect(regle?.[1], balise).toContain(balise);
    }
  });

  /**
   * DESIGN.md § Components : la bannière du profil ne se rend qu'à 50 %, **depuis une
   * feuille**. La contrainte n'est pas cosmétique : `opacity` est validée comme un nombre
   * par le CSSOM, donc `element.style.opacity = "var(--x)"` ne stocke pas la référence,
   * il stocke `NaN` — la couche reste à pleine force, et rien ne le signale. Écrit une
   * première fois de bonne foi, sans effet.
   *
   * Le test lit la feuille et la source, faute de navigateur — comme les deux au-dessus.
   * Il ne prouve pas le rendu ; il empêche la règle de repartir en `style` inline, où
   * elle ne ferait à nouveau rien.
   */
  it("l'opacité de la bannière vient d'une feuille, jamais d'un style inline", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    // La **présence** de la règle, pas sa valeur : DESIGN.md dit à quoi elle sert, la
    // feuille dit combien. Verrouiller le nombre ici ferait échouer le test au premier
    // ajustement de dessin légitime, et remettrait la valeur à deux endroits.
    expect(feuille).toMatch(/\.tacita-banniere\s*{[^}]*opacity:\s*[\d.]+/);

    const carte = sansCommentaires(lire("components/profil/ProfileCard.tsx"));
    expect(carte).toContain('className="tacita-banniere"');
    // La forme qui ne marche pas, dans le fichier qui a la classe : `opacity` n'a rien à
    // faire dans un objet `style` ici, avec ou sans `var()`.
    expect(carte).not.toMatch(/opacity:/);
  });

  /*
   * **Règle 7, appliquée au dégagement de l'appel entrant** (30/08/2026, revue R-07).
   *
   * La bannière est `position: fixed` en haut de la fenêtre, et elle se posait exactement
   * sur la bande qu'occupe la `Toolbar` : pendant qu'elle sonnait, le retour, le titre et
   * les trois actions de la conversation étaient inatteignables. Le dégagement vit
   * désormais dans un token — donc à une jonction que personne ne relit, et c'est
   * précisément ce que la règle 7 refuse de laisser sans test.
   *
   * Le test relie la valeur à son site de lecture. Il ne prouve pas le rendu — jsdom ne
   * calcule aucune géométrie, et les 52 px ont été mesurés à la main. Il empêche que le
   * token disparaisse, ou que la bannière cesse de le lire, sans que personne ne le voie.
   */
  /*
   * Règle 7 encore : deux feuilles écrites pour des plaintes utilisateur, et
   * deux sélecteurs qui n'existent que si quelqu'un les pose. Une règle CSS dont la classe
   * a disparu du composant est indétectable — elle ne casse rien, elle cesse simplement
   * d'agir.
   */
  it("les correctifs de jetons de recherche ont leur classe sur le composant", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    expect(feuille).toMatch(/\.tacita-recherche \[role="group"\]/);

    const barre = sansCommentaires(lire("components/recherche/SearchBar.tsx"));
    expect(barre).toContain('className="tacita-recherche"');
  });

  it("le lissage des skeletons a sa classe sur le composant", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    expect(feuille).toMatch(/\.tacita-skeleton\s*\{[^}]*animation-timing-function/);

    const enrobage = sansCommentaires(lire("components/foundation/Skeleton.tsx"));
    expect(enrobage).toContain("tacita-skeleton");
  });

  /*
   * Le défaut de l'agent utilisateur, `body { margin: 8px }`, insérait toute
   * l'application de 8 px et laissait voir le blanc du navigateur sur les quatre bords.
   * jsdom ne peint rien : sans ce test, la ligne peut repartir sans que rien ne le dise.
   */
  it("le fond de l'application touche les quatre bords", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    expect(feuille).toMatch(/body\s*\{[^}]*margin:\s*0/);
  });

  it("la bannière d'appel entrant se pose sous la barre d'en-tête, jamais dessus", () => {
    const feuille = sansCommentaires(lire("components/foundation/tokens.css"));
    expect(feuille).toMatch(/--tacita-decalage-appel:\s*\d+px/);

    const banniere = sansCommentaires(lire("components/appels/AppelEntrant.tsx"));
    expect(banniere).toContain("var(--tacita-decalage-appel)");
    // La forme qui ne marche pas : un `top` qui repart de zéro remettrait la bannière
    // sur l'en-tête, et rien à l'écran ne le dirait avant le premier appel reçu.
    expect(banniere).not.toMatch(/top:\s*"calc\(var\(--spacing-2\)/);
  });
});

describe("le choix de thème est persisté en IndexedDB", () => {
  it("le défaut est le clair, thème de référence de DESIGN.md", () => {
    expect(MODE_DEFAUT).toBe("light");
  });

  it("un choix écrit se relit à la session suivante", async () => {
    const indexedDB = new IDBFactory();
    expect(await lireTheme(indexedDB)).toBeUndefined();

    await ecrireTheme(indexedDB, "dark");
    expect(await lireTheme(indexedDB)).toBe("dark");

    await ecrireTheme(indexedDB, "system");
    expect(await lireTheme(indexedDB)).toBe("system");
  });

  it("une valeur inattendue en base ne casse pas l'app, elle est ignorée", async () => {
    const indexedDB = new IDBFactory();
    await ecrireTheme(indexedDB, "dark");
    // Ce que laisserait une version future ou une base bricolée à la main.
    const base = await new Promise<IDBDatabase>((resolve) => {
      const requete = indexedDB.open("tacita-ui", 1);
      requete.onsuccess = () => resolve(requete.result);
    });
    const transaction = base.transaction("preferences", "readwrite");
    transaction.objectStore("preferences").put("néon", "theme");
    await new Promise((resolve) => {
      transaction.oncomplete = resolve;
    });
    base.close();

    expect(await lireTheme(indexedDB)).toBeUndefined();
  });

  it("le stockage est IndexedDB, jamais localStorage (interdit n°2)", () => {
    // Commentaires retirés : le module de persistance cite l'interdit qu'il respecte.
    for (const { chemin, code } of sourcesLivrees()) {
      expect(sansCommentaires(code), chemin).not.toMatch(/localStorage|sessionStorage/);
    }
  });
});
