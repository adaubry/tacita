import type { Conversation } from "@tacita/messaging";
import { ROOM_MENTION, type Search, type SearchHit, type SearchStats } from "@tacita/search";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HighlightedText } from "../components/recherche/HighlightedText";
import { MessagePreview } from "../components/recherche/MessagePreview";
import { Recherche } from "../components/recherche/Recherche";
import { RecentSearches } from "../components/recherche/RecentSearches";
import { SearchBar } from "../components/recherche/SearchBar";
import { SearchResults } from "../components/recherche/SearchResults";
import { useResultats } from "../components/recherche/useResultats";
import {
  CHAMP_APRES,
  CHAMP_AVANT,
  CHAMP_CONVERSATION,
  CHAMP_PERSONNE,
  CHAMP_TEXTE,
  CHAMP_TYPE,
  DEBOUNCE_MS,
  empiler,
  filtresDepuis,
  libellePerimetre,
  MAX_RECENTS,
  segmenter,
  termeDepuis,
} from "../lib/recherche";
import { lire, sansCommentaires, sourcesLivrees } from "./sources";

vi.mock("next/navigation", () => ({
  usePathname: () => "/recherche",
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const MOI = "@alice:tacita.test";
const MIRA = "@mira:tacita.test";
const LUNDI_10H = new Date("2026-08-03T10:00:00").getTime();

function conversation(partiel: Partial<Conversation> = {}): Conversation {
  return {
    roomId: "!dm:tacita.test",
    name: "mira",
    direct: true,
    peerId: MIRA,
    preview: "à demain",
    timestamp: LUNDI_10H,
    unread: 0,
    mention: false,
    pinned: false,
    ...partiel,
  };
}

function hit(partiel: Partial<SearchHit> = {}): SearchHit {
  return {
    eventId: "$un",
    roomId: "!dm:tacita.test",
    sender: MIRA,
    tsOrigin: LUNDI_10H,
    body: "on se voit à la réunion demain",
    msgtype: "m.text",
    mentions: [],
    score: 1,
    ...partiel,
  };
}

const STATS: SearchStats = {
  size: 1200,
  max: 200_000,
  oldestTs: new Date("2026-05-01T09:00:00").getTime(),
  newestTs: LUNDI_10H,
};

/** Le paquet `@tacita/search`, mocké — M-F ne teste pas l'index, il teste ce qu'il en fait. */
function rechercheMock(resultats: SearchHit[] = []): Search & { search: ReturnType<typeof vi.fn> } {
  return {
    index: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(resultats),
    stats: vi.fn().mockResolvedValue(STATS),
    wipe: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  } as unknown as Search & { search: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("la barre, et le périmètre dit en toutes lettres", () => {
  it("les bornes de stats() sont rendues, pas devinées", () => {
    render(
      <SearchBar tokens={[]} onTokens={vi.fn()} contacts={[]} salons={[]} stats={STATS} />,
    );

    const perimetre = screen.getByText(/Recherche dans l'historique téléchargé/);
    // Les deux bornes de, formatées par Intl — le texte contient l'année des
    // deux dates, ce qui suffit à prouver qu'elles viennent bien de `stats()`.
    expect(perimetre.textContent).toMatch(/2026/);
    expect(perimetre.textContent).toContain("du ");
    expect(perimetre.textContent).toContain(" au ");
  });

  it("sans bornes connues, la phrase reste — la limite ne disparaît pas avec les données", () => {
    expect(libellePerimetre(null)).toBe(
      "Recherche dans l'historique téléchargé sur cet appareil.",
    );
    expect(libellePerimetre({ size: 0, max: 200_000, oldestTs: null, newestTs: null })).toBe(
      "Recherche dans l'historique téléchargé sur cet appareil.",
    );
  });

  it("le plafond D-01 atteint est annoncé, et seulement alors", () => {
    const { rerender } = render(
      <SearchBar tokens={[]} onTokens={vi.fn()} contacts={[]} salons={[]} stats={STATS} />,
    );
    expect(screen.queryByText(/index est plein/)).toBeNull();

    rerender(
      <SearchBar
        tokens={[]}
        onTokens={vi.fn()}
        contacts={[]}
        salons={[]}
        stats={{ ...STATS, size: 200_000 }}
      />,
    );
    expect(screen.getByText(/index est plein/)).toBeTruthy();
  });
});

describe("recherches récentes : scroller, content peek, purge", () => {
  const profils = [
    { userId: MIRA, nom: "mira" },
    { userId: "@bob:tacita.test", nom: "bob" },
    { userId: "@sam:tacita.test", nom: "sam" },
  ];

  /**
   * jsdom ne fait aucune mise en page : `scrollWidth` et `clientWidth` y valent zéro. Le
   * débordement se simule donc en les posant — c'est exactement ce que demande
   * l'objectif mesurable de M-F (« débordement simulé »).
   */
  const simulerLargeurs = (contenu: number, visible: number) => {
    for (const [propriete, valeur] of [
      ["scrollWidth", contenu],
      ["clientWidth", visible],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, propriete, {
        configurable: true,
        get: () => valeur,
      });
    }
  };

  afterEach(() => {
    for (const propriete of ["scrollWidth", "clientWidth"]) {
      Object.defineProperty(HTMLElement.prototype, propriete, {
        configurable: true,
        get: () => 0,
      });
    }
  });

  it("quand la liste déborde, le dernier profil est partiellement visible", () => {
    simulerLargeurs(900, 320);
    render(<RecentSearches profils={profils} onChoisir={vi.fn()} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    // Le peek porte sur le dernier, et sur lui seul : couper un élément du milieu ne
    // voudrait rien dire.
    expect(items.at(-1)!.dataset.peek).toBe("true");
    expect(items[0]!.dataset.peek).toBeUndefined();
    expect(items.at(-1)!.style.overflow).toBe("hidden");
    // Réellement plus étroit que les autres, sinon « partiellement visible » est un mot.
    expect(parseFloat(items.at(-1)!.style.width)).toBeLessThan(parseFloat(items[0]!.style.width));
  });

  it("sans débordement, aucun élément n'est coupé — la coupure annoncerait du vide", () => {
    simulerLargeurs(300, 320);
    render(<RecentSearches profils={profils} onChoisir={vi.fn()} />);

    for (const item of screen.getAllByRole("listitem")) {
      expect(item.dataset.peek).toBeUndefined();
    }
    expect(screen.getByRole("list").dataset.deborde).toBeUndefined();
  });

  it("la liste est purgeable, et vide elle ne rend rien", () => {
    const onPurger = vi.fn();
    const { rerender } = render(
      <RecentSearches profils={profils} onChoisir={vi.fn()} onPurger={onPurger} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Effacer" }));
    expect(onPurger).toHaveBeenCalledOnce();

    rerender(<RecentSearches profils={[]} onChoisir={vi.fn()} onPurger={onPurger} />);
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("empiler met le plus récent en tête, sans doublon, sous le plafond", () => {
    expect(empiler([MIRA, "@bob:tacita.test"], MIRA)).toEqual([MIRA, "@bob:tacita.test"]);
    expect(empiler(["@bob:tacita.test"], MIRA)).toEqual([MIRA, "@bob:tacita.test"]);

    const beaucoup = Array.from({ length: MAX_RECENTS + 5 }, (_, rang) => `@u${rang}:tacita.test`);
    expect(empiler(beaucoup, MIRA)).toHaveLength(MAX_RECENTS);
    expect(empiler(beaucoup, MIRA)[0]).toBe(MIRA);
  });
});

describe("deux sections titrées, occurrences surlignées", () => {
  const resultat = {
    eventId: "$un",
    roomId: "!dm:tacita.test",
    conversation: "mira",
    extrait: "on se voit à la réunion demain",
    horodatage: LUNDI_10H,
  };

  it("des résultats mixtes rendent « Conversations » puis « Messages »", () => {
    render(
      <SearchResults
        conversations={[conversation({ name: "réunion produit", roomId: "!g:tacita.test" })]}
        messages={[resultat]}
        terme="réunion"
        perimetre="…"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
        maintenant={LUNDI_10H}
      />,
    );

    const sections = screen.getAllByRole("region");
    expect(sections.map((section) => section.getAttribute("aria-labelledby"))).toEqual([
      "section-conversations",
      "section-messages",
    ]);
    expect(screen.getByText("Conversations")).toBeTruthy();
    expect(screen.getByText("Messages")).toBeTruthy();
  });

  it("l'occurrence est marquée dans les deux sections, avec le token highlight", () => {
    render(
      <SearchResults
        conversations={[conversation({ name: "réunion produit", roomId: "!g:tacita.test" })]}
        messages={[resultat]}
        terme="réunion"
        perimetre="…"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
        maintenant={LUNDI_10H}
      />,
    );

    const marques = document.querySelectorAll("mark");
    expect(marques).toHaveLength(2);
    for (const marque of marques) {
      expect(marque.textContent?.toLowerCase()).toBe("réunion");
      // DESIGN.md : fond teinté par le token, encre **inchangée**.
      expect((marque as HTMLElement).style.background).toContain("--tacita-highlight");
      expect((marque as HTMLElement).style.color).toBe("inherit");
    }
  });

  it("le surlignage ignore casse et accents, sans déformer le texte rendu", () => {
    render(<HighlightedText texte="La Réunion de demain" terme="reunion" />);
    expect(document.querySelector("mark")?.textContent).toBe("Réunion");
    expect(document.body.textContent).toBe("La Réunion de demain");
  });

  it("chaque mot du terme est cherché séparément — Orama fait du OU", () => {
    // Sans cela, « réunion demain » ne surlignerait rien dans un message qui n'a qu'un
    // des deux mots, alors que le paquet l'a bien rendu comme résultat.
    expect(segmenter("réunion lundi", "réunion demain").filter((f) => f.surligne)).toHaveLength(1);
    expect(segmenter("rien ici", "").map((f) => f.surligne)).toEqual([false]);
  });

  it("un tap sur un message rend de quoi se positionner dessus", () => {
    const onOuvrirMessage = vi.fn();
    render(
      <MessagePreview resultat={resultat} terme="réunion" onOuvrir={onOuvrirMessage} maintenant={LUNDI_10H} />,
    );

    // `ClickableCard` rend son bouton en **frère** du contenu, pas en parent : le
    // nœud rendu par le label est la surface cliquable, et le contenu vit à côté.
    const surface = screen.getByLabelText("Message dans mira");
    const carte = surface.parentElement!;
    // Composant 19 : nom de conversation, date, extrait tronqué.
    expect(within(carte).getByText("mira")).toBeTruthy();
    expect(within(carte).getByText(/demain/)).toBeTruthy();
    fireEvent.click(surface);
    expect(onOuvrirMessage).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "!dm:tacita.test", eventId: "$un" }),
    );
  });

  it("aucun résultat : le périmètre est rappelé, pas seulement l'échec", () => {
    render(
      <SearchResults
        conversations={[]}
        messages={[]}
        terme="rien"
        perimetre="Recherche dans l'historique téléchargé sur cet appareil."
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
      />,
    );
    expect(screen.getByText("Aucun résultat")).toBeTruthy();
    expect(screen.getByText(/historique téléchargé/)).toBeTruthy();
  });
});

describe("filtres servis par l'index, jamais par du plein-texte", () => {
  it("chaque champ de la barre devient le critère correspondant de", () => {
    expect(filtresDepuis([{ field: CHAMP_PERSONNE, value: { type: "enum", value: MIRA } }])).toEqual(
      { sender: MIRA },
    );
    expect(
      filtresDepuis([{ field: CHAMP_CONVERSATION, value: { type: "enum", value: "!g:tacita.test" } }]),
    ).toEqual({ roomId: "!g:tacita.test" });
    expect(filtresDepuis([{ field: CHAMP_TYPE, value: { type: "enum", value: "m.image" } }])).toEqual(
      { msgtype: "m.image" },
    );
    // Les bornes de l'index sont en millisecondes, le token en secondes.
    expect(
      filtresDepuis([
        { field: CHAMP_APRES, value: { type: "date_absolute", unixSeconds: 1_700_000 } },
        { field: CHAMP_AVANT, value: { type: "date_absolute", unixSeconds: 1_800_000 } },
      ]),
    ).toEqual({ since: 1_700_000_000, until: 1_800_000_000 });

    // Le champ texte n'est pas un critère : c'est le terme.
    expect(filtresDepuis([{ field: CHAMP_TEXTE, value: { type: "string", value: "réunion" } }])).toEqual({});
    expect(termeDepuis([{ field: CHAMP_TEXTE, value: { type: "string", value: "réunion" } }])).toBe(
      "réunion",
    );
  });

  it("deux filtres combinés partent ensemble — l'intersection est faite par le paquet", () => {
    expect(
      filtresDepuis([
        { field: CHAMP_PERSONNE, value: { type: "enum", value: MIRA } },
        { field: CHAMP_TYPE, value: { type: "enum", value: "m.image" } },
      ]),
    ).toEqual({ sender: MIRA, msgtype: "m.image" });
  });

  it("l'onglet Mentions interroge le champ mentions, avec un terme vide", async () => {
    vi.useFakeTimers();
    const recherche = rechercheMock([hit({ mentions: [MOI] })]);

    render(
      <Recherche
        recherche={recherche}
        conversations={[conversation()]}
        contacts={[{ userId: MIRA, nom: "mira" }]}
        moi={MOI}
        variation="mentions"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
        maintenant={LUNDI_10H}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    // Le cœur de l'exigence : un **filtre**, pas une recherche. Le terme est vide, et
    // aucun nom d'affichage n'est passé en plein-texte.
    expect(recherche.search).toHaveBeenCalledWith("", {
      mentions: [MOI, ROOM_MENTION],
    });
    for (const [terme] of recherche.search.mock.calls) {
      expect(terme).toBe("");
      expect(terme).not.toContain("mira");
    }
  });

  it("exclure les groupes retire les résultats hors DM, sans nouvelle requête", async () => {
    vi.useFakeTimers();
    const recherche = rechercheMock([
      hit({ eventId: "$dm", roomId: "!dm:tacita.test" }),
      hit({ eventId: "$groupe", roomId: "!g:tacita.test" }),
    ]);

    render(
      <Recherche
        recherche={recherche}
        conversations={[
          conversation(),
          conversation({ roomId: "!g:tacita.test", name: "équipe", direct: false, peerId: undefined }),
        ]}
        contacts={[]}
        moi={MOI}
        variation="mentions"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
        maintenant={LUNDI_10H}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(screen.getAllByLabelText(/^Message dans /)).toHaveLength(2);

    const appelsAvant = recherche.search.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Exclure les groupes/ }));
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    const restants = screen.getAllByLabelText(/^Message dans /);
    expect(restants).toHaveLength(1);
    expect(restants[0]!.getAttribute("aria-label")).toBe("Message dans mira");
    // Le filtre est local : il ne relance pas l'index.
    expect(recherche.search.mock.calls).toHaveLength(appelsAvant);
  });
});

describe("débounce des changements de critères, skeletons, zéro réseau", () => {
  beforeEach(() => vi.useFakeTimers());

  it("vingt changements en rafale ne produisent qu'un seul appel à search", async () => {
    const recherche = rechercheMock();
    const { rerender } = renderHook(
      ({ terme }) => useResultats(recherche, terme, {}, true),
      { initialProps: { terme: "r" } },
    );

    // Chaque changement arrive avant la fin de la fenêtre : le minuteur précédent est
    // annulé. **Des critères, pas des frappes** — `PowerSearch` ne notifie la saisie
    // qu'à la validation d'un token (voie A). Éditer la valeur d'un token, en
    // ajouter un puis en retirer un autre produit bien ces rafales.
    for (let rang = 2; rang <= 20; rang++) {
      rerender({ terme: "r".repeat(rang) });
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_MS - 50);
      });
    }
    expect(recherche.search).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(recherche.search).toHaveBeenCalledOnce();
    // Et c'est le **dernier** état qui part, pas le premier.
    expect(recherche.search).toHaveBeenCalledWith("r".repeat(20), {});
  });

  it("des skeletons pendant la requête, remplacés par les résultats", async () => {
    const recherche = rechercheMock([hit()]);
    render(
      <Recherche
        recherche={recherche}
        conversations={[conversation()]}
        contacts={[]}
        moi={MOI}
        variation="mentions"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
        maintenant={LUNDI_10H}
      />,
    );

    expect(screen.getByLabelText("Recherche en cours").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });
    expect(screen.queryByLabelText("Recherche en cours")).toBeNull();
    expect(screen.getByLabelText("Message dans mira")).toBeTruthy();
  });

  it("aucun appel réseau ne part de la recherche", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const recherche = rechercheMock([hit()]);

    render(
      <Recherche
        recherche={recherche}
        conversations={[conversation()]}
        contacts={[]}
        moi={MOI}
        variation="mentions"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
        maintenant={LUNDI_10H}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("une recherche qui échoue rend « aucun résultat », pas des skeletons éternels", async () => {
    const recherche = rechercheMock();
    (recherche.search as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("worker mort"));

    render(
      <Recherche
        recherche={recherche}
        conversations={[conversation()]}
        contacts={[]}
        moi={MOI}
        variation="mentions"
        onOuvrirConversation={vi.fn()}
        onOuvrirMessage={vi.fn()}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(screen.queryByLabelText("Recherche en cours")).toBeNull();
    expect(screen.getByText("Aucun résultat")).toBeTruthy();
  });
});

describe("l'index de recherche appartient à la session, pas à un écran", () => {
  /**
   * Le défaut que ces trois lectures empêchent, et qui ne se voit dans aucun rendu :
   * `createSearch` n'indexe que ce qui se déchiffre **pendant qu'il est branché**. Créé à
   * l'ouverture de l'onglet Recherche et jeté à sa fermeture, il n'assistait à aucun
   * déchiffrement, et l'onglet interrogeait un index vide. Aucun test de composant ne
   * pouvait le dire : chacun passe un `Search` mocké, donc déjà peuplé.
   *
   * C'est la règle 7 du dépôt — une valeur posée à une jonction que personne ne relit
   * exige un test qui la relie à son site de lecture.
   */
  it("le provider est monté au-dessus des routes, comme la file d'envoi", () => {
    const providers = sansCommentaires(lire("app/providers.tsx"));
    expect(providers).toContain("<RechercheProvider>");
    // Dans la session : hors d'elle, il n'aurait pas de client sur quoi s'abonner.
    expect(providers.indexOf("<SessionProvider")).toBeLessThan(
      providers.indexOf("<RechercheProvider>"),
    );
  });

  it("aucun écran ne crée son propre index", () => {
    for (const { chemin, code } of sourcesLivrees()) {
      if (chemin.endsWith("/components/recherche/RechercheProvider.tsx")) continue;
      expect(sansCommentaires(code), chemin).not.toContain("createSearch(");
    }
  });
});
