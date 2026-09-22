import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IosPushEducation } from "../components/onboarding/IosPushEducation";
import { LogoutButton } from "../components/onboarding/LogoutButton";
import { RecoveryGate } from "../components/onboarding/RecoveryGate";
import { SessionProvider } from "../components/onboarding/SessionProvider";
import { retirerJetonDeLUrl, urlConnexion } from "../lib/session";
import { ecrireRefusEducationIOS } from "../lib/preferences";

const HOMESERVER = "https://chat.tacita.test";

const initSession = vi.fn<() => Promise<Session>>();
const restoreSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: () => initSession(),
  restoreSession: () => restoreSession(),
}));

/**
 * `asSession` de `client-core/testing` plutôt qu'un `as unknown as Session` : un membre
 * ajouté au contrat de `Session` doit casser la compilation d'un seul fichier, pas
 * disparaître en `undefined is not a function` à l'exécution (specs/00-conventions.md).
 */
function fausseSession(options: { recuperationRequise?: boolean } = {}) {
  const setupRecoveryKey = vi.fn(async () => ({
    encodedPrivateKey: "EsTb ABCD EFGH IJKL",
    privateKey: new Uint8Array(32),
  }));
  const logout = vi.fn(async () => {});
  const session = asSession({
    // `client` est un faux assumé : exiger un vrai `MatrixClient` demanderait 357
    // propriétés, et le shard n'y touche pas — il passe par les membres de `Session`.
    client: {},
    recoveryRequired: vi.fn(async () => options.recuperationRequise ?? false),
    setupRecoveryKey,
    logout,
  });
  return { session, setupRecoveryKey, logout };
}

const rediriger = vi.fn();

const monter = (session: Session | null, enfant = <p>Conversations</p>) => {
  restoreSession.mockResolvedValue(session);
  return render(
    <SessionProvider homeserverUrl={HOMESERVER} rediriger={rediriger}>
      <RecoveryGate>{enfant}</RecoveryGate>
    </SessionProvider>,
  );
};

beforeEach(() => {
  globalThis.history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  // `restoreAllMocks` et non `clearAllMocks` : les espions posés sur `navigator` et
  // `matchMedia` par les tests iOS survivraient au fichier et casseraient les suivants.
  vi.restoreAllMocks();
  initSession.mockReset();
  restoreSession.mockReset();
  rediriger.mockReset();
});

describe("REQ-UI-04 — l'étape de clé de récupération est bloquante", () => {
  it("tant que la récupération est requise, aucun contenu d'app n'est rendu", async () => {
    const { session } = fausseSession({ recuperationRequise: true });
    monter(session);

    await waitFor(() => expect(screen.getByText("Votre clé de récupération")).toBeTruthy());
    // Le contenu demandé n'est pas caché : il n'est pas rendu du tout.
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("elle ne se contourne pas par l'URL : ce n'est pas une route, c'est le shell", async () => {
    const { session } = fausseSession({ recuperationRequise: true });
    // Quelle que soit l'adresse demandée, c'est l'étape qui rend.
    globalThis.history.replaceState(null, "", "/c/!salon:tacita.test");
    monter(session, <p>Conversations</p>);

    await waitFor(() => expect(screen.getByText("Votre clé de récupération")).toBeTruthy());
    expect(screen.queryByText("Conversations")).toBeNull();
  });

  it("la clé est affichée une fois, et la confirmation libère l'accès", async () => {
    const { session, setupRecoveryKey } = fausseSession({ recuperationRequise: true });
    monter(session);

    await waitFor(() => expect(screen.getByText("Créer ma clé")).toBeTruthy());
    fireEvent.click(screen.getByText("Créer ma clé"));

    await waitFor(() => expect(screen.getByText(/EsTb ABCD/)).toBeTruthy());
    expect(setupRecoveryKey).toHaveBeenCalledTimes(1);
    // La promesse est tenue telle qu'elle est faite : elle ne sera plus affichée.
    expect(screen.getByText(/ne sera plus affichée/)).toBeTruthy();

    fireEvent.click(screen.getByText("J'ai sauvegardé ma clé"));
    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
  });

  it("dit la vérité sur ce qu'on perd sans la clé", async () => {
    const { session } = fausseSession({ recuperationRequise: true });
    monter(session);

    // Interdit n°13 : la limite se documente là où elle se joue, pas dans une note.
    await waitFor(() => expect(screen.getByText(/définitivement perdu/)).toBeTruthy());
    expect(screen.getByText(/personne, chez nous, ne peut le récupérer/)).toBeTruthy();
  });

  it("aucune UI de mot de passe : la connexion part chez le fournisseur", () => {
    const url = new URL(urlConnexion(HOMESERVER, "https://app.tacita.test"));
    expect(url.pathname).toBe("/_matrix/client/v3/login/sso/redirect");
    expect(url.searchParams.get("redirectUrl")).toBe("https://app.tacita.test");
  });
});

describe("REQ-UIX-06 — reprise de session, retour OIDC, déconnexion", () => {
  it("une session valide arrive directement sur le contenu", async () => {
    const { session } = fausseSession();
    monter(session);

    await waitFor(() => expect(screen.getByText("Conversations")).toBeTruthy());
    expect(rediriger).not.toHaveBeenCalled();
  });

  it("sans session restaurable, retour à l'OIDC sans écran intermédiaire", async () => {
    monter(null);

    await waitFor(() => expect(rediriger).toHaveBeenCalledTimes(1));
    expect(rediriger.mock.calls[0]![0]).toContain("/login/sso/redirect");
    // Aucun formulaire, aucun bouton « se connecter » : la redirection est déjà partie.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("un jeton révoqué ou une crypto absente ramènent à l'OIDC, sans rien journaliser", async () => {
    restoreSession.mockRejectedValue(new Error("M_UNKNOWN_TOKEN"));
    const journal = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <SessionProvider homeserverUrl={HOMESERVER} rediriger={rediriger}>
        <RecoveryGate>
          <p>Conversations</p>
        </RecoveryGate>
      </SessionProvider>,
    );

    await waitFor(() => expect(rediriger).toHaveBeenCalledTimes(1));
    expect(journal).not.toHaveBeenCalled();
    journal.mockRestore();
  });

  it("le jeton de connexion est retiré de l'URL, donc de l'historique", () => {
    globalThis.history.replaceState(null, "", "/?loginToken=syt_secret&autre=1");

    const jeton = retirerJetonDeLUrl(globalThis.location, globalThis.history);

    expect(jeton).toBe("syt_secret");
    expect(globalThis.location.search).toBe("?autre=1");
    // `replaceState` et non `pushState` : l'entrée qui portait le jeton est remplacée.
    expect(globalThis.location.href).not.toContain("syt_secret");
  });

  it("la déconnexion n'efface qu'après confirmation, et dit ce qu'elle efface", async () => {
    const { session, logout } = fausseSession();
    render(
      <SessionProvider homeserverUrl={HOMESERVER} rediriger={rediriger}>
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
    expect(rediriger).toHaveBeenCalled();
  });

  it("une reprise qui reste pendante ne bloque pas : au bout du délai, on peut réessayer", async () => {
    vi.useFakeTimers();
    try {
      // Promesse qui ne se résout jamais : le cas iOS d'une connexion IndexedDB laissée
      // pendante après suspension — ni `onsuccess`, ni `onerror`, jamais de `catch`.
      restoreSession.mockReturnValue(new Promise<Session | null>(() => {}));
      render(
        <SessionProvider homeserverUrl={HOMESERVER} rediriger={rediriger}>
          <RecoveryGate>
            <p>Conversations</p>
          </RecoveryGate>
        </SessionProvider>,
      );

      // Avant le délai : rien n'est proposé, et surtout aucun renvoi OIDC silencieux.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(19_000);
      });
      expect(screen.queryByText("Réessayer")).toBeNull();

      // Passé le délai : écran d'échec au lieu d'un squelette infini.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByText("Réessayer")).toBeTruthy();
      expect(rediriger).not.toHaveBeenCalled();

      // « Réessayer » rejoue la reprise ; cette fois elle aboutit, l'app se rend.
      restoreSession.mockResolvedValue(fausseSession().session);
      await act(async () => {
        fireEvent.click(screen.getByText("Réessayer"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText("Conversations")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("REQ-UI-18 — éducation iOS, au bon moment et une seule fois", () => {
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
