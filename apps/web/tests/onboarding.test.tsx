import type { RecoveryState, Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IosPushEducation } from "../components/onboarding/IosPushEducation";
import { ETAPES } from "../components/onboarding/etapes";
import { LogoutButton } from "../components/onboarding/LogoutButton";
import { RecoveryGate } from "../components/onboarding/RecoveryGate";
import { SessionProvider } from "../components/onboarding/SessionProvider";
import { contactsDeLaSession } from "../lib/contacts";
import { NOM_NOTES } from "../lib/premiere-conversation";
import { routeConversation } from "../lib/routes";
import { ecrireOnboardingEnCours, ecrireRefusEducationIOS } from "../lib/preferences";

const pousser = vi.fn();
/** L'URL sous le parcours. La porte remplace le contenu sans naviguer : elle survit. */
let chemin = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => chemin,
  useRouter: () => ({ push: pousser, back: vi.fn() }),
}));

/**
 * Les paquets 04–10 sont mockés à leurs interfaces. Ce fichier en voit plus
 * qu'avant : le parcours d'accueil traverse le profil, la création de la
 * conversation personnelle et la chaîne push.
 */
const profil = vi.fn(async (_session: unknown, userId: string) => ({
  userId,
  displayName: "Mira",
  avatarUrl: "mxc://tacita.test/avatar",
  bannerUrl: "mxc://tacita.test/banniere",
}));
const updateProfile = vi.fn(async () => {});
const listees = vi.fn(() => [] as { roomId: string; peerId?: string; name: string }[]);
const createGroupChat = vi.fn(async () => ({ room_id: "!notes:tacita.test" }));
const registerDirect = vi.fn(async () => {});
const poserImagesParDefaut = vi.fn(async () => {});
vi.mock("@tacita/messaging", () => ({
  profileOf: (...args: unknown[]) => profil(...(args as [unknown, string])),
  updateProfile: (...args: unknown[]) => updateProfile(...(args as [])),
  conversations: () => listees(),
  createGroupChat: (...args: unknown[]) => createGroupChat(...(args as [])),
  registerDirect: (...args: unknown[]) => registerDirect(...(args as [])),
  poserImagesParDefaut: (...args: unknown[]) => poserImagesParDefaut(...(args as [])),
  TAILLE_IDENTITE: 512,
  // Lues par `lib/push.ts`, que la chaîne des notifications importe.
  mentionCandidates: () => [],
  messages: () => [],
  messageText: () => "",
  invitations: () => [],
  subscribeConversations: () => () => {},
  ignoredUsers: () => [],
  ignoreUser: vi.fn(),
  unignoreUser: vi.fn(),
  acceptInvitation: vi.fn(),
  leaveConversation: vi.fn(),
  openDirectMessage: vi.fn(),
}));
vi.mock("@tacita/media-pipeline", () => ({
  uploadPublicProfileImage: vi.fn(async () => "mxc://tacita.test/choisie"),
  downloadPublicImage: vi.fn(async () => new Blob()),
}));

const HOMESERVER = "https://chat.tacita.test";
const MOI = "@moi:tacita.test";

const initSession = vi.fn<() => Promise<Session>>();
const restoreSession = vi.fn<() => Promise<Session | null>>();
const creerCompte = vi.fn<() => Promise<Session>>();
const connexionParCle = vi.fn<(config: { identifiant: string; cleRecuperation: string }) => Promise<Session>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: () => initSession(),
  restoreSession: () => restoreSession(),
  creerCompte: () => creerCompte(),
  connexionParCle: (config: { identifiant: string; cleRecuperation: string }) =>
    connexionParCle(config),
}));

/**
 * `asSession` de `client-core/testing` plutôt qu'un `as unknown as Session` : un membre
 * ajouté au contrat de `Session` doit casser la compilation d'un seul fichier, pas
 * disparaître en `undefined is not a function` à l'exécution.
 */
function fausseSession(options: { recuperation?: RecoveryState } = {}) {
  const setupRecoveryKey = vi.fn(
    async (_options?: {
      reinitialiser?: boolean;
      demanderMotDePasse?: () => Promise<string>;
    }) => ({
      encodedPrivateKey: "EsTb ABCD EFGH IJKL",
      privateKey: new Uint8Array(32),
    }),
  );
  const unlockRecovery = vi.fn(async (_cle: string) => {});
  const logout = vi.fn(async () => {});
  const session = asSession({
    // `client` est un faux assumé : exiger un vrai `MatrixClient` demanderait 357
    // propriétés.
    client: { getUserId: () => MOI, on: vi.fn(), off: vi.fn() },
    recoveryState: vi.fn(async () => options.recuperation ?? "prete"),
    setupRecoveryKey,
    unlockRecovery,
    logout,
  });
  return { session, setupRecoveryKey, unlockRecovery, logout };
}

const rediriger = vi.fn();

const monter = (
  session: Session | null,
  enfant = <p>Conversations</p>,
  indexedDB = new IDBFactory(),
) => {
  restoreSession.mockResolvedValue(session);
  return render(
    <SessionProvider homeserverUrl={HOMESERVER} indexedDB={indexedDB}>
      <RecoveryGate>{enfant}</RecoveryGate>
    </SessionProvider>,
  );
};

/** franchir l'étape bloquante, qui est la première du parcours. */
const franchirLaCle = async () => {
  await waitFor(() => expect(screen.getByText("Continuer")).toBeTruthy());
  fireEvent.click(screen.getByText("Continuer"));
  await waitFor(() => expect(screen.getByText("J'ai sauvegardé ma clé")).toBeTruthy());
  fireEvent.click(screen.getByText("J'ai sauvegardé ma clé"));
};

beforeEach(() => {
  globalThis.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  // `restoreAllMocks` et non `clearAllMocks` : les espions posés sur `navigator` et
  // `matchMedia` par les tests iOS survivraient au fichier et casseraient les suivants.
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  initSession.mockReset();
  restoreSession.mockReset();
  creerCompte.mockReset();
  connexionParCle.mockReset();
  rediriger.mockReset();
  pousser.mockReset();
  chemin = "/";
  listees.mockReturnValue([]);
  createGroupChat.mockClear();
  registerDirect.mockClear();
  updateProfile.mockClear();
});

describe("l'étape de clé de récupération est bloquante", () => {
  it("tant que la récupération est requise, aucun contenu d'app n'est rendu", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Votre clé de récupération")).toBeTruthy());
    // Le contenu demandé n'est pas caché : il n'est pas rendu du tout.
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("elle ne se contourne pas par l'URL : ce n'est pas une route, c'est le shell", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    // Quelle que soit l'adresse demandée, c'est l'étape qui rend.
    globalThis.history.replaceState(null, "", "/c/!salon:tacita.test");
    monter(session, <p>Conversations</p>);

    await waitFor(() => expect(screen.getByText("Votre clé de récupération")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("la clé est affichée une fois, et la confirmation libère l'accès", async () => {
    const { session, setupRecoveryKey } = fausseSession({ recuperation: "creation" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Continuer")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer"));

    // La clé est rendue en groupes de quatre sur une grille — ce qui se transcrit à la
    // main sans perdre sa place. On lit donc le bloc entier, pas un nœud de texte : c'est
    // aussi ce qui prouve qu'aucun groupe ne manque.
    await waitFor(() => expect(screen.getByTestId("cle-de-recuperation")).toBeTruthy());
    expect(screen.getByTestId("cle-de-recuperation").textContent).toBe("EsTbABCDEFGHIJKL");
    expect(setupRecoveryKey).toHaveBeenCalledTimes(1);
    // La promesse est tenue telle qu'elle est faite : elle ne sera plus affichée.
    expect(screen.getByText(/ne sera plus affichée/)).toBeTruthy();

    /*
     * La confirmation ne rend plus l'app : elle rend l'étape suivante du parcours
     * Ce qu'elle libère est le chiffrement, pas la porte — et la porte reste
     * fermée jusqu'au bout du parcours, qui se termine dans une conversation ouverte.
     */
    fireEvent.click(screen.getByText("J'ai sauvegardé ma clé"));
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("dit la vérité sur ce qu'on perd sans la clé", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    // Interdit n°13 : la limite se documente là où elle se joue, pas dans une note.
    await waitFor(() => expect(screen.getByText(/définitivement perdu/)).toBeTruthy());
    expect(screen.getByText(/personne, chez nous, ne peut le récupérer/)).toBeTruthy();
  });

  it("« en savoir plus » sort dans un onglet neuf, sans quitter l'étape", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    // L'étape bloque toute l'app : une navigation dans le même onglet la détruirait, et
    // le retour rejouerait le montage de session. `noopener` parce que la page ouverte
    // garderait sinon une poignée sur celle-ci.
    const lien = await screen.findByRole("link", { name: /En savoir plus/ });
    expect(lien.getAttribute("target")).toBe("_blank");
    expect(lien.getAttribute("rel")).toContain("noopener");
    expect(lien.getAttribute("href")).toBe(
      "https://www.google.com/search?q=a+quoi+sert+une+cle+de+recuperation",
    );
  });

  it("hors contexte sécurisé, l'échec est nommé — pas « réessayez »", async () => {
    // Interdit n°13 : `crypto.subtle` n'existe pas hors `https`/`localhost`, donc la clé
    // ne pourra jamais être créée à cette adresse. Inviter à réessayer serait faux.
    const { session, setupRecoveryKey } = fausseSession({ recuperation: "creation" });
    setupRecoveryKey.mockRejectedValueOnce(new TypeError("crypto.subtle is undefined"));
    // `stubGlobal` et non `spyOn` : jsdom ne définit pas `isSecureContext`, il n'y a donc
    // aucun accesseur à espionner. Le défaut `undefined` reste traité comme « je ne sais
    // pas » — seul un `false` explicite nomme l'origine.
    vi.stubGlobal("isSecureContext", false);
    monter(session);

    await waitFor(() => expect(screen.getByText("Continuer")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer"));

    await waitFor(() => expect(screen.getByText(/adresse non sécurisée/)).toBeTruthy());
    expect(screen.queryByText(/Vérifiez votre connexion/)).toBeNull();
  });

  it("la connexion est un formulaire du produit, plus une redirection", async () => {
    /*
     * D-12 : Keycloak supprimé, Synapse porte l'identité. Les deux tests qui
     * vivaient ici gardaient la forme de l'URL de redirection SSO et la barre finale que
     * `sso.client_whitelist` exigeait — il n'y a plus ni redirection ni whitelist.
     */
    monter(null);

    await waitFor(() => expect(screen.getByText("Connectez-vous")).toBeTruthy());
    expect(screen.getByLabelText("Identifiant")).toBeTruthy();
    expect(screen.getByLabelText("Mot de passe")).toBeTruthy();
  });
});

describe("reprise de session, connexion, déconnexion", () => {
  it("une session valide arrive directement sur le contenu", async () => {
    const { session } = fausseSession();
    monter(session);

    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
    expect(screen.queryByText("Connectez-vous")).toBeNull();
  });

  it("sans session restaurable, la porte rend le formulaire", async () => {
    monter(null);

    await waitFor(() => expect(screen.getByText("Connectez-vous")).toBeTruthy());
    // Et rien du contenu de l'app derrière : la porte remplace, elle ne superpose pas.
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("un jeton révoqué ramène au formulaire, sans rien journaliser", async () => {
    restoreSession.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));
    const journal = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SessionProvider homeserverUrl={HOMESERVER}>
        <RecoveryGate>
          <p>Conversations</p>
        </RecoveryGate>
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByText("Connectez-vous")).toBeTruthy());
    // Le message d'erreur du SDK peut porter l'identifiant : il ne sort jamais.
    expect(journal).not.toHaveBeenCalled();
    journal.mockRestore();
  });

  it("une reprise qui reste pendante ne bloque pas : au bout du délai, on peut réessayer", async () => {
    // Seul `setTimeout` est simulé : fake-indexeddb, que `etatDe` traverse, a besoin des autres.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // Le cas iOS : une connexion IndexedDB laissée pendante après suspension — la
      // promesse ne se résout ni ne rejette, et aucune branche d'erreur n'est atteinte.
      restoreSession.mockReturnValue(new Promise<Session | null>(() => {}));
      render(
        <SessionProvider homeserverUrl={HOMESERVER} indexedDB={new IDBFactory()}>
          <RecoveryGate>
            <p>Conversations</p>
          </RecoveryGate>
        </SessionProvider>,
      );

      await act(() => vi.advanceTimersByTimeAsync(19_000));
      expect(screen.queryByText("Réessayer")).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(screen.getByText("Réessayer")).toBeTruthy();

      restoreSession.mockResolvedValue(fausseSession().session);
      fireEvent.click(screen.getByText("Réessayer"));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
  });

  it("la déconnexion n'efface qu'après confirmation, et dit ce qu'elle efface", async () => {
    const { session, logout } = fausseSession();
    render(
      <SessionProvider homeserverUrl={HOMESERVER}>
        <LogoutButton session={session} />
      </SessionProvider>,
    );

    // `<dialog>` garde son contenu dans le DOM même fermé : le déclencheur est le
    // premier des deux boutons portant ce libellé, la confirmation le dernier.
    fireEvent.click(screen.getAllByText("Se déconnecter")[0]!);
    await waitFor(() => expect(screen.getByText("Vos messages déjà déchiffrés")).toBeTruthy());
    expect(screen.getByText("Les messages en attente d'envoi")).toBeTruthy();
    // Rien n'a encore été effacé : la confirmation n'est pas décorative.
    expect(logout).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText("Se déconnecter").at(-1)!);
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it("se déconnecter ne navigue nulle part : il n'y a plus de session ailleurs", async () => {
    /*
     * **Le défaut remonté, fermé par soustraction.** `logout()` révoquait le
     * jeton Matrix, mais le cookie de session Keycloak y survivait : le retour vers
     * `/login/sso/redirect` le présentait à `auth-cookie`, qui rouvrait une session dans la
     * seconde — sur un `device_id` neuf, donc non signé, donc sur l'écran de clé de
     * récupération. D-12 supprime le fournisseur : il n'y a plus de session à fermer
     * ailleurs, et plus de navigation qui puisse en rouvrir une.
     */
    // jsdom refuse de redéfinir `location.assign` : on garde l'URL de départ et on
    // vérifie qu'elle n'a pas bougé. C'est la même chose vue de l'autre côté.
    const urlAvant = globalThis.location.href;
    const { session, logout } = fausseSession();
    monter(session, <LogoutButton session={session} />);

    await waitFor(() => expect(screen.getAllByText("Se déconnecter")[0]).toBeTruthy());
    fireEvent.click(screen.getAllByText("Se déconnecter")[0]!);
    await waitFor(() => expect(screen.getByText("Vos messages déjà déchiffrés")).toBeTruthy());
    fireEvent.click(screen.getAllByText("Se déconnecter").at(-1)!);

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    // La porte reprend la main sur le formulaire, sans que le navigateur ait bougé.
    await waitFor(() => expect(screen.getByText("Connectez-vous")).toBeTruthy());
    expect(globalThis.location.href).toBe(urlAvant);
  });
});

describe("éducation iOS, au bon moment et une seule fois", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";

  const simuler = (userAgent: string, standalone: boolean) => {
    vi.spyOn(globalThis.navigator, "userAgent", "get").mockReturnValue(userAgent);
    // Une `MediaQueryList` réduite à `matches` ne suffit pas : Astryx s'abonne aux
    // changements, et un objet sans `addEventListener` fait lever le rendu.
    vi.spyOn(globalThis, "matchMedia").mockReturnValue({
      matches: standalone,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as MediaQueryList);
  };

  it("s'affiche sur iOS hors écran d'accueil, au point de friction", async () => {
    simuler(IPHONE, false);
    render(<IosPushEducation declenche indexedDB={new IDBFactory()} />);

    await waitFor(() => expect(screen.getByText(/écran/)).toBeTruthy());
    expect(screen.getByText(/contrainte de Safari/)).toBeTruthy();
  });

  it("ne s'affiche pas au premier lancement, tant que rien ne le déclenche", async () => {
    simuler(IPHONE, false);
    const { container } = render(<IosPushEducation declenche={false} indexedDB={new IDBFactory()} />);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.textContent).toBe("");
  });

  it("ne s'affiche ni en PWA installée, ni hors iOS", async () => {
    simuler(IPHONE, true);
    const { container: installee } = render(<IosPushEducation declenche indexedDB={new IDBFactory()} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(installee.textContent).toBe("");

    cleanup();
    simuler("Mozilla/5.0 (Linux; Android 14)", false);
    const { container: android } = render(<IosPushEducation declenche indexedDB={new IDBFactory()} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(android.textContent).toBe("");
  });

  it("après un refus explicite, il n'est jamais re-présenté", async () => {
    simuler(IPHONE, false);
    const indexedDB = new IDBFactory();
    await ecrireRefusEducationIOS(indexedDB);

    const { container } = render(<IosPushEducation declenche indexedDB={indexedDB} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(container.textContent).toBe("");
  });
});

describe("à la reconnexion, la porte demande la clé, elle n'en refait pas une", () => {
  const saisir = (valeur: string) =>
    fireEvent.change(screen.getByLabelText(/Clé de récupération/), { target: { value: valeur } });

  it("un appareil neuf sur un compte qui a sa clé : on la demande, on ne propose pas d'en créer une", async () => {
    // Le défaut réparé. Chaque `m.login.token` donne un `device_id` neuf, donc un
    // appareil non signé : l'écran de création s'ouvrait devant quelqu'un qui avait sa
    // clé depuis des mois, et son seul bouton aurait écrasé la sauvegarde du compte.
    const { session } = fausseSession({ recuperation: "deverrouillage" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Entrez votre clé de récupération")).toBeTruthy());
    expect(screen.queryByText("Votre clé de récupération")).toBeNull();
    expect(screen.queryByText("Continuer")).toBeNull();
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("la clé saisie déverrouille l'appareil et libère l'accès", async () => {
    const { session, unlockRecovery } = fausseSession({ recuperation: "deverrouillage" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Déverrouiller")).toBeTruthy());
    saisir("EsTb ABCD EFGH");
    fireEvent.click(screen.getByText("Déverrouiller"));

    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
    expect(unlockRecovery).toHaveBeenCalledWith("EsTb ABCD EFGH");
  });

  it("une clé refusée le dit sur le champ, et n'ouvre rien", async () => {
    // Interdit n°13 : une saisie fausse acceptée en silence débloquerait l'UI devant un
    // client qui ne déchiffrera jamais rien.
    const { session, unlockRecovery } = fausseSession({ recuperation: "deverrouillage" });
    unlockRecovery.mockRejectedValueOnce(new Error("clé de récupération incorrecte"));
    monter(session);

    await waitFor(() => expect(screen.getByText("Déverrouiller")).toBeTruthy());
    saisir("EsTb ZZZZ ZZZZ");
    fireEvent.click(screen.getByText("Déverrouiller"));

    await waitFor(() => expect(screen.getByText(/ne correspond pas à ce compte/)).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("une panne ne se dit pas comme une clé fausse", async () => {
    // La différence est utile : une clé refusée se corrige en la retapant, une panne non.
    const { session, unlockRecovery } = fausseSession({ recuperation: "deverrouillage" });
    unlockRecovery.mockRejectedValueOnce(new Error("Failed to fetch"));
    const { container } = monter(session);

    await waitFor(() => expect(screen.getByText("Déverrouiller")).toBeTruthy());
    saisir("EsTb ABCD EFGH");
    fireEvent.click(screen.getByText("Déverrouiller"));

    await waitFor(() => expect(screen.getByText(/Vérifiez votre connexion/)).toBeTruthy());
    // `container` et non `screen` : Astryx pose sa région `aria-live` sur `document.body`,
    // hors de l'arbre rendu, et elle garde l'annonce du test précédent.
    expect(within(container).queryByText(/ne correspond pas à ce compte/)).toBeNull();
  });

  it("« je n'ai plus ma clé » dit ce qu'il détruit avant de le faire", async () => {
    const { session, setupRecoveryKey } = fausseSession({ recuperation: "deverrouillage" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Je n'ai plus ma clé")).toBeTruthy());
    fireEvent.click(screen.getByText("Je n'ai plus ma clé"));

    // Rien n'est encore détruit : l'écran annonce, il n'agit pas.
    await waitFor(() => expect(screen.getByText("Repartir d'une clé neuve")).toBeTruthy());
    expect(screen.getByText(/ni vous, ni nous ne pourrons plus les lire/)).toBeTruthy();
    expect(setupRecoveryKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Créer une nouvelle clé"));
    await waitFor(() =>
      expect(setupRecoveryKey).toHaveBeenCalledWith(
        expect.objectContaining({ reinitialiser: true }),
      ),
    );
  });

  /*
   * La ré-authentification que Synapse exige pour **remplacer** une identité cross-signing
   * (v1.155.0 : le premier dépôt passe sans UIA, pas le second). Sans mot de passe natif
   * elle se joue chez Keycloak, dans une fenêtre, et se termine par un
   * `postMessage` de la page de repli du serveur.
   *
   * Le défaut : rien de tout ça n'existait. L'écran appelait, prenait un 401
   * en pleine figure et affichait « vérifiez votre connexion » — alors que la connexion
   * n'y était pour rien et que la sauvegarde venait d'être remplacée.
   */
  /**
   * Le rappel de ré-authentification, tel que `setupRecoveryKey` l'appelle quand le
   * serveur redemande le mot de passe — c'est-à-dire après un rechargement de page, la
   * session n'ayant alors plus le mot de passe en mémoire.
   */
  const exigeLeMotDePasse = (
    setupRecoveryKey: ReturnType<typeof fausseSession>["setupRecoveryKey"],
    recu: string[],
  ) =>
    setupRecoveryKey.mockImplementation(async (options) => {
      const motDePasse = await options?.demanderMotDePasse?.();
      if (motDePasse) recu.push(motDePasse);
      return { encodedPrivateKey: "EsTb ABCD EFGH IJKL", privateKey: new Uint8Array(32) };
    });

  const jusquAuRemplacement = async (setupRecoveryKey: ReturnType<typeof fausseSession>["setupRecoveryKey"]) => {
    await waitFor(() => expect(screen.getByText("Je n'ai plus ma clé")).toBeTruthy());
    fireEvent.click(screen.getByText("Je n'ai plus ma clé"));
    await waitFor(() => expect(screen.getByText("Repartir d'une clé neuve")).toBeTruthy());
    fireEvent.click(screen.getByText("Créer une nouvelle clé"));
    await waitFor(() => expect(setupRecoveryKey).toHaveBeenCalled());
  };

  it("quand le compte exige une reconnexion, le mot de passe est demandé sur place", async () => {
    /*
     * **L'écran servait une page de repli SSO jusqu'au 25/08/2026**, et le SSO a été
     * supprimé le matin même : le chemin « j'ai perdu ma clé » échouait donc sur
     * un 401 brut. Le serveur demande maintenant un mot de passe, et il se saisit ici —
     * plus de fenêtre à ouvrir, donc plus de pop-up à faire bloquer.
     */
    const { session, setupRecoveryKey } = fausseSession({ recuperation: "deverrouillage" });
    const recu: string[] = [];
    exigeLeMotDePasse(setupRecoveryKey, recu);

    monter(session);
    await jusquAuRemplacement(setupRecoveryKey);

    await waitFor(() => expect(screen.getByText("Confirmez que c'est bien vous")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "mon-mot-de-passe" },
    });
    fireEvent.click(screen.getByText("Confirmer"));

    await waitFor(() => expect(screen.getByText("Notez cette clé maintenant")).toBeTruthy());
    expect(recu).toEqual(["mon-mot-de-passe"]);
  });

  it("annuler la reconnexion le dit sans mentir sur ce qui reste à faire", async () => {
    // À cet instant la sauvegarde a déjà été remplacée côté serveur, mais pas l'identité :
    // « réessayez plus tard » laisserait croire à une session utilisable (interdit n°13).
    const { session, setupRecoveryKey } = fausseSession({ recuperation: "deverrouillage" });
    exigeLeMotDePasse(setupRecoveryKey, []);

    monter(session);
    await jusquAuRemplacement(setupRecoveryKey);

    await waitFor(() => expect(screen.getByText("Confirmez que c'est bien vous")).toBeTruthy());
    fireEvent.click(screen.getByText("Annuler"));

    await waitFor(() => expect(screen.getByText("L'étape n'est pas terminée")).toBeTruthy());
    expect(screen.getByText(/n'est pas active et cet appareil ne peut toujours pas chiffrer/)).toBeTruthy();
    // L'écran de remplacement est toujours là, prêt à reprendre.
    expect(screen.getByText("Créer une nouvelle clé")).toBeTruthy();
  });

  it("hors ligne, un appareil déjà signé n'a plus rien à prouver : tient", async () => {
    // Mesuré au navigateur : sans réseau, « une sauvegarde est-elle
    // active ? » rendait `true` pour un compte parfaitement configuré, et la porte —
    // qui *remplace* l'app — emportait l'historique promis consultable. `recoveryState()`
    // lit le magasin crypto local : la trace `recuperation-faite` n'a plus lieu d'être.
    const { session } = fausseSession({ recuperation: "prete" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
    expect(screen.queryByText("Entrez votre clé de récupération")).toBeNull();
  });
});

describe("le parcours d'accueil, de la clé au premier message", () => {
  it("enchaîne ses étapes et n'ouvre l'application qu'à la fin", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    // 1 — la clé. Bloquante : c'est elle qui rend le chiffrement possible.
    await franchirLaCle();

    // 2 — l'identité, dessinée pendant que l'écran se monte.
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    expect(poserImagesParDefaut).toHaveBeenCalled();
    fireEvent.click(screen.getByText("Continuer"));

    // 3 — les notifications, avec l'écran des réglages lui-même (M-H).
    await waitFor(() => expect(screen.getByText("Ne ratez pas un message")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer"));

    // 4 — la conversation, et l'application est toujours fermée derrière.
    await waitFor(() => expect(screen.getByText("Écrivez votre premier message")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();

    fireEvent.click(screen.getByText("Ouvrir et écrire"));
    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
    expect(pousser).toHaveBeenCalledWith(routeConversation("!notes:tacita.test"));
  });

  /**
   * **Un compte créé depuis un lien d'invitation ne perd pas le lien.** La porte
   * *remplace* le contenu sans naviguer, donc l'URL du lien est encore là sous le
   * parcours — et c'est le seul endroit où le token existe : rien ne le mémorise. La
   * dernière étape naviguait vers la conversation personnelle, ce qui le jetait, et un
   * lien à usage unique valable un jour ne se retrouve pas. C'est exactement le parcours
   * que D-13 a ouvert en supprimant le code d'invitation.
   */
  it("créé depuis une invitation, le parcours la rend au lieu de naviguer ailleurs", async () => {
    chemin = "/i/jeton-opaque";
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    await franchirLaCle();
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer"));
    await waitFor(() => expect(screen.getByText("Ne ratez pas un message")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer"));

    // Le bouton dit où il mène : « Ouvrir et écrire » promettrait la conversation
    // personnelle, qui n'est pas la destination (interdit n°13).
    await waitFor(() => expect(screen.getByText("Continuer vers l'invitation")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer vers l'invitation"));

    // Le parcours est terminé — l'application est ouverte — et l'URL n'a pas bougé.
    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
    expect(pousser).not.toHaveBeenCalled();
    // Le salon personnel est créé quand même : seule la destination du dernier saut change.
    expect(createGroupChat).toHaveBeenCalled();
  });

  it("dit à chaque écran où l'on en est, et sur combien", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    // Le total vient de la liste, pas d'un nombre écrit dans l'indicateur : une étape
    // ajoutée sans que le compte suive donnerait « étape 4 sur 3 ».
    await waitFor(() =>
      expect(screen.getByText(`Étape 1 sur ${ETAPES.length}`)).toBeTruthy(),
    );
    await franchirLaCle();
    await waitFor(() =>
      expect(screen.getByText(`Étape 2 sur ${ETAPES.length}`)).toBeTruthy(),
    );
  });

  it("ce qui est facultatif se passe ; ce qui bloque n'offre aucune sortie", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);

    // L'étape de la clé n'a pas de « passer » : elle n'est ni sautable, ni différable.
    await waitFor(() => expect(screen.getByText("Votre clé de récupération")).toBeTruthy());
    expect(screen.queryByText("Passer")).toBeNull();

    await franchirLaCle();
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());

    // Passer l'identité n'écrit rien : c'est ce qui distingue « passer » de « continuer ».
    fireEvent.click(screen.getByText("Passer"));
    await waitFor(() => expect(screen.getByText("Ne ratez pas un message")).toBeTruthy());
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it("une étape qui prépare quelque chose le montre, sans spinner plein écran", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    // Le dessin des images ne rend jamais la main : l'écran doit dire qu'il travaille.
    poserImagesParDefaut.mockImplementationOnce(() => new Promise(() => {}));
    monter(session);
    await franchirLaCle();

    await waitFor(() => expect(screen.getByText("Création de votre identité…")).toBeTruthy());
    // La progression reste lisible au-dessus : l'attente est localisée (DESIGN.md).
    expect(screen.getByText(`Étape 2 sur ${ETAPES.length}`)).toBeTruthy();
    expect(screen.queryByText("Voici votre identité")).toBeNull();
  });

  it("ne se contourne pas par l'URL : ce n'est pas une route, c'est le shell", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    globalThis.history.replaceState(null, "", "/c?room=!salon:tacita.test");
    monter(session);

    await franchirLaCle();
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("un rechargement au milieu du parcours le reprend, il ne le perd pas", async () => {
    // Le compte a sa clé (l'étape est franchie), et la marque dit que le parcours court
    // encore. Sans elle, ce rechargement tomberait sur une application vide.
    const indexedDB = new IDBFactory();
    await ecrireOnboardingEnCours(indexedDB, true);
    const { session } = fausseSession({ recuperation: "prete" });
    monter(session, <p>Conversations</p>, indexedDB);

    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("une reconnexion sur un compte existant ne rejoue pas le parcours", async () => {
    // `deverrouillage` : la personne a déjà un profil, des réglages et des conversations.
    // Lui rejouer le parcours serait lui redemander ce qu'elle a déjà répondu.
    const { session } = fausseSession({ recuperation: "deverrouillage" });
    monter(session);

    await waitFor(() => expect(screen.getByText("Entrez votre clé de récupération")).toBeTruthy());
    expect(screen.queryByText(/Étape 1 sur/)).toBeNull();
  });

  /*
   * **Le défaut remonté, et la raison pour laquelle `mode` ne suffit pas.**
   *
   * Une inscription interrompue au dépôt de l'identité laisse la marque posée et repart en
   * `deverrouillage` : la personne recrée sa clé, et le parcours décidait alors sur le seul
   * `mode`. Verdict `deverrouillage` ⇒ pas de parcours ⇒ accueil d'une application vide,
   * au beau milieu de sa propre inscription.
   *
   * La marque est la seule chose qui sache où l'on en était. Elle décide donc avec `mode`,
   * pas après lui.
   */
  it("une clé recréée au milieu d'une inscription reprend le parcours, pas l'accueil", async () => {
    const indexedDB = new IDBFactory();
    await ecrireOnboardingEnCours(indexedDB, true);
    const { session } = fausseSession({ recuperation: "deverrouillage" });
    monter(session, <p>Conversations</p>, indexedDB);

    // « Je n'ai plus ma clé » bascule sur l'écran de création, en réinitialisation —
    // dont le bouton principal dit ce qu'il détruit, d'où le libellé propre à ce mode.
    await waitFor(() => expect(screen.getByText("Je n'ai plus ma clé")).toBeTruthy());
    fireEvent.click(screen.getByText("Je n'ai plus ma clé"));
    await waitFor(() => expect(screen.getByText("Créer une nouvelle clé")).toBeTruthy());
    fireEvent.click(screen.getByText("Créer une nouvelle clé"));
    await waitFor(() => expect(screen.getByText("J'ai sauvegardé ma clé")).toBeTruthy());
    fireEvent.click(screen.getByText("J'ai sauvegardé ma clé"));

    // On reprend le parcours là où il en était, et surtout pas sur l'app.
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("la liste des étapes est la seule source : en retirer une retire son écran", async () => {
    // La modularité, prouvée plutôt qu'affirmée : le parcours ne connaît aucune étape en
    // dur, ni pour les afficher, ni pour les compter.
    const cles = ETAPES.map((etape) => etape.cle);
    expect(cles).toEqual([
      "cle-de-recuperation",
      "identite",
      "notifications",
      "premiere-conversation",
    ]);

    const { Onboarding } = await import("../components/onboarding/Onboarding");
    const { session } = fausseSession();
    render(
      <SessionProvider homeserverUrl={HOMESERVER} indexedDB={new IDBFactory()}>
        <Onboarding
          session={session}
          depart={0}
          indexedDB={new IDBFactory()}
          etapes={[
            { cle: "seule", Contenu: () => <p>Une seule étape</p> },
          ]}
        />
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getByText("Une seule étape")).toBeTruthy());
    expect(screen.getByText("Étape 1 sur 1")).toBeTruthy();
  });
});

describe("la première conversation, pour que l'application ne s'ouvre pas vide", () => {
  const allerAuBout = async () => {
    await franchirLaCle();
    await waitFor(() => expect(screen.getByText("Voici votre identité")).toBeTruthy());
    fireEvent.click(screen.getByText("Passer"));
    await waitFor(() => expect(screen.getByText("Ne ratez pas un message")).toBeTruthy());
    fireEvent.click(screen.getByText("Continuer"));
  };

  it("ouvre un salon chiffré à soi, inscrit comme conversation et non comme groupe", async () => {
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);
    await allerAuBout();

    await waitFor(() => expect(createGroupChat).toHaveBeenCalledWith(session, NOM_NOTES));
    // `m.direct` sous son propre identifiant : c'est ce qui la fait lire comme une
    // conversation — nom, avatar, et « c'est le début de votre conversation ».
    expect(registerDirect).toHaveBeenCalledWith(session, MOI, "!notes:tacita.test");
  });

  it("jamais deux fois : un salon à soi qui existe est celui qu'on rouvre", async () => {
    listees.mockReturnValue([
      { roomId: "!deja:tacita.test", peerId: MOI, name: NOM_NOTES },
    ]);
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);
    await allerAuBout();

    await waitFor(() => expect(screen.getByText("Ouvrir et écrire")).toBeTruthy());
    expect(createGroupChat).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Ouvrir et écrire"));
    expect(pousser).toHaveBeenCalledWith(routeConversation("!deja:tacita.test"));
  });

  it("si la création échoue, on entre quand même — et on le dit", async () => {
    // Interdit n°13 : un bouton « ouvrir » sans salon à ouvrir serait un bouton mort.
    createGroupChat.mockRejectedValueOnce(new Error("réseau"));
    const { session } = fausseSession({ recuperation: "creation" });
    monter(session);
    await allerAuBout();

    await waitFor(() =>
      expect(screen.getByText("La conversation n'a pas pu être créée")).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("Entrer dans l'application"));
    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
  });

  it("on n'est pas son propre ami : la conversation à soi n'entre pas dans la liste", async () => {
    listees.mockReturnValue([
      { roomId: "!notes:tacita.test", peerId: MOI, name: NOM_NOTES },
      { roomId: "!dm:tacita.test", peerId: "@mira:tacita.test", name: "Mira" },
    ]);
    const { session } = fausseSession();

    expect(contactsDeLaSession(session).lister()).toEqual([
      { userId: "@mira:tacita.test", nom: "Mira" },
    ]);
  });
});

describe("l'écran de connexion dit ce que le serveur a fait, pas autre chose", () => {
  /*
   * **Défaut vécu, juste après D-13.** Le serveur tournait encore sur sa
   * configuration d'avant et redemandait un code d'invitation ; l'écran affichait « Le
   * serveur n'a pas répondu. Réessayez. » Il avait répondu, et réessayer ne pouvait rien
   * donner. La cause était à la jonction : le 401 d'une UIA n'a pas d'`errcode`, donc il
   * tombait dans le fourre-tout réseau.
   *
   * Ce test est le site de lecture de l'`errcode` que `creerCompte` pose (règle 7) : sans
   * lui, les deux moitiés du correctif peuvent se désaccorder en silence.
   */
  const remplirEtCreer = async () => {
    monter(null);
    await waitFor(() => expect(screen.getByText("Créer un compte")).toBeTruthy());
    fireEvent.click(screen.getByText("Créer un compte"));

    fireEvent.change(screen.getByLabelText("Identifiant"), { target: { value: "mira" } });
    // Douze caractères au moins : le plancher de vaut aussi pour les tests,
    // sinon ils prouvent le refus du garde et rien du chemin qu'ils visent.
    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "un-mot-de-passe-assez-long" },
    });
    fireEvent.click(screen.getByText("Créer mon compte"));
  };

  it("un mot de passe trop court est refusé avant d'être envoyé", async () => {
    /*
     * **Mesuré : un compte s'était créé avec le mot de passe « a ».** Le
     * plancher existait dans le module de changement et dans son écran — c'est-à-dire
     * partout sauf là où le compte naît. Depuis, ce mot de passe *est* la clé qui
     * déchiffre l'historique.
     *
     * Le garde opposable est celui de Synapse ; celui-ci rend la faute immédiate et
     * évite d'envoyer un mot de passe pour se faire refuser.
     */
    monter(null);
    await waitFor(() => expect(screen.getByText("Créer un compte")).toBeTruthy());
    fireEvent.click(screen.getByText("Créer un compte"));

    fireEvent.change(screen.getByLabelText("Identifiant"), { target: { value: "mira" } });
    fireEvent.change(screen.getByLabelText("Mot de passe"), { target: { value: "court" } });
    fireEvent.click(screen.getByText("Créer mon compte"));

    await waitFor(() =>
      expect(
        screen.getByText("Choisissez un mot de passe d'au moins 12 caractères."),
      ).toBeTruthy(),
    );
    expect(creerCompte).not.toHaveBeenCalled();
  });

  it("aucun code d'invitation n'est demandé", async () => {
    monter(null);
    await waitFor(() => expect(screen.getByText("Créer un compte")).toBeTruthy());
    fireEvent.click(screen.getByText("Créer un compte"));

    expect(screen.queryByLabelText("Code d'invitation")).toBeNull();
  });

  it("un serveur qui exige une étape infranchissable n'est pas un serveur muet", async () => {
    creerCompte.mockRejectedValue(
      Object.assign(new Error("inscription impossible"), {
        errcode: "TACITA_INSCRIPTION_IMPOSSIBLE",
      }),
    );
    await remplirEtCreer();

    await waitFor(() =>
      expect(screen.getByText("La création de compte est refusée par ce serveur.")).toBeTruthy(),
    );
    expect(screen.queryByText("Le serveur n'a pas répondu. Réessayez.")).toBeNull();
  });

  it("une vraie panne de réseau, elle, se dit comme telle", async () => {
    creerCompte.mockRejectedValue(new Error("fetch failed"));
    await remplirEtCreer();

    await waitFor(() =>
      expect(screen.getByText("Le serveur n'a pas répondu. Réessayez.")).toBeTruthy(),
    );
  });
});

describe("la clé de récupération ouvre une session, en dernier recours", () => {
  /*
   * D-12 a fermé la seule autre issue : ni e-mail ni SSO sur ce déploiement, et le
   * changement de mot de passe exige déjà la clé. Sans cette porte, un mot de passe oublié
   * faisait un compte mort — avec, en poche, la clé qui aurait pu l'ouvrir.
   */
  const ouvrirLaPorteDeSecours = async () => {
    monter(null);
    await waitFor(() => expect(screen.getByText("Mot de passe oublié ?")).toBeTruthy());
    fireEvent.click(screen.getByText("Mot de passe oublié ?"));
  };

  it("elle ne s'offre pas au même rang que les deux gestes normaux", async () => {
    monter(null);
    await waitFor(() => expect(screen.getByText("Créer un compte")).toBeTruthy());

    // Visible en connexion — c'est là qu'on la cherche…
    expect(screen.getByText("Mot de passe oublié ?")).toBeTruthy();

    // …et absente quand on crée son compte : on n'a pas encore de clé à présenter.
    fireEvent.click(screen.getByText("Créer un compte"));
    expect(screen.queryByText("Mot de passe oublié ?")).toBeNull();
  });

  it("l'écran demande la clé, pas le mot de passe, et dit ce que ça engage", async () => {
    await ouvrirLaPorteDeSecours();

    expect(screen.getByLabelText("Clé de récupération")).toBeTruthy();
    // Le mot de passe n'est pas grisé, il n'est pas là : c'est le geste qu'on ne peut pas
    // faire, pas un champ facultatif (interdit n°13).
    expect(screen.queryByLabelText("Mot de passe")).toBeNull();
    // La contrepartie est dite ici, où le geste se fait — pas seulement dans un écran de
    // limites qu'on lit une fois.
    expect(screen.getByText("Une mesure exceptionnelle")).toBeTruthy();
  });

  it("la clé ouvre la session", async () => {
    const { session } = fausseSession();
    connexionParCle.mockResolvedValue(session);
    await ouvrirLaPorteDeSecours();

    fireEvent.change(screen.getByLabelText("Identifiant"), { target: { value: "mira" } });
    fireEvent.change(screen.getByLabelText("Clé de récupération"), {
      target: { value: "EsTb ABCD EFGH" },
    });
    fireEvent.click(screen.getByText("Ouvrir ma session"));

    await waitFor(() =>
      expect(connexionParCle).toHaveBeenCalledWith(
        expect.objectContaining({ identifiant: "mira", cleRecuperation: "EsTb ABCD EFGH" }),
      ),
    );
  });

  it("un refus dit que l'un des deux est faux, sans dire lequel", async () => {
    /*
     * Le module rend le même 403 pour quatre causes — compte inconnu, désactivé, sans clé,
     * clé fausse. Deviner laquelle pour l'afficher reconstruirait l'oracle de comptes que
     * cette réponse unique existe pour refuser.
     */
    connexionParCle.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { errcode: "M_FORBIDDEN" }),
    );
    await ouvrirLaPorteDeSecours();

    fireEvent.change(screen.getByLabelText("Identifiant"), { target: { value: "mira" } });
    fireEvent.change(screen.getByLabelText("Clé de récupération"), {
      target: { value: "EsTb ABCD EFGH" },
    });
    fireEvent.click(screen.getByText("Ouvrir ma session"));

    await waitFor(() =>
      expect(screen.getByText("Identifiant ou clé de récupération incorrect.")).toBeTruthy(),
    );
    expect(screen.queryByText("Le serveur n'a pas répondu. Réessayez.")).toBeNull();
  });
});
