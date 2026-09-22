import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import type { Conversation, RoomNotificationLevel } from "@tacita/messaging";
import type { SearchStats } from "@tacita/search";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionProvider } from "../components/onboarding/SessionProvider";
import { Confidentialite } from "../components/settings/Confidentialite";
import { InfosConversation } from "../components/settings/InfosConversation";
import { LienInvitation } from "../components/settings/LienInvitation";
import { LimitesConnues } from "../components/settings/LimitesConnues";
import { MembresGroupe } from "../components/settings/MembresGroupe";
import { NotificationsSalon } from "../components/settings/NotificationsSalon";
import { OptionsConversation } from "../components/settings/OptionsConversation";
import { Reglages } from "../components/settings/Reglages";
import { ThemeConversation } from "../components/settings/ThemeConversation";
import { brancherModeMasque } from "../lib/mode-masque";
import { lireFondEcran, lireModeMasque } from "../lib/preferences";
import { sourcesLivrees, sansCommentaires } from "./sources";

const pousser = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/reglages",
  useRouter: () => ({ push: pousser, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const restoreSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: vi.fn(),
  restoreSession: () => restoreSession(),
}));

/** Les paquets 04–10 sont mockés à leurs interfaces (spec 11). */
const conversation = (partiel: Partial<Conversation> = {}): Conversation => ({
  roomId: "!dm:t",
  name: "adam",
  direct: true,
  peerId: "@adam:t",
  preview: "",
  timestamp: 0,
  unread: 0,
  mention: false,
  pinned: false,
  ...partiel,
});

const salons = vi.fn<() => Conversation[]>(() => [conversation()]);
const niveauDe = vi.fn<() => RoomNotificationLevel>(() => "all");
const poserNiveau = vi.fn(async () => {});
const listeMembres = vi.fn(() => [
  { userId: "@luca:t", name: "luca", powerLevel: 100 },
  { userId: "@adam:t", name: "adam", powerLevel: 0 },
]);
const droitKick = vi.fn(() => true);
const exclure = vi.fn(async () => ({}));
const inviter = vi.fn(async () => ({}));

vi.mock("@tacita/messaging", () => ({
  conversations: () => salons(),
  createGroupChat: vi.fn(async () => ({ room_id: "!neuf:t" })),
  getPinnedEvents: () => [],
  messages: () => [],
  memberCount: () => 4,
  members: () => listeMembres(),
  canKick: (...args: unknown[]) => droitKick(...(args as [])),
  kick: (...args: unknown[]) => exclure(...(args as [])),
  invite: (...args: unknown[]) => inviter(...(args as [])),
  powerLevelOf: (_s: unknown, _r: unknown, userId: string) =>
    listeMembres().find((membre) => membre.userId === userId)?.powerLevel ?? 0,
  roomNotificationLevel: () => niveauDe(),
  setRoomNotificationLevel: (...args: unknown[]) => poserNiveau(...(args as [])),
  PINNED_EVENTS_METADATA: { cleartext: true, reason: "événement d'état" },
  REACTIONS_METADATA: { cleartext: true, reason: "agrégation serveur" },
}));

vi.mock("@tacita/receipts", () => ({ DELIVERED_EVENT_TYPE: "org.tacita.delivered" }));
// Partiel : `lib/media-env.ts` lit aussi des constantes réelles du paquet (muxeurs).
vi.mock("@tacita/media-pipeline", async (original) => ({
  ...(await original<typeof import("@tacita/media-pipeline")>()),
  downloadAttachment: vi.fn(async () => new Uint8Array()),
}));

const stats = vi.fn<() => Promise<SearchStats>>();
const purger = vi.fn(async () => {});
vi.mock("@tacita/search", () => ({
  createSearch: () => ({
    search: vi.fn(),
    index: vi.fn(),
    stats: () => stats(),
    wipe: () => purger(),
    dispose: vi.fn(),
  }),
}));

let indexedDB: IDBFactory;

const rendreAvecSession = (noeud: React.ReactNode) =>
  render(
    <SessionProvider homeserverUrl="https://chat.tacita.test" rediriger={vi.fn()}>
      {noeud}
    </SessionProvider>,
  );

/** Une session prête, réduite à ce que les écrans de M-H en lisent. */
const session = () =>
  asSession({
    client: {
      getUserId: () => "@luca:t",
      getUser: () => ({ displayName: "luca" }),
      getAccessToken: () => "jeton",
    },
    recoveryRequired: async () => false,
  } as never);

beforeEach(() => {
  indexedDB = new IDBFactory();
  globalThis.Worker = class {
    terminate() {}
    postMessage() {}
  } as unknown as typeof Worker;
  globalThis.URL.createObjectURL ??= vi.fn(() => "blob:tacita/1");
  globalThis.URL.revokeObjectURL ??= vi.fn();

  stats.mockResolvedValue({ size: 1200, max: 50_000, oldestTs: null, newestTs: null });
  salons.mockReturnValue([conversation()]);
  niveauDe.mockReturnValue("all");
  droitKick.mockReturnValue(true);
  restoreSession.mockResolvedValue(session());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("REQ-UIX-31 — layout Settings : carte de profil, puis des options en modal", () => {
  it("rend la carte de profil et mène au profil propre", async () => {
    rendreAvecSession(<Reglages />);

    const carte = await screen.findByRole("button", { name: "Profil de luca" });
    expect(screen.getByText("@luca:t")).toBeTruthy();

    fireEvent.click(carte);
    expect(pousser).toHaveBeenCalledWith("/profil");
  });

  it("les cinq options sont là, et chacune ouvre une modal plutôt qu'un écran", async () => {
    rendreAvecSession(<Reglages />);

    for (const libelle of [
      "Apparence",
      "Confidentialité",
      "Notifications",
      "Stockage local",
      "Limites connues",
    ]) {
      expect(await screen.findByText(libelle)).toBeTruthy();
    }

    fireEvent.click(screen.getByText("Apparence"));
    // Une modal, pas une navigation : le dialogue s'ouvre et l'URL ne bouge pas.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(pousser).not.toHaveBeenCalled();
  });

  it("l'apparence propose les trois modes du mécanisme M-A", async () => {
    rendreAvecSession(<Reglages />);
    fireEvent.click(await screen.findByText("Apparence"));

    const modal = within(await screen.findByRole("dialog"));
    for (const libelle of ["Comme le système", "Clair", "Sombre"]) {
      expect(modal.getByText(libelle)).toBeTruthy();
    }
  });

  it("le stockage local montre l'index et son plafond, et propose de le vider", async () => {
    rendreAvecSession(<Reglages />);
    fireEvent.click(await screen.findByText("Stockage local"));

    await waitFor(() =>
      expect(screen.getByText(/1200 messages indexés sur 50000/)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Vider l'index de recherche" }));
    await waitFor(() => expect(purger).toHaveBeenCalledTimes(1));
  });

  it("les notifications globales n'annoncent que ce que M-H tient : le par-salon", async () => {
    salons.mockReturnValue([conversation(), conversation({ roomId: "!g:t", name: "équipe", direct: false })]);
    niveauDe.mockReturnValue("mentions");

    rendreAvecSession(<Reglages />);
    fireEvent.click(await screen.findByText("Notifications"));

    const modal = within(await screen.findByRole("dialog"));
    expect(modal.getAllByText("Mentions uniquement").length).toBeGreaterThan(0);
    // Aucune promesse d'abonnement push : il appartient à M-I, et rien ici ne l'annonce.
    expect(modal.queryByText(/abonnement/i)).toBeNull();
  });
});

describe("REQ-UI-13 — mode masqué : la bascule agit, et l'effet symétrique est écrit", () => {
  it("la bascule appelle setHiddenMode sur le service d'accusés", async () => {
    const receipts = { setHiddenMode: vi.fn() };
    brancherModeMasque(indexedDB, receipts);

    render(<Confidentialite indexedDB={indexedDB} />);
    fireEvent.click(screen.getByLabelText("Mode masqué"));

    await waitFor(() => expect(receipts.setHiddenMode).toHaveBeenCalledWith(true));
  });

  it("le réglage survit au rechargement : il est écrit en IndexedDB, pas en mémoire", async () => {
    render(<Confidentialite indexedDB={indexedDB} />);
    fireEvent.click(screen.getByLabelText("Mode masqué"));

    await waitFor(async () => expect(await lireModeMasque(indexedDB)).toBe(true));
  });

  it("un service branché après coup part avec le réglage enregistré", async () => {
    render(<Confidentialite indexedDB={indexedDB} />);
    fireEvent.click(screen.getByLabelText("Mode masqué"));
    await waitFor(async () => expect(await lireModeMasque(indexedDB)).toBe(true));

    const receipts = { setHiddenMode: vi.fn() };
    brancherModeMasque(indexedDB, receipts);
    await waitFor(() => expect(receipts.setHiddenMode).toHaveBeenCalledWith(true));
  });

  it("l'explication dit que l'effet va dans les deux sens", () => {
    render(<Confidentialite indexedDB={indexedDB} />);

    // REQ-RCP-07 : ce n'est pas un réglage à sens unique, et le taire serait une
    // promesse implicite fausse.
    expect(screen.getByText(/ne verront plus « délivré » ni « lu » de votre part/)).toBeTruthy();
    expect(screen.getByText(/vous ne verrez plus les leurs/)).toBeTruthy();
  });
});

describe("REQ-UIX-32 — limites connues : sobre, et complet sur les cinq sujets", () => {
  it("nomme les réactions, les épinglés, « délivré », les métadonnées et la recherche", () => {
    render(<LimitesConnues />);

    expect(screen.getByText(/réactions circulent en clair/i)).toBeTruthy();
    expect(screen.getByText(/messages épinglés est en clair/i)).toBeTruthy();
    expect(screen.getByText(/« Délivré » est une extension à nous/)).toBeTruthy();
    expect(screen.getByText(/voit qui parle à qui/i)).toBeTruthy();
    expect(screen.getByText(/recherche porte sur cet appareil/i)).toBeTruthy();
  });

  it("le type d'événement vient du paquet, il n'est pas recopié", () => {
    render(<LimitesConnues />);
    expect(screen.getByText("org.tacita.delivered")).toBeTruthy();
  });
});

describe("REQ-UIX-33 — Info buttons : quatre boutons, et le premier suit la variante", () => {
  it("en 1:1 : profil, rechercher, muter, options", async () => {
    rendreAvecSession(<InfosConversation roomId="!dm:t" />);

    const groupe = within(await screen.findByRole("group", { name: "Actions de la conversation" }));
    for (const libelle of ["Profil", "Rechercher", "Muter", "Options"]) {
      expect(groupe.getByRole("button", { name: libelle })).toBeTruthy();
    }
    expect(groupe.queryByRole("button", { name: "Ajouter" })).toBeNull();
  });

  it("en groupe : ajouter, rechercher, muter, options — et le compteur de membres", async () => {
    salons.mockReturnValue([conversation({ roomId: "!g:t", name: "équipe", direct: false, peerId: undefined })]);
    rendreAvecSession(<InfosConversation roomId="!g:t" />);

    const groupe = within(await screen.findByRole("group", { name: "Actions de la conversation" }));
    expect(groupe.getByRole("button", { name: "Ajouter" })).toBeTruthy();
    expect(groupe.queryByRole("button", { name: "Profil" })).toBeNull();

    // REQ-UI-05 / REQ-MSG-11 — le compteur vient du paquet.
    expect(await screen.findByText("4 membres")).toBeTruthy();
  });

  it("« rechercher » arme la recherche sur cette conversation (M-F)", async () => {
    rendreAvecSession(<InfosConversation roomId="!dm:t" />);

    fireEvent.click(await screen.findByRole("button", { name: "Rechercher" }));
    expect(pousser).toHaveBeenCalledWith(`/recherche?salon=${encodeURIComponent("!dm:t")}`);
  });

  it("« ajouter un membre » invite par identifiant, sans passer par le service de liens", async () => {
    salons.mockReturnValue([conversation({ roomId: "!g:t", name: "équipe", direct: false, peerId: undefined })]);
    const reseau = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("réseau interdit"));
    rendreAvecSession(<InfosConversation roomId="!g:t" />);

    fireEvent.click(await screen.findByRole("button", { name: "Ajouter" }));
    fireEvent.change(await screen.findByLabelText("Identifiant Matrix"), {
      target: { value: "@mira:t" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Inviter" }));

    // REQ-INV-16 : ce parcours n'émet aucun appel vers le service de liens.
    await waitFor(() =>
      expect(inviter).toHaveBeenCalledWith(expect.anything(), "!g:t", "@mira:t"),
    );
    expect(reseau).not.toHaveBeenCalled();
  });
});

describe("REQ-UIX-34 — Options : les éphémères n'existent pas, le kick se mérite", () => {
  it("l'option « messages éphémères » est absente du DOM, jamais grisée", () => {
    for (const direct of [true, false]) {
      cleanup();
      render(<OptionsConversation direct={direct} niveauLibelle="Tout" onOuvrir={vi.fn()} />);
      // E-03 / D-09 : abandonnée, pas reportée. Une option grisée serait une promesse
      // non tenue affichée (interdit n°13).
      expect(screen.queryByText(/éphémère/i)).toBeNull();
    }
  });

  it("le jeu d'options suit la variante", () => {
    render(<OptionsConversation direct niveauLibelle="Tout" onOuvrir={vi.fn()} />);
    expect(screen.getByText("Créer un groupe avec cette personne")).toBeTruthy();
    expect(screen.queryByText("Lien d'invitation")).toBeNull();

    cleanup();
    render(<OptionsConversation direct={false} niveauLibelle="Tout" onOuvrir={vi.fn()} />);
    expect(screen.getByText("Lien d'invitation")).toBeTruthy();
    expect(screen.getByText("Membres")).toBeTruthy();
    expect(screen.queryByText("Créer un groupe avec cette personne")).toBeNull();
  });

  it("le niveau de notification courant se lit sans ouvrir l'option (REQ-UIX-36)", () => {
    render(<OptionsConversation direct niveauLibelle="Mentions uniquement" onOuvrir={vi.fn()} />);
    expect(screen.getByText("Mentions uniquement")).toBeTruthy();
  });

  it("sans le power level, aucun bouton d'exclusion — pas un bouton grisé", () => {
    droitKick.mockReturnValue(false);
    render(<MembresGroupe session={session()} roomId="!g:t" />);

    expect(screen.getByText("luca")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Exclure" })).toBeNull();
  });

  it("avec le power level, l'exclusion passe par le paquet", async () => {
    render(<MembresGroupe session={session()} roomId="!g:t" />);

    fireEvent.click(screen.getAllByRole("button", { name: "Exclure" })[0]!);
    await waitFor(() =>
      expect(exclure).toHaveBeenCalledWith(expect.anything(), "!g:t", "@luca:t"),
    );
  });

  it("le lien de groupe dit qu'il ne garantit pas que le groupe reste joignable", async () => {
    const liens = {
      lister: vi.fn(async () => []),
      emettreGroupe: vi.fn(async () => ({ id: "l1", token: "jeton-opaque", expiresAt: 0 })),
      revoquer: vi.fn(async () => {}),
    };
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://tacita.test" />);

    // REQ-INV-15 amendée, interdit n°13 : la limite est au-dessus du bouton.
    expect(screen.getByText(/ne garantit pas que le groupe reste joignable/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Créer un lien d'invitation" }));
    await waitFor(() =>
      expect(screen.getByText("https://tacita.test/i/jeton-opaque")).toBeTruthy(),
    );
    expect(liens.emettreGroupe).toHaveBeenCalledWith("!g:t");
  });
});

describe("REQ-UIX-35 — fond d'écran : aperçu, application sur cet appareil, réinitialisation", () => {
  const choisir = () => {
    const champ = screen.getByLabelText("Choisir une image") as HTMLInputElement;
    fireEvent.change(champ, {
      target: { files: [new File(["image"], "plage.jpg", { type: "image/jpeg" })] },
    });
  };

  it("le choix est persisté en IndexedDB, jamais envoyé au serveur", async () => {
    const reseau = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("réseau interdit"));
    render(<ThemeConversation roomId="!dm:t" indexedDB={indexedDB} />);

    choisir();
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));

    await waitFor(async () => expect(await lireFondEcran(indexedDB, "!dm:t")).toBeInstanceOf(Blob));
    expect(reseau).not.toHaveBeenCalled();
  });

  it("la réinitialisation efface le fond de cette conversation", async () => {
    render(<ThemeConversation roomId="!dm:t" indexedDB={indexedDB} />);

    choisir();
    fireEvent.click(screen.getByRole("button", { name: "Appliquer" }));
    await waitFor(async () => expect(await lireFondEcran(indexedDB, "!dm:t")).toBeInstanceOf(Blob));

    fireEvent.click(screen.getByRole("button", { name: "Réinitialiser" }));
    await waitFor(async () => expect(await lireFondEcran(indexedDB, "!dm:t")).toBeUndefined());
  });

  it("un aperçu existe, et le libellé dit « sur cet appareil »", () => {
    render(<ThemeConversation roomId="!dm:t" indexedDB={indexedDB} />);

    expect(screen.getByLabelText("Aperçu du fond d'écran")).toBeTruthy();
    expect(screen.getByText(/enregistré sur cet appareil, et sur lui seul/)).toBeTruthy();
  });

  it("le voile de lisibilité est le token de DESIGN.md, pas une valeur en dur", () => {
    // La timeline (M-D) et l'aperçu doivent poser exactement le même voile : un aperçu
    // plus clément que la timeline ment sur ce qu'on est en train de choisir.
    for (const chemin of ["components/settings/ThemeConversation.tsx", "components/conversation/Conversation.tsx"]) {
      const source = sansCommentaires(
        sourcesLivrees().find((fichier) => fichier.chemin.endsWith(chemin))!.code,
      );
      expect(source).toMatch(/var\(--tacita-scrim\)/);
    }
  });

  it("le fond reste fixe derrière la conversation, il ne défile pas avec les messages", () => {
    // Posé en `background` sur la colonne des messages, il montait avec eux et sortait
    // de l'écran. Il vit sur un calque `position: fixed`, et `background-attachment`
    // n'est pas une option : Safari iOS ignore `fixed`, et `local` le fait défiler.
    const source = (chemin: string) =>
      sansCommentaires(sourcesLivrees().find((fichier) => fichier.chemin.endsWith(chemin))!.code);

    expect(source("components/conversation/Conversation.tsx")).toMatch(/position: "fixed"/);
    for (const chemin of ["components/conversation/Conversation.tsx", "components/conversation/Timeline.tsx"]) {
      expect(source(chemin)).not.toMatch(/backgroundAttachment|background-attachment/);
    }
  });
});

describe("REQ-UIX-36 — trois niveaux de notification, en push rules natives", () => {
  it("« mentions uniquement » appelle la push rule correspondante", async () => {
    render(<NotificationsSalon session={session()} roomId="!g:t" />);

    fireEvent.click(screen.getByLabelText("Mentions uniquement"));
    await waitFor(() =>
      expect(poserNiveau).toHaveBeenCalledWith(expect.anything(), "!g:t", "mentions"),
    );
  });

  it("chaque niveau dit ce qu'il fait, « silencieux » compris", () => {
    render(<NotificationsSalon session={session()} roomId="!g:t" />);
    expect(screen.getByText(/Rien ne notifie, mentions comprises/)).toBeTruthy();
  });

  it("l'état courant vient du paquet, pas d'une mémoire locale", () => {
    niveauDe.mockReturnValue("mute");
    render(<NotificationsSalon session={session()} roomId="!g:t" />);

    expect((screen.getByLabelText("Silencieux") as HTMLInputElement).checked).toBe(true);
  });

  it("une écriture refusée ramène l'affichage en arrière", async () => {
    poserNiveau.mockRejectedValueOnce(new Error("hors ligne"));
    render(<NotificationsSalon session={session()} roomId="!g:t" />);

    fireEvent.click(screen.getByLabelText("Silencieux"));
    await waitFor(() => expect(screen.getByText(/n'a pas pu être enregistré/)).toBeTruthy());
    expect((screen.getByLabelText("Tout") as HTMLInputElement).checked).toBe(true);
  });
});

describe("REQ-UIX-37 — les galeries closent le layout info, dans les deux variantes", () => {
  it("le 1:1 rend ConversationCollections", async () => {
    rendreAvecSession(<InfosConversation roomId="!dm:t" />);
    expect(await screen.findByLabelText("Contenus partagés")).toBeTruthy();
  });

  it("le groupe rend exactement la même section", async () => {
    salons.mockReturnValue([conversation({ roomId: "!g:t", name: "équipe", direct: false, peerId: undefined })]);
    rendreAvecSession(<InfosConversation roomId="!g:t" />);
    expect(await screen.findByLabelText("Contenus partagés")).toBeTruthy();
  });
});
