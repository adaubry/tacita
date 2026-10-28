import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import { routeConversation } from "../lib/routes";
import type { Conversation } from "@tacita/messaging";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Accueil } from "../components/accueil/Accueil";
import { ConversationPreview } from "../components/accueil/ConversationPreview";
import { ConversationsList } from "../components/accueil/ConversationsList";
import { HomeHeader } from "../components/accueil/HomeHeader";
import { RequestsBanner } from "../components/accueil/RequestsBanner";
import { SessionProvider } from "../components/onboarding/SessionProvider";
import { dateApercu } from "../lib/dates";
import { SEUIL_GLISSEMENT } from "../lib/gestes";

const pousser = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: pousser, back: vi.fn() }),
}));

/** Les paquets 04–10 sont mockés à leurs interfaces. */
const restoreSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: vi.fn(),
  restoreSession: () => restoreSession(),
}));

const listees = vi.fn<() => Conversation[]>(() => []);
const demandes = vi.fn(() => [] as { roomId: string; name: string }[]);
const setFavourite = vi.fn(async () => ({}));
const openDirectMessage = vi.fn(async () => "!dm:tacita.test");
const createGroupChat = vi.fn(async () => ({ room_id: "!groupe:tacita.test" }));
vi.mock("@tacita/messaging", async (original) => ({
  // Les deux littéraux de mention sont **réels** : l'aperçu de l'accueil rend `@room`
  // tel que l'utilisateur l'a tapé (`@everyone`), comme la timeline, et les mocker
  // reviendrait à éprouver l'écran contre un vocabulaire qui n'est pas le sien.
  ROOM_MENTION: (await original<typeof import("@tacita/messaging")>()).ROOM_MENTION,
  EVERYONE: (await original<typeof import("@tacita/messaging")>()).EVERYONE,
  conversations: () => listees(),
  invitations: () => demandes(),
  setFavourite: (...args: unknown[]) => setFavourite(...(args as [])),
  openDirectMessage: (...args: unknown[]) => openDirectMessage(...(args as [])),
  createGroupChat: (...args: unknown[]) => createGroupChat(...(args as [])),
  subscribeConversations: () => () => {},
}));

const AUJOURDHUI = new Date("2026-08-05T14:32:00").getTime();
const HIER = new Date("2026-08-04T14:32:00").getTime();

function conversation(partiel: Partial<Conversation> = {}): Conversation {
  return {
    roomId: "!salon:tacita.test",
    name: "alice",
    direct: true,
    peerId: "@alice:tacita.test",
    preview: "on se voit demain ?",
    previewDeMoi: false,
    timestamp: AUJOURDHUI,
    unread: 0,
    mention: false,
    pinned: false,
    ...partiel,
  };
}

/**
 * Un glissement : la même carte, du départ à l'arrivée.
 *
 * **`MouseEvent` et non `fireEvent.pointerDown`** : jsdom 26 n'implémente pas
 * `PointerEvent` (vérifié), et l'événement de repli que Testing Library construit alors
 * ne porte **pas** `clientX` — le seuil ne serait jamais franchi, et le test passerait
 * au vert en n'ayant rien glissé. `MouseEvent` porte les coordonnées, et React lit le
 * type qu'on lui donne. À reprendre tel quel pour les gestes de M-D.
 */
function glisser(cible: HTMLElement, distance: number, vertical = 0) {
  fireEvent(cible, new MouseEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 }));
  /*
   * **Le `pointermove` n'est pas facultatif**. Le simulateur passait du
   * `pointerdown` au `pointerup` sans rien entre les deux — ce qu'aucun pointeur réel ne
   * fait. Depuis que le geste **verrouille son axe** au premier mouvement franc (plainte
   * « slider un message marche mal »), un glissement sans mouvement n'a pas d'axe, donc
   * pas d'action : le test décrivait une trajectoire impossible et le code avait raison
   * de ne rien en faire.
   */
  fireEvent(
    cible,
    new MouseEvent("pointermove", { bubbles: true, clientX: distance, clientY: vertical }),
  );
  fireEvent(
    cible,
    new MouseEvent("pointerup", { bubbles: true, clientX: distance, clientY: vertical }),
  );
}

/**
 * La carte, par son bouton accessible. `getByLabelText` ne suffit pas : l'avatar porte
 * lui aussi le nom de la conversation, et c'est voulu — deux éléments, un seul rôle.
 */
const carte = (nom: string) => screen.getByRole("button", { name: nom });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("la carte de conversation : avatar, nom, aperçu, date", () => {
  it("rend la preview complète à partir des données du package", () => {
    render(
      <ConversationPreview
        conversation={conversation()}
        onOuvrir={vi.fn()}
        onEpingler={vi.fn()}
        maintenant={AUJOURDHUI}
      />,
    );

    expect(screen.getAllByText("alice").length).toBeGreaterThan(0);
    expect(screen.getByText("on se voit demain ?")).toBeTruthy();
    expect(screen.getByText(dateApercu(AUJOURDHUI, AUJOURDHUI))).toBeTruthy();
  });

  /**
   * **Un nom de fichier n'est pas un aperçu.** Signalé sur l'accueil : le dernier message
   * d'une conversation s'y affichait `vocal-1793145337523.webm`, parce que c'est ce que
   * Matrix met dans le `body` d'une pièce jointe. Ça ne dit ni ce que c'est, ni dans quel
   * sens ça va, et ça expose un détail que personne n'a choisi de montrer.
   */
  it("une pièce jointe se nomme, et la phrase dit qui l'a envoyée à qui", () => {
    const rendre = (partiel: Partial<Conversation>) => {
      cleanup();
      render(
        <ConversationPreview
          conversation={conversation(partiel)}
          onOuvrir={vi.fn()}
          onEpingler={vi.fn()}
          maintenant={AUJOURDHUI}
        />,
      );
    };

    rendre({ preview: "vocal-179.webm", previewMsgtype: "m.audio", previewAuteur: "adam" });
    expect(screen.getByText("adam vous a envoyé un message vocal")).toBeTruthy();
    // Le nom du fichier a disparu de l'écran, c'était tout le problème.
    expect(screen.queryByText(/\.webm/)).toBeNull();

    rendre({ preview: "vocal-179.webm", previewMsgtype: "m.audio", previewDeMoi: true });
    expect(screen.getByText("Vous avez envoyé un message vocal")).toBeTruthy();

    // Le nom vient de l'expéditeur, pas du salon : sinon un groupe dirait « Équipe vous
    // a envoyé une photo ».
    rendre({
      name: "Équipe",
      direct: false,
      preview: "IMG_4417.HEIC",
      previewMsgtype: "m.image",
      previewAuteur: "maxence",
    });
    expect(screen.getByText("maxence vous a envoyé une photo")).toBeTruthy();
  });

  it("un message texte reste rendu tel quel — la phrase ne vise que les pièces jointes", () => {
    render(
      <ConversationPreview
        conversation={conversation({ preview: "on se voit demain ?" })}
        onOuvrir={vi.fn()}
        onEpingler={vi.fn()}
        maintenant={AUJOURDHUI}
      />,
    );
    expect(screen.getByText("on se voit demain ?")).toBeTruthy();
  });

  it("aujourd'hui donne une heure, hier une date courte — deux formats distincts", () => {
    const heure = dateApercu(AUJOURDHUI, AUJOURDHUI);
    const date = dateApercu(HIER, AUJOURDHUI);

    expect(heure).toMatch(/\d{1,2}\D\d{2}/);
    expect(date).not.toBe(heure);
    // Localisé, jamais codé en dur (décision design) : la date porte l'année ou le
    // séparateur du lecteur, pas le « 05/17 » américain du wireframe.
    expect(date).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "short" }).format(HIER));
  });

  it("ouvre la conversation au tap", () => {
    const onOuvrir = vi.fn();
    render(
      <ConversationPreview conversation={conversation()} onOuvrir={onOuvrir} onEpingler={vi.fn()} />,
    );

    fireEvent.click(carte("alice"));
    expect(onOuvrir).toHaveBeenCalledWith("!salon:tacita.test");
  });

  it("un salon sans message rend une carte, pas une date vide bricolée", () => {
    render(
      <ConversationPreview
        conversation={conversation({ timestamp: 0, preview: "" })}
        onOuvrir={vi.fn()}
        onEpingler={vi.fn()}
      />,
    );
    expect(carte("alice")).toBeTruthy();
  });
});

describe("badges : 9+ au-delà de neuf, la mention prime", () => {
  const rendre = (partiel: Partial<Conversation>) =>
    render(
      <ConversationPreview
        conversation={conversation(partiel)}
        onOuvrir={vi.fn()}
        onEpingler={vi.fn()}
      />,
    );

  it("douze non-lus s'écrivent « 9+ »", () => {
    rendre({ unread: 12 });
    expect(screen.getByText("9+")).toBeTruthy();
  });

  it("neuf non-lus s'écrivent encore « 9 »", () => {
    rendre({ unread: 9 });
    expect(screen.getByText("9")).toBeTruthy();
  });

  it("une mention non lue remplace le nombre par « @ »", () => {
    rendre({ unread: 12, mention: true });
    expect(screen.getByText("@")).toBeTruthy();
    expect(screen.queryByText("9+")).toBeNull();
  });

  it("rien à signaler, pas de badge", () => {
    rendre({ unread: 0 });
    expect(screen.queryByLabelText(/non lus?/)).toBeNull();
  });
});

describe("épingler : glissement droit, et son équivalent non gestuel", () => {
  it("le glissement au-delà du seuil épingle", () => {
    const onEpingler = vi.fn();
    render(
      <ConversationPreview
        conversation={conversation()}
        onOuvrir={vi.fn()}
        onEpingler={onEpingler}
      />,
    );

    glisser(carte("alice"), SEUIL_GLISSEMENT);
    expect(onEpingler).toHaveBeenCalledWith("!salon:tacita.test", true);
  });

  it("en deçà du seuil, ou vers la gauche, rien ne se passe", () => {
    const onEpingler = vi.fn();
    render(
      <ConversationPreview
        conversation={conversation()}
        onOuvrir={vi.fn()}
        onEpingler={onEpingler}
      />,
    );

    glisser(carte("alice"), SEUIL_GLISSEMENT - 1);
    glisser(carte("alice"), -SEUIL_GLISSEMENT);
    expect(onEpingler).not.toHaveBeenCalled();
  });

  /*
   * **Le geste penché appartient au défilement** (30/08/2026, plainte : « slider un
   * message marche mal »). Le seuil de distance seul ne suffit pas : un doigt qui descend
   * la liste en biais franchit 64 px d'horizontal en route. L'axe se verrouille au premier
   * mouvement franc et ne se rouvre plus — c'est ce que ce test tient.
   */
  it("un glissement à dominante verticale ne déclenche aucune action", () => {
    const onEpingler = vi.fn();
    render(
      <ConversationsList
        conversations={[conversation({ name: "alice" })]}
        onOuvrir={vi.fn()}
        onEpingler={onEpingler}
      />,
    );

    // 64 px d'horizontal, mais 80 px de vertical : c'est un défilement.
    glisser(carte("alice"), SEUIL_GLISSEMENT, 80);
    expect(onEpingler).not.toHaveBeenCalled();
  });

  it("une conversation épinglée se désépingle par le même geste", () => {
    const onEpingler = vi.fn();
    render(
      <ConversationPreview
        conversation={conversation({ pinned: true })}
        onOuvrir={vi.fn()}
        onEpingler={onEpingler}
      />,
    );

    glisser(carte("alice"), SEUIL_GLISSEMENT);
    expect(onEpingler).toHaveBeenCalledWith("!salon:tacita.test", false);
  });

  it("le glissement appelle le tag favourite du package, pas un store maison", async () => {
    listees.mockReturnValue([conversation()]);
    rendreAccueil();
    await waitFor(() => expect(carte("alice")).toBeTruthy());

    glisser(carte("alice"), SEUIL_GLISSEMENT);
    await waitFor(() =>
      expect(setFavourite).toHaveBeenCalledWith(expect.anything(), "!salon:tacita.test", true),
    );
  });

  it("les épinglées restent en tête malgré le tri", () => {
    const ancienne = conversation({
      roomId: "!ancienne:t",
      name: "ancienne",
      timestamp: 1000,
      pinned: true,
    });
    const recente = conversation({ roomId: "!recente:t", name: "recente", timestamp: 9000 });

    // Le package rend la plus récente d'abord ; « anciennes » inverse **le reste**.
    render(
      <ConversationsList
        conversations={[recente, ancienne]}
        tri="anciennes"
        onOuvrir={vi.fn()}
        onEpingler={vi.fn()}
      />,
    );

    const lignes = screen.getAllByRole("listitem");
    expect(within(lignes[0]!).getByRole("button", { name: "ancienne" })).toBeTruthy();
  });
});

describe("bannière de demandes : elle n'existe que s'il y en a", () => {
  it("zéro demande, aucune bannière", () => {
    render(<RequestsBanner demandes={0} onOuvrir={vi.fn()} onIgnorer={vi.fn()} />);
    expect(screen.queryByText("Nouvelles demandes")).toBeNull();
  });

  it("deux demandes, une carte avec son compteur, qui route vers M-G", () => {
    const onOuvrir = vi.fn();
    render(<RequestsBanner demandes={2} onOuvrir={onOuvrir} onIgnorer={vi.fn()} />);

    expect(screen.getByText("Nouvelles demandes")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();

    fireEvent.click(carte("Nouvelles demandes (2)"));
    expect(onOuvrir).toHaveBeenCalledTimes(1);
  });

  it("le glissement droit l'écarte, et elle revient à la demande suivante", async () => {
    demandes.mockReturnValue([{ roomId: "!invite:t", name: "alice" }]);
    rendreAccueil();
    await waitFor(() => expect(screen.getByText("Nouvelles demandes")).toBeTruthy());

    glisser(carte("Nouvelles demandes (1)"), SEUIL_GLISSEMENT);
    await waitFor(() => expect(screen.queryByText("Nouvelles demandes")).toBeNull());
  });
});

describe("en-tête de l'accueil : sélecteur, tri, recherche, création", () => {
  const rendre = (props: Partial<Parameters<typeof HomeHeader>[0]> = {}) => {
    const actions = {
      tri: "recentes" as const,
      onTri: vi.fn(),
      onAjouterDesAmis: vi.fn(),
      onRechercher: vi.fn(),
      onCreer: vi.fn(),
      ...props,
    };
    render(<HomeHeader {...actions} />);
    return actions;
  };

  it("« Ajouter des amis » bascule de layout, il ne filtre pas la liste", () => {
    const { onAjouterDesAmis } = rendre();
    fireEvent.click(screen.getByText("Ajouter des amis"));
    expect(onAjouterDesAmis).toHaveBeenCalledTimes(1);
  });

  it("le dropdown de tri propose récentes et anciennes", () => {
    const { onTri } = rendre();
    // Le déclencheur porte le tri courant ; les deux options sont dans le menu qu'il
    // ouvre — d'où le rôle, pas le texte, qui existe deux fois une fois ouvert.
    fireEvent.click(screen.getByRole("button", { name: "Récentes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Anciennes" }));
    expect(onTri).toHaveBeenCalledWith("anciennes");
  });

  it("recherche et « + » sont des cibles de 44 px", () => {
    const { onRechercher, onCreer } = rendre();

    for (const libelle of ["Rechercher", "Nouvelle conversation ou groupe"]) {
      expect(screen.getByLabelText(libelle).style.minHeight).toBe("44px");
    }

    fireEvent.click(screen.getByLabelText("Rechercher"));
    fireEvent.click(screen.getByLabelText("Nouvelle conversation ou groupe"));
    expect(onRechercher).toHaveBeenCalledTimes(1);
    expect(onCreer).toHaveBeenCalledTimes(1);
  });
});

describe("création : un DM sans doublon, ou un groupe", () => {
  it("choisir un contact ouvre le DM par le package, jamais par createRoom", async () => {
    listees.mockReturnValue([conversation()]);
    rendreAccueil();
    await waitFor(() => expect(carte("alice")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Nouvelle conversation ou groupe"));
    const feuille = within(screen.getByRole("dialog"));
    fireEvent.click(feuille.getByText("Nouvelle conversation"));
    fireEvent.click(feuille.getByText("@alice:tacita.test"));

    await waitFor(() =>
      expect(openDirectMessage).toHaveBeenCalledWith(expect.anything(), "@alice:tacita.test"),
    );
    expect(createGroupChat).not.toHaveBeenCalled();
    await waitFor(() => expect(pousser).toHaveBeenCalledWith(routeConversation("!dm:tacita.test")));
  });

  it("un groupe demande un nom et au moins un membre", async () => {
    listees.mockReturnValue([conversation()]);
    rendreAccueil();
    await waitFor(() => expect(carte("alice")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("Nouvelle conversation ou groupe"));
    const feuille = within(screen.getByRole("dialog"));
    fireEvent.click(feuille.getByText("Nouveau groupe"));

    // Le comportement, pas l'attribut : Astryx garde le bouton focusable quand il porte
    // une explication (`aria-disabled` plutôt que `disabled`), et c'est très bien — ce
    // qui compte est qu'aucun groupe ne parte sans nom ni membre.
    fireEvent.click(feuille.getByRole("button", { name: /Créer le groupe/ }));
    expect(createGroupChat).not.toHaveBeenCalled();

    fireEvent.change(feuille.getByLabelText("Nom du groupe"), { target: { value: "équipe" } });
    fireEvent.click(feuille.getByRole("checkbox", { name: "alice" }));
    fireEvent.click(feuille.getByRole("button", { name: /Créer le groupe/ }));

    await waitFor(() =>
      expect(createGroupChat).toHaveBeenCalledWith(expect.anything(), "équipe", [
        "@alice:tacita.test",
      ]),
    );
  });
});

describe("la liste dit ce qu'elle fait : skeleton, puis vide, puis contenu", () => {
  it("en attente de données, des skeletons — pas un écran vide qui ment", () => {
    render(
      <ConversationsList conversations={[]} chargement onOuvrir={vi.fn()} onEpingler={vi.fn()} />,
    );
    expect(screen.getByLabelText("Chargement des conversations")).toBeTruthy();
  });

  it("aucune conversation : le Placeholder de M-A, avec son action", () => {
    const onDemarrer = vi.fn();
    render(
      <ConversationsList
        conversations={[]}
        onOuvrir={vi.fn()}
        onEpingler={vi.fn()}
        onDemarrer={onDemarrer}
      />,
    );

    expect(screen.getByText("Démarrez votre première conversation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Nouvelle conversation" }));
    expect(onDemarrer).toHaveBeenCalledTimes(1);
  });
});

/**
 * L'accueil complet, session prête. `restoreSession` mocké plutôt qu'un contexte
 * fabriqué : c'est la jonction M-B → M-C qu'on veut exercer, pas un double du provider.
 */
function rendreAccueil() {
  return render(
    <SessionProvider homeserverUrl="https://chat.tacita.test">
      <Accueil />
    </SessionProvider>,
  );
}

beforeEach(() => {
  listees.mockReturnValue([]);
  demandes.mockReturnValue([]);
  restoreSession.mockResolvedValue(asSession({
      client: { getUserId: () => "@moi:tacita.test", on: vi.fn(), off: vi.fn() },
      recoveryState: async () => "prete" as const,
    }));
});
