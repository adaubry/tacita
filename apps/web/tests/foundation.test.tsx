import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ButtonsList } from "../components/foundation/ButtonsList";
import { ConnectionBanner, ConnectionBannerLive } from "../components/foundation/ConnectionBanner";
import { LayoutHeader } from "../components/foundation/LayoutHeader";
import { Navbar, ONGLETS } from "../components/foundation/Navbar";
import { Placeholder } from "../components/foundation/Placeholder";
import { Sheet } from "../components/foundation/Sheet";
import { SegmentedControl, SegmentedControlItem } from "../components/foundation/primitives";
import { RACINE, lire, sansCommentaires, sourcesLivrees } from "./sources";
import { Skeleton } from "../components/foundation/Skeleton";

/**
 * `next/navigation` n'existe pas hors du rendu de Next. Les deux fonctions dont les
 * composants dépendent sont remplacées ; c'est le comportement du composant qu'on
 * teste, pas le routeur.
 */
const chemin = vi.fn(() => "/");
const retour = vi.fn();
const pousser = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => chemin(),
  useRouter: () => ({ back: retour, push: pousser }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("navbar : quatre onglets, actif surélevé, sans rechargement", () => {
  it("rend les quatre onglets du wireframe, dans l'ordre", () => {
    render(<Navbar />);
    expect(ONGLETS.map((o) => o.libelle)).toEqual(["Accueil", "Recherche", "Mentions", "Profil"]);
    for (const { libelle } of ONGLETS) expect(screen.getByLabelText(libelle)).toBeTruthy();
  });

  it("l'onglet actif porte l'accent et la surélévation, les autres non", () => {
    chemin.mockReturnValue("/recherche");
    render(<Navbar />);

    const actif = screen.getByLabelText("Recherche");
    expect(actif.getAttribute("aria-current")).toBe("page");
    expect(actif.style.transform).toBe("translateY(-1px)");
    expect(actif.style.color).toContain("--color-icon-accent");

    const inactif = screen.getByLabelText("Accueil");
    expect(inactif.getAttribute("aria-current")).toBeNull();
    expect(inactif.style.transform).toBe("");
  });

  it("l'accueil ne s'allume que sur lui-même", () => {
    // `startsWith("/")` allumerait les quatre onglets partout : tout chemin commence
    // par une barre oblique.
    chemin.mockReturnValue("/mentions");
    render(<Navbar />);
    expect(screen.getByLabelText("Accueil").getAttribute("aria-current")).toBeNull();
    expect(screen.getByLabelText("Mentions").getAttribute("aria-current")).toBe("page");
  });

  it("navigue par lien, sans rechargement, avec des cibles de 44 px", () => {
    render(<Navbar />);
    for (const { libelle, href } of ONGLETS) {
      const lien = screen.getByLabelText(libelle);
      // Un `<a href>` rendu par next/link : la navigation est client, pas un POST ni un
      // rechargement complet.
      expect(lien.tagName).toBe("A");
      expect(lien.getAttribute("href")).toBe(href);
      expect(lien.style.minHeight).toBe("44px");
      expect(lien.style.minWidth).toBe("44px");
    }
  });

  it("le libellé est dans la mise en page, pas dans un survol", () => {
    // Il était rendu par un tooltip que seuls le survol et le maintien révélaient. Une
    // information permanente n'a pas besoin d'être révélée — et un libellé visible *est*
    // la cible de 44 px, au lieu d'être posé au-dessus d'elle.
    render(<Navbar />);
    for (const { libelle } of ONGLETS) {
      const lien = screen.getByLabelText(libelle);
      expect(lien.textContent).toContain(libelle);
      // Le tooltip était un `<span aria-hidden>` en position absolue. Il ne reste que les
      // SVG, légitimement masqués — un pictogramme doublé de son libellé bavarderait.
      expect(lien.querySelector("span[aria-hidden]")).toBeNull();
    }
  });

  it("la barre flotte : centrée, décollée du bas, aucun bord touché", () => {
    // Une barre pleine largeur collée en bas est une lisière de l'écran ; un dock est un
    // objet posé dessus.
    const { container } = render(<Navbar />);
    const barre = container.querySelector("nav") as HTMLElement;

    expect(barre.style.marginInline).toBe("auto");
    expect(barre.style.width).toContain("var(--spacing-3)");
    expect(barre.style.bottom).toContain("var(--spacing-3)");
    // Safe-area iOS : sans elle, en PWA installée, le dock retombe sur la barre de gestes.
    expect(barre.style.bottom).toContain("env(safe-area-inset-bottom");
    // DESIGN.md e2 — `surface-raised` + filet + ombre, et jamais d'ombre sans filet.
    expect(barre.style.background).toContain("--color-background-popover");
    expect(barre.style.border).toContain("--color-border");
    expect(barre.style.boxShadow).toContain("--shadow-low");
    expect(barre.style.borderRadius).toBe("var(--radius-full)");
    // Sans lui, le navigateur lit le glissement horizontal comme un défilement et
    // s'empare du pointeur avant le premier `pointermove`.
    expect(barre.style.touchAction).toBe("none");
  });

  it("le layout réserve la hauteur du dock **et** ce qui le décolle", () => {
    // La barre était collée en bas : réserver sa hauteur suffisait. Elle flotte
    // maintenant à 12 px du bord, et le contenu doit dégager les deux.
    const layout = readFileSync(join(RACINE, "app/(onglets)/layout.tsx"), "utf8");
    expect(layout).toContain("calc(60px + var(--spacing-3) * 2 + env(safe-area-inset-bottom, 0px))");
  });

  /**
   * jsdom ne calcule aucune géométrie : `getBoundingClientRect` y renvoie des zéros, et
   * la conversion abscisse → onglet retournerait toujours `null`. On lui donne donc une
   * boîte — 400 px de large à l'origine — pour que la division ait de quoi diviser.
   *
   * Ce que ça ne prouve pas : que la barre *fasse* 400 px, ni où elle est. C'est la
   * conversion et la persistance qu'on assère, pas la mise en page, qui demande un
   * navigateur.
   */
  const barreMesuree = (container: HTMLElement) => {
    const barre = container.querySelector("nav") as HTMLElement;
    barre.getBoundingClientRect = () => ({ left: 0, width: 400 }) as DOMRect;
    return barre;
  };

  /**
   * jsdom n'implémente pas `PointerEvent` : `fireEvent.pointerDown` y retombe sur un
   * `Event` nu, sans `button` ni `clientX`, et le composant s'arrête à son premier garde.
   * Un `MouseEvent` porte les deux et React le livre tel quel au handler du bon type.
   */
  const doigt = (barre: HTMLElement, type: string, clientX: number) =>
    fireEvent(barre, new MouseEvent(type, { bubbles: true, button: 0, clientX }));

  it("la pastille suit le doigt, et l'attend jusqu'à ce que la route la rejoigne", () => {
    // Le défaut que ça corrige : au relâchement, remettre la pastille sur `indexActif` la
    // renvoyait à l'onglet *quitté* pendant toute la durée du changement d'écran. Le doigt
    // disait déjà où il allait.
    // `vi.clearAllMocks()` efface les appels, pas les implémentations : sans cette ligne,
    // la route reste celle qu'un test précédent a posée.
    chemin.mockReturnValue("/");
    const { container } = render(<Navbar />);
    const barre = barreMesuree(container);
    const pastille = container.querySelector<HTMLElement>(".navbar-curseur");

    // Au repos, elle est sur la route — « Accueil ».
    expect(pastille?.style.transform).toBe("translateX(0%)");

    // 4 px de liseré, 392 utiles, quatre cellules de 98 : 250 tombe dans la troisième.
    doigt(barre, "pointerdown", 250);
    expect(pastille?.style.transform).toBe("translateX(200%)");

    doigt(barre, "pointerup", 250);
    // Le doigt est levé, la route n'a pas encore changé : la pastille reste où il l'a
    // laissée au lieu de retomber sur « Accueil ».
    expect(pastille?.style.transform).toBe("translateX(200%)");
  });

  it("un geste annulé ne laisse aucune intention derrière lui", () => {
    // Le défilement vole le pointeur, une notification système aussi. Rien n'a été
    // relâché, donc rien n'a été choisi.
    chemin.mockReturnValue("/");
    const { container } = render(<Navbar />);
    const barre = barreMesuree(container);
    const pastille = container.querySelector<HTMLElement>(".navbar-curseur");

    doigt(barre, "pointerdown", 250);
    expect(pastille?.style.transform).toBe("translateX(200%)");
    doigt(barre, "pointercancel", 250);
    expect(pastille?.style.transform).toBe("translateX(0%)");
  });

  it("la souris fait monter l'icône, l'appui l'enfonce", () => {
    // jsdom n'évalue aucune requête média et ne calcule aucune cascade : les règles
    // s'assèrent à la source, comme celles des gestes natifs juste en dessous.
    const feuille = readFileSync(join(RACINE, "components/foundation/tokens.css"), "utf8");
    const survol = feuille.match(/@media \(hover: hover\) and \(pointer: fine\) \{[^]*?\n\}/)?.[0];

    expect(survol).toMatch(/\.navbar-onglet:hover \.navbar-icone/);
    expect(survol).toMatch(/transform:\s*translateY\(-4px\)/);
    // L'appui, lui, ne dépend d'aucun pointeur : c'est le seul retour que le tactile
    // reçoit quand le doigt ne glisse pas.
    expect(feuille).toMatch(/\.navbar-onglet:active \.navbar-icone \{[^}]*transform:\s*scale\(0\.92\)/);
    // La classe que ces règles visent doit exister sur l'icône, sinon elles ne visent rien.
    render(<Navbar />);
    expect(screen.getByLabelText("Accueil").querySelector(".navbar-icone")).toBeTruthy();
  });

  it("les onglets désarment les gestes natifs qui mangeraient le maintien", () => {
    // L'aperçu de lien iOS et la sélection Android se déclenchent tous deux sur un
    // maintien : sans la classe, le geste n'atteint jamais le composant.
    render(<Navbar />);
    for (const { libelle } of ONGLETS) {
      expect(screen.getByLabelText(libelle).className).toContain("navbar-onglet");
    }
    const feuille = readFileSync(join(RACINE, "components/foundation/tokens.css"), "utf8");
    expect(feuille).toMatch(/\.navbar-onglet\s*\{[^}]*-webkit-touch-callout:\s*none/);
    expect(feuille).toMatch(/\.navbar-onglet\s*\{[^}]*touch-action:\s*manipulation/);
    // WCAG 2.3.3 : le mouvement se neutralise sous `prefers-reduced-motion`.
    expect(feuille).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});

describe("header : titre centré, retour par l'historique", () => {
  it("affiche le titre et rend le bouton de retour", () => {
    render(<LayoutHeader titre="Réglages" />);
    expect(screen.getAllByText("Réglages").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Retour")).toBeTruthy();
  });

  it("le retour suit l'historique, jamais une route codée en dur", () => {
    // Une entrée précédente existe : on est arrivé ici depuis un autre écran de l'app.
    globalThis.history.pushState(null, "", "/c/!groupe:t");
    render(<LayoutHeader titre="Conversation" />);
    fireEvent.click(screen.getByLabelText("Retour"));
    expect(retour).toHaveBeenCalledTimes(1);
    expect(pousser).not.toHaveBeenCalled();
  });

  it("sans historique, le retour ramène à l'accueil au lieu de ne rien faire", () => {
    // Conversation ouverte depuis une notification, ou relancée par iOS : première entrée
    // d'historique, et une PWA installée n'a aucun bouton de navigateur pour en sortir.
    const longueur = vi.spyOn(globalThis.history, "length", "get").mockReturnValue(1);
    try {
      render(<LayoutHeader titre="Conversation" />);
      fireEvent.click(screen.getByLabelText("Retour"));
      expect(retour).not.toHaveBeenCalled();
      expect(pousser).toHaveBeenCalledWith("/");
    } finally {
      longueur.mockRestore();
    }
  });

  it("les layouts sans pile n'ont pas de retour", () => {
    render(<LayoutHeader titre="Accueil" retour={false} />);
    expect(screen.queryByLabelText("Retour")).toBeNull();
  });
});

describe("Placeholder : pourquoi c'est vide, et quoi faire", () => {
  it("rend l'icône, le texte et l'action", () => {
    render(
      <Placeholder
        titre="Aucune conversation"
        explication="Commencez par ajouter quelqu'un."
        icone={<svg data-testid="icone" />}
        action={<button type="button">Ajouter</button>}
      />,
    );

    expect(screen.getByText("Aucune conversation")).toBeTruthy();
    expect(screen.getByText("Commencez par ajouter quelqu'un.")).toBeTruthy();
    expect(screen.getByTestId("icone")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ajouter" })).toBeTruthy();
  });

  it("un état vide sans issue n'invente pas d'action", () => {
    render(<Placeholder titre="Aucune mention" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("skeletons et bandeau d'état de connexion", () => {
  it("le squelette rend une géométrie, pas un spinner", () => {
    // DESIGN.md : « pas de spinner plein écran : skeletons localisés », de même
    // géométrie que le contenu final pour qu'il n'y ait aucun décalage à l'arrivée.
    const { container } = render(<Skeleton width={200} height={44} />);
    expect(container.firstElementChild).toBeTruthy();
  });

  it("en ligne, le bandeau n'existe pas", () => {
    // Un bandeau permanent qui dit « tout va bien » est du bruit : on cesse de le lire
    // au moment où il aurait quelque chose à dire.
    const { container } = render(<ConnectionBanner etat="en-ligne" />);
    expect(container.innerHTML).toBe("");
  });

  it("hors ligne, il tient une promesse plutôt que d'annoncer une panne", () => {
    render(<ConnectionBanner etat="hors-ligne" />);
    expect(screen.getByText("Hors ligne")).toBeTruthy();
    // l'historique reste lisible et l'envoi est différé, pas perdu.
    expect(screen.getByText(/consultables/)).toBeTruthy();
    expect(screen.getByText(/à la reconnexion/)).toBeTruthy();
  });
});

describe("primitives partagées", () => {
  it("le sélecteur de composant rend ses options et remonte le choix", () => {
    const choisir = vi.fn();
    render(
      <SegmentedControl label="Vue" value="messages" onChange={choisir}>
        <SegmentedControlItem value="messages" label="Messages" />
        <SegmentedControlItem value="medias" label="Médias" />
      </SegmentedControl>,
    );

    fireEvent.click(screen.getByText("Médias"));
    expect(choisir).toHaveBeenCalledWith("medias");
  });

  /**
   * DESIGN.md — un sélecteur occupe la largeur de son conteneur, et ses options se la
   * partagent également. Le défaut d'Astryx est `hug` : chaque option se contente de son
   * texte, et les trois sélecteurs de l'app rendaient deux ou quatre boutons serrés à
   * gauche d'un cadre trop large pour eux — la même incohérence à trois écrans.
   *
   * Structurel, et non par écran : jsdom ne calcule aucune largeur (il ne rend ni flex ni
   * cascade), et c'est un oubli qui se refait au prochain `<SegmentedControl>` — d'autant
   * que le prop manquant est *silencieux*, il rend simplement moins bien.
   */
  it("aucun sélecteur ne laisse ses options se serrer à gauche", () => {
    const fautifs = sourcesLivrees()
      .filter(({ code }) => /<SegmentedControl[\s>]/.test(sansCommentaires(code)))
      .flatMap(({ chemin, code }) =>
        // `(?<!=)>` : la flèche des callbacks (`onChange={() => …}`) porte un `>` qui
        // couperait la capture avant les attributs suivants (même motif que `<Sheet>`).
        [...sansCommentaires(code).matchAll(/<SegmentedControl\b([^]*?)(?<!=)>/g)]
          .filter(([, attributs]) => !/\blayout="fill"/.test(attributs ?? ""))
          .map(() => chemin.replace(RACINE, "")),
      );

    expect(fautifs).toEqual([]);
  });

  it("la liste de boutons rend les actions et les déclenche", () => {
    const ouvrir = vi.fn();
    render(
      <ButtonsList
        boutons={[
          { cle: "a", libelle: "Ouvrir", onClick: ouvrir },
          { cle: "b", libelle: "Quitter le groupe", onClick: vi.fn(), destructif: true },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Ouvrir"));
    expect(ouvrir).toHaveBeenCalledTimes(1);
    // DESIGN.md : `danger` est réservé au destructif — et il est porté par le token.
    expect(screen.getByText("Quitter le groupe").closest("[style]")?.getAttribute("style")).toContain(
      "--color-error",
    );
  });

  it("la feuille s'ouvre et se ferme par son état, pas par un montage conditionnel", () => {
    // `<dialog>` garde son contenu dans le DOM et le masque : c'est le comportement
    // natif, et c'est lui qui permet à la plateforme d'animer l'ouverture et de gérer
    // le piège de focus. On assère donc l'état d'ouverture, pas la présence du texte.
    const { rerender } = render(
      <Sheet ouvert={false} onFermer={vi.fn()} nom="Feuille de test">
        <p>Contenu</p>
      </Sheet>,
    );
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(false);

    rerender(
      <Sheet ouvert onFermer={vi.fn()} nom="Feuille de test">
        <p>Contenu</p>
      </Sheet>,
    );
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Contenu")).toBeTruthy();
  });

  /**
   * **Deux sorties sur toutes les feuilles**, décidées : le bouton, et le
   * clic sur le fond.
   *
   * Le défaut qu'elles ferment était un cul-de-sac réel : `purpose="form"` d'Astryx bloque
   * le clic sur le fond et ne laisse qu'Échap — touche qui **n'existe pas sur un
   * téléphone**. Cinq feuilles l'utilisaient, dont deux sans le moindre bouton de sortie :
   * `PhotoCapture` sur caméra refusée n'affichait qu'un paragraphe, et l'écran de nouvelle
   * conversation deux boutons qui s'enfoncent d'un cran.
   *
   * Le bouton se teste au rendu ; l'absence de blocage se lit à la source, `purpose` ne
   * laissant aucune trace observable dans le DOM de jsdom.
   */
  it("une feuille se ferme par son bouton, avec ou sans titre", () => {
    for (const props of [{ nom: "Feuille sans titre" }, { titre: "Feuille titrée" }]) {
      const onFermer = vi.fn();
      render(
        <Sheet ouvert onFermer={onFermer} {...props}>
          <p>Contenu</p>
        </Sheet>,
      );

      // Un seul, et en français : celui d'Astryx dirait « Close » — son `fr-FR.json`
      // porte 3 clés sur 219, et le shard ne monte aucun fournisseur i18n.
      const fermer = screen.getAllByRole("button", { name: "Fermer" });
      expect(fermer).toHaveLength(1);

      fireEvent.click(fermer[0]!);
      expect(onFermer).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it("aucune feuille ne peut interdire la sortie par le fond", () => {
    // Le code, pas les commentaires : ce fichier **explique** le piège de `purpose="form"`
    // et le mot y figure. Même distinction que pour les autres interdits structurels.
    const code = sansCommentaires(
      readFileSync(join(RACINE, "components/foundation/Sheet.tsx"), "utf8"),
    );
    // `info` est le defaut d'Astryx : ne rien passer, c'est laisser Echap **et** le fond.
    expect(code).not.toMatch(/purpose=/);
    // Et la prop qui permettait de le refuser n'existe plus : tant qu'elle vivait, la
    // prochaine feuille pouvait refaire le piege.
    expect(code).not.toMatch(/sortie/);
    const fautives = sourcesLivrees()
      .filter(({ code: source }) => /sortie=/.test(sansCommentaires(source)))
      .map(({ chemin }) => chemin.replace(RACINE, ""));
    expect(fautives).toEqual([]);
  });

  /**
   * La géométrie du bottom-sheet, lue à la source : jsdom ne calcule ni largeur, ni
   * débordement, ni coins. Ce test ne prouve pas le rendu — il empêche les lignes qui le
   * tiennent de disparaître, chacune ayant corrigé un défaut visible.
   */
  it("le bottom-sheet prend toute la largeur, s'arrondit en haut, et defile", () => {
    const source = readFileSync(join(RACINE, "components/foundation/Sheet.tsx"), "utf8");

    // Astryx sort `width: 400px` + `max-width: 90vw` ; avec `left: 0` et `right: 0`, une
    // largeur explicite rend `right` inoperant — la feuille sortait collee au bord gauche.
    expect(source).toContain('width={bas ? "100%" : 400}');
    expect(source).toContain('maxWidth: "none"');
    // DESIGN.md § Overview : r12 pour les bottom-sheets, et seulement en haut — les deux
    // coins du bas entaillaient le bord de l'ecran contre lequel la feuille est collee.
    expect(source).toContain('borderRadius: "var(--radius-page) var(--radius-page) 0 0"');
    // DESIGN.md e2 : `surface-raised` + hairline + ombre basse, et jamais d'ombre sans
    // filet. Astryx pose `surface` + `--shadow-high` sans bordure.
    expect(source).toContain("var(--color-background-popover)");
    expect(source).toContain("1px solid var(--color-border)");
    expect(source).toContain("var(--shadow-low)");
    // Le conteneur interne d'Astryx est en `overflow: hidden` : sans ces trois lignes, le
    // contenu passe `maxHeight` est coupe et inatteignable (liste des membres, reglages).
    expect(source).toContain('overflowY: "auto"');
    expect(source).toContain("minHeight: 0");
    expect(source).toContain("env(safe-area-inset-bottom, 0px)");
  });

  /**
   * WCAG 4.1.2 — audit impeccable. Neuf feuilles s'ouvraient sans nom
   * accessible : un lecteur d'écran annonçait « boîte de dialogue » et s'arrêtait là.
   * Astryx l'écrivait dans la sortie de nos propres tests, et personne ne la lisait.
   *
   * Structurel plutôt que par écran : c'est un oubli qui se refait au prochain `<Sheet>`,
   * et une feuille d'action n'a pas d'en-tête visible pour le rappeler.
   */
  it("aucune feuille ne s'ouvre sans nom accessible", () => {
    const fautives = sourcesLivrees()
      .filter(({ code }) => /<Sheet[\s>]/.test(sansCommentaires(code)))
      .flatMap(({ chemin, code }) =>
        // `(?<!=)>` : la flèche des callbacks (`onFermer={() => …}`) porte un `>` qui
        // couperait la capture avant d'atteindre les attributs suivants.
        [...sansCommentaires(code).matchAll(/<Sheet\b([^]*?)(?<!=)>/g)]
          .filter(([, attributs]) => !/\b(titre|nom)=/.test(attributs ?? ""))
          .map(() => chemin.replace(RACINE, "")),
      );

    expect(fautives).toEqual([]);
  });
});

describe("DESIGN.md — un mot insécable ne doit pas élargir l'écran", () => {
  /**
   * Signalé par les utilisateurs : un long message « casse le layout », en conversation
   * comme sur l'accueil, où l'écran entier devenait plus large.
   *
   * jsdom ne calcule aucune mise en page : ce test ne prouve pas le rendu, il empêche la
   * ligne qui le tient de disparaître (règle 7 — une valeur qu'aucun site de lecture ne
   * relit est indétectable). La mesure, elle, a été faite au navigateur.
   */
  it("`body` porte la coupure, et c'est `anywhere` — `break-word` ne suffirait pas", () => {
    const feuille = sansCommentaires(
      readFileSync(join(RACINE, "components/foundation/tokens.css"), "utf8"),
    );
    // `anywhere` compte dans la largeur minimale intrinsèque, `break-word` non : c'est
    // cette largeur qu'une piste de grille lit pour se dimensionner. Avec `break-word`,
    // le texte se couperait et la page resterait large.
    expect(feuille).toMatch(/body\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("l'aperçu de l'accueil se laisse contraindre : sa ligne ne s'enroule pas", () => {
    // `maxLines={1}` rend l'aperçu `white-space: nowrap` — le `overflow-wrap` de `body`
    // ne peut rien pour lui, et l'élément de grille doit accepter de rétrécir.
    const liste = sansCommentaires(lire("components/accueil/ConversationsList.tsx"));
    expect(liste).toMatch(/role="listitem"[^>]*minWidth: 0/);
  });
});

describe("le bandeau de connexion est branché, pas seulement écrit", () => {
  it("il suit navigator.onLine et ses deux événements", async () => {
    // Mesuré au navigateur : `ConnectionBanner` existait, avait ses tests,
    // et **aucun écran ne le montait**. Couper le réseau n'affichait rien. Un composant
    // que personne ne rend ne tient aucune promesse — c'est le branchement qui compte.
    const etat = { valeur: true };
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => etat.valeur);

    const { container } = render(<ConnectionBannerLive />);
    expect(container.textContent).toBe("");

    etat.valeur = false;
    await act(async () => {
      globalThis.dispatchEvent(new Event("offline"));
    });
    expect(container.textContent).toContain("Hors ligne");

    etat.valeur = true;
    await act(async () => {
      globalThis.dispatchEvent(new Event("online"));
    });
    expect(container.textContent).toBe("");
  });

  it("le shell le rend, et au-dessus de la porte de récupération", () => {
    // La porte remplace tout le contenu : un bandeau posé sous elle serait invisible
    // exactement quand il compte — perdre le réseau pendant l'onboarding.
    const providers = readFileSync(join(RACINE, "app/providers.tsx"), "utf8");
    expect(providers).toMatch(/<ConnectionBannerLive\s*\/>/);
    expect(providers.indexOf("<ConnectionBannerLive")).toBeLessThan(providers.indexOf("<RecoveryGate"));
  });
});

describe("la file d'envoi appartient à la session, pas à un écran", () => {
  it("`createOutbox` n'est appelé que par le provider de session", () => {
    // Elle vivait dans `Conversation` : créée à l'ouverture d'un salon, `dispose()` au
    // démontage. Le bandeau hors ligne promet que « ce que vous écrivez partira à la
    // reconnexion » — c'était faux dès qu'on quittait l'écran. Mesuré au navigateur le
    // 08/08/2026 : deux messages écrits hors ligne, un rechargement, le réseau revenu,
    // et rien ne partait. Une promesse qu'on ne tient pas, c'est l'interdit n°13.
    const appelants = sourcesLivrees()
      .filter(({ code }) => /\bcreateOutbox\s*\(/.test(sansCommentaires(code)))
      .map(({ chemin }) => chemin.replace(RACINE, ""));

    expect(appelants).toEqual(["/components/conversation/OutboxProvider.tsx"]);
  });

  it("le provider enveloppe les écrans dans le shell", () => {
    const providers = readFileSync(join(RACINE, "app/providers.tsx"), "utf8");
    expect(providers).toMatch(/<OutboxProvider>/);
  });
});
