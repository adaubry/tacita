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
import type { LienActif } from "../lib/liens-invitation";
import { LimitesConnues } from "../components/settings/LimitesConnues";
import { MembresGroupe } from "../components/settings/MembresGroupe";
import { NotificationsSalon } from "../components/settings/NotificationsSalon";
import { OptionsConversation } from "../components/settings/OptionsConversation";
import { Appareils } from "../components/settings/Appareils";
import { Reglages } from "../components/settings/Reglages";
import { ThemeConversation } from "../components/settings/ThemeConversation";
import { brancherModeMasque } from "../lib/mode-masque";
import { lireFondEcran, lireModeMasque } from "../lib/preferences";
import { sourcesLivrees, sansCommentaires } from "./sources";

const pousser = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/profil",
  useRouter: () => ({ push: pousser, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const restoreSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: vi.fn(),
  restoreSession: () => restoreSession(),
}));

/** Les paquets 04–10 sont mockés à leurs interfaces. */
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
const enAttente = vi.fn<() => { userId: string; name: string }[]>(() => []);
const regleDAcces = vi.fn(() => "invite" as "invite" | "knock");
const poserRegle = vi.fn(async () => ({ event_id: "$s" }));
const exclure = vi.fn(async () => ({}));
const inviter = vi.fn(async () => ({}));

vi.mock("@tacita/messaging", async (original) => ({
  // `identifiantComplet` est une fonction **pure** du paquet : la mocker
  // reviendrait à éprouver l'écran contre une règle de saisie qu'il n'a pas.
  identifiantComplet: (await original<typeof import("@tacita/messaging")>()).identifiantComplet,
  conversations: () => salons(),
  createGroupChat: vi.fn(async () => ({ room_id: "!neuf:t" })),
  getPinnedEvents: () => [],
  messages: () => [],
  memberCount: () => 4,
  members: () => listeMembres(),
  canKick: (...args: unknown[]) => droitKick(...(args as [])),
  // E-13 — les demandes d'entrée s'affichent au-dessus des membres. Vide par défaut :
  // la liste ne doit pas se peupler d'elle-même dans les tests qui n'en parlent pas.
  knockers: () => enAttente(),
  joinRule: () => regleDAcces(),
  setJoinRule: (...args: unknown[]) => poserRegle(...(args as [])),
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
/**
 * l'index vient du provider de session, pas de l'écran : c'est lui qu'on
 * mocke, et non `createSearch`. Le vrai provider construirait un `Worker`, que jsdom
 * n'a pas — et l'écran de stockage n'est de toute façon qu'un lecteur de cet index.
 */
vi.mock("../components/recherche/RechercheProvider", () => ({
  RechercheProvider: ({ children }: { children: React.ReactNode }) => children,
  useRecherche: () => ({
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
    <SessionProvider homeserverUrl="https://chat.tacita.test">
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
      // le provider écoute le refus de jeton du SDK.
      on: vi.fn(),
      off: vi.fn(),
    },
    recoveryState: async () => "prete" as const,
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

describe("les réglages sont une section du profil, en cartes d'option", () => {
  it("l'écran `/reglages` n'existe plus — aucune route, aucun lien vers lui", () => {
    // La condition qui rend l'amendement vrai : tant qu'un fichier de route subsiste,
    // Next la sert, et un lien oublié y mène sans que rien ne rougisse.
    for (const { chemin, code } of sourcesLivrees()) {
      expect(chemin, "la route a été supprimée, pas déplacée").not.toContain("/app/reglages/");
      expect(sansCommentaires(code), chemin).not.toMatch(/["'`]\/reglages/);
    }
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

describe("mode masqué : la bascule agit, et l'effet symétrique est écrit", () => {
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

    // ce n'est pas un réglage à sens unique, et le taire serait une
    // promesse implicite fausse.
    expect(screen.getByText(/ne verront plus « délivré » ni « lu » de votre part/)).toBeTruthy();
    expect(screen.getByText(/vous ne verrez plus les leurs/)).toBeTruthy();
  });
});

describe("limites connues : sobre, et complet sur les sept sujets", () => {
  it("nomme les réactions, les épinglés, « délivré », les métadonnées, l'annuaire et la recherche", () => {
    render(<LimitesConnues />);

    expect(screen.getByText(/réactions circulent en clair/i)).toBeTruthy();
    expect(screen.getByText(/messages épinglés est en clair/i)).toBeTruthy();
    expect(screen.getByText(/« Délivré » est une extension à nous/)).toBeTruthy();
    expect(screen.getByText(/voit qui parle à qui/i)).toBeTruthy();
    expect(screen.getByText(/recherche porte sur cet appareil/i)).toBeTruthy();
    // : l'annuaire ouvert est une exposition, donc une limite. Elle
    // est une limite assumée ; cet écran est l'endroit où l'utilisateur la lit.
    expect(screen.getByText(/trouvable par tous les comptes de ce serveur/i)).toBeTruthy();
  });

  it("D-12 / D-14 — ce que vaut la clé de récupération est dit, pas seulement documenté", () => {
    /*
     * Interdit n°13, et le cas le plus dur du produit : la promesse E2EE se lit plus large
     * qu'elle ne l'est si on ne dit pas qu'un changement de mot de passe confie au serveur
     * le secret qui déchiffre tout. C'est une limite assumée ; cet
     * écran est le seul endroit où l'utilisateur peut le lire.
     *
     * **Deux faits depuis D-14, et le second est nouveau** : la clé est transmise, et elle
     * ouvre le compte à elle seule. « Gardez-la précieusement » a cessé d'être un conseil
     * de prudence pour devenir la seule chose qui protège le compte — le taire ferait de
     * l'écran une demi-vérité.
     */
    render(<LimitesConnues />);
    expect(screen.getByText(/vaut votre mot de passe/i)).toBeTruthy();
    expect(screen.getByText(/envoyée au serveur pour être vérifiée/i)).toBeTruthy();
    expect(screen.getByText(/déchiffrerait alors vos conversations/i)).toBeTruthy();
    expect(screen.getByText(/elle seule suffit à ouvrir le compte/i)).toBeTruthy();
  });

  it("le type d'événement vient du paquet, il n'est pas recopié", () => {
    render(<LimitesConnues />);
    expect(screen.getByText("org.tacita.delivered")).toBeTruthy();
  });
});

describe("Info buttons : quatre boutons, et le premier suit la variante", () => {
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

    // le compteur vient du paquet.
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

    // ce parcours n'émet aucun appel vers le service de liens.
    await waitFor(() =>
      expect(inviter).toHaveBeenCalledWith(expect.anything(), "!g:t", "@mira:t"),
    );
    expect(reseau).not.toHaveBeenCalled();
  });

  it("un identifiant sans domaine suffit, et part complété", async () => {
    salons.mockReturnValue([conversation({ roomId: "!g:t", name: "équipe", direct: false, peerId: undefined })]);
    rendreAvecSession(<InfosConversation roomId="!g:t" />);

    fireEvent.click(await screen.findByRole("button", { name: "Ajouter" }));
    fireEvent.change(await screen.findByLabelText("Identifiant Matrix"), {
      target: { value: "mira" },
    });

    // Le bouton n'attend plus une adresse entière : le domaine vient du compte courant
    // (`@luca:t`), qui est le seul du déploiement.
    const bouton = screen.getByRole("button", { name: "Inviter" });
    expect(bouton.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(bouton);

    await waitFor(() => expect(inviter).toHaveBeenCalledWith(expect.anything(), "!g:t", "@mira:t"));
  });
});

describe("Options : les éphémères n'existent pas, le kick se mérite", () => {
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

  it("le niveau de notification courant se lit sans ouvrir l'option", () => {
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

  it("le lien de groupe dit que le porteur frappera, et qu'un membre confirmera", async () => {
    const liens = {
      lister: vi.fn(async () => []),
      emettreGroupe: vi.fn(async () => ({ id: "l1", token: "jeton-opaque", expiresAt: 0 })),
      // M-G émet aussi des liens d'ami par ce client : l'interface porte les deux, donc
      // le double en test aussi. Cet écran-ci n'appelle que `emettreGroupe`.
      emettreAmi: vi.fn(async () => ({ id: "l2", token: "jeton-ami", expiresAt: 0 })),
      revoquer: vi.fn(async () => {}),
      resoudre: vi.fn(async () => ({ kind: "group" as const, issuer: "@luca:t", roomId: "!g:t" })),
    };
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://tacita.test" />);

    // amendée, interdit n°13 : ce que le lien fait vraiment est dit au-dessus
    // du bouton. Depuis E-13 ce n'est plus « l'invitation échouera » mais « un membre
    // confirmera » — le texte a suivi le mécanisme, au lieu de rester juste par accident.
    expect(screen.getByText(/frappe à la porte/i)).toBeTruthy();
    expect(screen.getByText(/n'importe quel membre la confirme/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Créer un lien d'invitation" }));
    await waitFor(() =>
      expect(screen.getByText("https://tacita.test/i/jeton-opaque")).toBeTruthy(),
    );
    expect(liens.emettreGroupe).toHaveBeenCalledWith("!g:t");
  });
});

describe("fond d'écran : aperçu, application sur cet appareil, réinitialisation", () => {
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
    for (const chemin of ["components/settings/ThemeConversation.tsx", "components/conversation/Timeline.tsx"]) {
      const source = sansCommentaires(
        sourcesLivrees().find((fichier) => fichier.chemin.endsWith(chemin))!.code,
      );
      expect(source).toMatch(/var\(--tacita-scrim\)/);
    }
  });

  it("le fond reste en place quand les messages défilent", () => {
    // La timeline est la zone défilante : `background-attachment: local` y fait monter le
    // fond avec les messages jusqu'à le sortir de l'écran. jsdom ne rend pas le
    // défilement ; la valeur, elle, se relit.
    const source = sansCommentaires(
      sourcesLivrees().find((fichier) => fichier.chemin.endsWith("components/conversation/Timeline.tsx"))!.code,
    );
    expect(source).not.toMatch(/backgroundAttachment|background-attachment/);
  });
});

describe("trois niveaux de notification, en push rules natives", () => {
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

describe("les galeries closent le layout info, dans les deux variantes", () => {
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

describe("le sas d'un groupe suit ses liens, et se referme", () => {
  const liensAvec = (actifs: LienActif[]) => ({
    lister: vi.fn(async () => actifs),
    emettreGroupe: vi.fn(async () => ({ id: "l1", token: "jeton", expiresAt: 0 })),
    emettreAmi: vi.fn(),
    revoquer: vi.fn(async () => {}),
    resoudre: vi.fn(),
  });

  beforeEach(() => {
    poserRegle.mockClear();
    enAttente.mockReturnValue([]);
  });

  it("un lien de groupe actif ouvre le sas", async () => {
    regleDAcces.mockReturnValue("invite");
    const liens = liensAvec([{ id: "l1", kind: "group", roomId: "!g:t", expiresAt: Date.now(), usesLeft: 1 }]);
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://t.test" />);

    await waitFor(() => expect(poserRegle).toHaveBeenCalledWith(expect.anything(), "!g:t", "knock"));
  });

  it("plus aucun lien : le sas se referme tout seul, même sur expiration", async () => {
    // La bascule suit la **liste**, pas les gestes : un lien peut expirer sans que
    // personne ne soit là pour refermer la porte ce jour-là.
    regleDAcces.mockReturnValue("knock");
    render(<LienInvitation session={session()} roomId="!g:t" liens={liensAvec([])} origine="https://t.test" />);

    await waitFor(() => expect(poserRegle).toHaveBeenCalledWith(expect.anything(), "!g:t", "invite"));
  });

  it("n'écrit rien quand l'état est déjà le bon : un événement d'état inutile est du bruit", async () => {
    regleDAcces.mockReturnValue("knock");
    const liens = liensAvec([{ id: "l1", kind: "group", roomId: "!g:t", expiresAt: Date.now(), usesLeft: 1 }]);
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://t.test" />);

    await waitFor(() => expect(liens.lister).toHaveBeenCalled());
    expect(poserRegle).not.toHaveBeenCalled();
  });

  it("une bascule refusée par le serveur ne se tait pas", async () => {
    // Basculer `join_rules` exige le power level d'état. Un membre ordinaire peut créer
    // un lien et voir l'ouverture refusée : son lien serait valide et ne ferait entrer
    // personne. C'est la promesse silencieuse que E-13 avait pour but de supprimer.
    regleDAcces.mockReturnValue("invite");
    poserRegle.mockRejectedValueOnce(new Error("M_FORBIDDEN"));
    const liens = liensAvec([{ id: "l1", kind: "group", roomId: "!g:t", expiresAt: Date.now(), usesLeft: 1 }]);
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://t.test" />);

    expect(await screen.findByText("Ce lien ne fera entrer personne")).toBeTruthy();
    expect(screen.getByText(/administrateur du groupe/)).toBeTruthy();
  });

  /**
   * `lister()` rend **tous** les liens de l'appelant, tous salons confondus : c'est le
   * service qui le veut, et le panneau est celui d'un seul groupe. Sans le tri, un lien
   * émis pour un autre groupe ouvrait ce salon-ci — une porte ouverte sur un groupe qui
   * n'a aucun lien, et que personne n'a demandé à ouvrir.
   */
  it("le lien d'un autre groupe n'ouvre pas celui-ci", async () => {
    regleDAcces.mockReturnValue("invite");
    const liens = liensAvec([{ id: "ailleurs", kind: "group", roomId: "!autre:t", expiresAt: Date.now(), usesLeft: 1 }]);
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://t.test" />);

    await waitFor(() => expect(liens.lister).toHaveBeenCalled());
    expect(poserRegle).not.toHaveBeenCalledWith(expect.anything(), "!g:t", "knock");
    // Et il n'apparaît pas dans la liste : un lien qu'on ne peut pas rattacher à ce
    // groupe n'a rien à faire dans son panneau, révocable ou non.
    expect(screen.queryByRole("button", { name: "Révoquer" })).toBeNull();
  });

  /**
   * Le sens inverse, et c'est le plus coûteux : la porte qui **ne se referme pas**. Le
   * composant promet « revient à `invite` à la révocation du dernier » — le dernier de ce
   * groupe, pas le dernier tout court.
   */
  it("le dernier lien de ce groupe révoqué le referme, même si un autre groupe en a un", async () => {
    regleDAcces.mockReturnValue("knock");
    const liens = liensAvec([{ id: "ailleurs", kind: "group", roomId: "!autre:t", expiresAt: Date.now(), usesLeft: 1 }]);
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://t.test" />);

    await waitFor(() => expect(poserRegle).toHaveBeenCalledWith(expect.anything(), "!g:t", "invite"));
  });

  it("un lien d'ami n'ouvre le sas d'aucun groupe", async () => {
    regleDAcces.mockReturnValue("invite");
    const liens = liensAvec([{ id: "ami", kind: "friend", expiresAt: Date.now(), usesLeft: 1 }]);
    render(<LienInvitation session={session()} roomId="!g:t" liens={liens} origine="https://t.test" />);

    await waitFor(() => expect(liens.lister).toHaveBeenCalled());
    expect(poserRegle).not.toHaveBeenCalledWith(expect.anything(), "!g:t", "knock");
  });

  it("les demandes d'entrée s'affichent aux membres, et laisser entrer est une invitation native", async () => {
    enAttente.mockReturnValue([{ userId: "@mira:t", name: "mira" }]);
    render(<MembresGroupe session={session()} roomId="!g:t" />);

    expect(screen.getByText("Demandes d'entrée")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Laisser entrer" }));

    // E-13, voie A : le sas se referme par le chemin de D-09, sans état parallèle.
    await waitFor(() => expect(inviter).toHaveBeenCalledWith(expect.anything(), "!g:t", "@mira:t"));
  });

  it("aucune demande : aucune section — pas de titre qui annonce du vide", async () => {
    render(<MembresGroupe session={session()} roomId="!g:t" />);
    expect(screen.queryByText("Demandes d'entrée")).toBeNull();
  });
});

describe("voir ses appareils, et pouvoir en fermer un", () => {
  /*
   * **Ce que l'audit a nommé** : les jetons de ce déploiement n'expirent
   * pas, le changement de mot de passe ne déconnecte personne et la clé ouvre une
   * session à elle seule. Sans cet écran, une fuite n'avait aucune réponse — et un
   * produit qui promet la confidentialité doit offrir le geste de la reprendre.
   */
  const deuxAppareils = [
    { id: "ICI", nom: "Ce téléphone", derniereActivite: 1_700_000_000_000, courant: true },
    { id: "AILLEURS", nom: "Portable", derniereActivite: undefined, courant: false },
  ];

  const avecAppareils = (revoquer = vi.fn(async () => {})) => {
    const appareils = vi.fn(async () => deuxAppareils);
    return {
      revoquer,
      appareils,
      session: asSession({
        client: { getUserId: () => "@luca:t", on: vi.fn(), off: vi.fn() },
        appareils,
        revoquerAppareils: revoquer,
      } as never),
    };
  };

  it("montre les sessions ouvertes, et dit laquelle est celle-ci", async () => {
    const { session } = avecAppareils();
    render(<Appareils session={session} />);

    await waitFor(() => expect(screen.getByText(/Ce téléphone/)).toBeTruthy());
    // « celui-ci » n'est pas cosmétique : c'est ce qui empêche de fermer sa propre
    // session en croyant fermer celle de l'intrus.
    expect(screen.getByText("Ce téléphone · celui-ci")).toBeTruthy();
    // Une activité inconnue se dit, elle ne s'invente pas : une date fausse ferait
    // révoquer le mauvais appareil.
    expect(screen.getByText("Dernière activité inconnue")).toBeTruthy();
  });

  it("déconnecter demande le mot de passe, puis relit la liste", async () => {
    const revoquer = vi.fn(async () => {});
    const { session, appareils } = avecAppareils(revoquer);
    render(<Appareils session={session} />);

    await waitFor(() => expect(screen.getByText("Déconnecter")).toBeTruthy());
    fireEvent.click(screen.getByText("Déconnecter"));

    await waitFor(() => expect(screen.getByText("Déconnecter cet appareil ?")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Votre mot de passe"), {
      target: { value: "mon-mot-de-passe" },
    });
    fireEvent.click(screen.getByText("Déconnecter"));

    await waitFor(() => expect(revoquer).toHaveBeenCalledWith(["AILLEURS"], "mon-mot-de-passe"));
    // La liste est relue : laisser l'appareil révoqué à l'écran ferait douter que le
    // geste ait eu lieu.
    await waitFor(() => expect(appareils).toHaveBeenCalledTimes(2));
  });

  it("un refus du serveur se dit, la liste ne prétend pas que c'est fait", async () => {
    // Interdit n°13 : une révocation qu'on croit faite et qui ne l'est pas est pire que
    // pas de bouton du tout.
    const revoquer = vi.fn(async () => {
      throw Object.assign(new Error("Forbidden"), { errcode: "M_FORBIDDEN" });
    });
    const { session } = avecAppareils(revoquer);
    render(<Appareils session={session} />);

    await waitFor(() => expect(screen.getByText("Déconnecter")).toBeTruthy());
    fireEvent.click(screen.getByText("Déconnecter"));
    await waitFor(() => expect(screen.getByText("Déconnecter cet appareil ?")).toBeTruthy());
    fireEvent.click(screen.getByText("Déconnecter"));

    await waitFor(() => expect(screen.getByText("Mot de passe incorrect.")).toBeTruthy());
  });

  it("le réglage est atteignable depuis les réglages, à côté du mot de passe", async () => {
    /*
     * Les deux gestes se cherchent au même moment — quand on soupçonne que quelqu'un
     * d'autre est entré. Changer son mot de passe sans pouvoir fermer les sessions
     * ouvertes ne reprend rien du tout.
     */
    rendreAvecSession(<Reglages />);
    await waitFor(() => expect(screen.getByText("Appareils")).toBeTruthy());
    expect(screen.getByText("Voir et déconnecter vos sessions")).toBeTruthy();
  });
});
