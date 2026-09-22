import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ButtonsList } from "../components/foundation/ButtonsList";
import { ConnectionBanner } from "../components/foundation/ConnectionBanner";
import { LayoutHeader } from "../components/foundation/LayoutHeader";
import { Navbar, ONGLETS } from "../components/foundation/Navbar";
import { Placeholder } from "../components/foundation/Placeholder";
import { Sheet } from "../components/foundation/Sheet";
import { SegmentedControl, SegmentedControlItem, Skeleton } from "../components/foundation/primitives";

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

describe("REQ-UIX-01 — navbar : quatre onglets, actif surélevé, sans rechargement", () => {
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
});

describe("REQ-UIX-02 — header : titre centré, retour par l'historique", () => {
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
    // Conversation ouverte depuis une notification, ou URL restaurée par iOS à la
    // relance : première entrée d'historique, et en PWA standalone aucun bouton de
    // navigateur. Un `back()` muet laisserait l'utilisateur coincé dans l'écran.
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

describe("REQ-UIX-03 — Placeholder : pourquoi c'est vide, et quoi faire", () => {
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

describe("REQ-UIX-04 — skeletons et bandeau d'état de connexion", () => {
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
    // REQ-UI-17 : l'historique reste lisible et l'envoi est différé, pas perdu.
    expect(screen.getByText(/consultables/)).toBeTruthy();
    expect(screen.getByText(/à la reconnexion/)).toBeTruthy();
  });
});

describe("REQ-UIX-05 — primitives partagées", () => {
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
      <Sheet ouvert={false} onFermer={vi.fn()}>
        <p>Contenu</p>
      </Sheet>,
    );
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(false);

    rerender(
      <Sheet ouvert onFermer={vi.fn()}>
        <p>Contenu</p>
      </Sheet>,
    );
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Contenu")).toBeTruthy();
  });
});
