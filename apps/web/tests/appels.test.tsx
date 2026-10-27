import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import type { CallLogEntry, CallState, IncomingCall } from "@tacita/calls";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppelEntrant, appelAMontrer } from "../components/appels/AppelEntrant";
import { BandeauAppel, ligneParticipants } from "../components/appels/BandeauAppel";
import { AppelObjet, libelleAppel } from "../components/conversation/AppelObjet";
import { appelsParAncre } from "../components/conversation/Timeline";
import { dureeAppel } from "../lib/dates";
import { sonner } from "../lib/sonnerie";
import { EcranAppel, DELAI_CHARGEMENT_MS } from "../components/appels/EcranAppel";
import { SessionProvider } from "../components/onboarding/SessionProvider";
import { routeAppel } from "../lib/routes";
import { sansCommentaires, sourcesLivrees } from "./sources";

const SALON = "!salon:tacita.test";

/** Mutable : la bannière d'appel entrant se tait sur l'écran d'appel, et pas ailleurs. */
let cheminCourant = "/c";

const pousser = vi.fn();
const revenir = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => cheminCourant,
  useRouter: () => ({ push: pousser, back: revenir }),
  useSearchParams: () => new URLSearchParams(),
}));

const restoreSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: vi.fn(),
  restoreSession: () => restoreSession(),
}));

/**
 * Le paquet 10 est mocké à son interface (objectif mesurable de M-I) : l'appel réel est
 * prouvé par sa propre suite, celle-ci ne prouve que le shell.
 */
const decouvrir = vi.fn<() => Promise<unknown>>();
const debrancher = vi.fn();
/** Le signal « Element Call nous a parlé », que le test déclenche quand il le décide. */
let widgetPret: (() => void) | undefined;
const brancher = vi.fn((..._args: unknown[]) => {
  widgetPret = _args[4] as (() => void) | undefined;
  return debrancher;
});
const raccrocher = vi.fn(async () => {});
let etatAppel: CallState = { status: "idle", participants: [] };
let notifier: ((etat: CallState) => void) | undefined;
let entrants: IncomingCall[] = [];
let notifierEntrants: (() => void) | undefined;
let journal: CallLogEntry[] = [];

vi.mock("@tacita/calls", () => ({
  RtcFociMissingError: class extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  },
  discoverFocus: () => decouvrir(),
  buildCallWidget: (_s: unknown, roomId: string, options: { video?: boolean; widgetId: string }) => ({
    params: {},
    url: `https://call.test/room#?roomId=${roomId}&video=${String(options.video ?? false)}&widgetId=${options.widgetId}`,
  }),
  attachCallWidget: (...args: unknown[]) => brancher(...(args as [])),
  hangupLocal: () => raccrocher(),
  incomingCalls: () => ({
    current: () => entrants,
    subscribe: (listener: () => void) => {
      notifierEntrants = listener;
      return () => {
        notifierEntrants = undefined;
      };
    },
    stop: vi.fn(),
  }),
  callHistory: () => journal,
  activeCall: () => ({
    current: () => etatAppel,
    subscribe: (listener: (etat: CallState) => void) => {
      notifier = listener;
      return () => {
        notifier = undefined;
      };
    },
    stop: vi.fn(),
  }),
}));

const rendreAvecSession = (noeud: React.ReactNode) =>
  render(
    <SessionProvider homeserverUrl="https://chat.tacita.test">
      {noeud}
    </SessionProvider>,
  );

beforeEach(() => {
  etatAppel = { status: "idle", participants: [] };
  notifier = undefined;
  entrants = [];
  notifierEntrants = undefined;
  cheminCourant = "/c";
  journal = [];
  // Sans cette remise à zéro, un test attendrait le signal du test précédent — dont le
  // composant est démonté, donc dont le rappel ne fait plus rien.
  widgetPret = undefined;
  decouvrir.mockResolvedValue({ type: "livekit", livekit_service_url: "https://sfu.test" });
  restoreSession.mockResolvedValue(
    asSession({
      client: {
        getUserId: () => "@bob:t",
        getDeviceId: () => "D1",
        baseUrl: "https://chat.tacita.test",
        // L'écran d'appel nomme qui il appelle, et le bandeau nomme qui participe : les
        // deux lisent le salon. `null` est le cas réel d'un salon pas encore connu du
        // client, et c'est celui qui doit rester lisible.
        getRoom: () => null,
        getRooms: () => [],
        // `conversations` nomme les salons pour la bannière d'appel entrant, et lit
        // `m.direct` pour le faire.
        getAccountData: () => undefined,
        on: vi.fn(),
        off: vi.fn(),
      },
      recoveryState: async () => "prete" as const,
    } as never),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("appel voix/vidéo, bandeau d'appel en cours, erreur explicite", () => {
  it("monte le widget Element Call avec les seules permissions nécessaires", async () => {
    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);

    const cadre = (await screen.findByTitle("Appel")) as HTMLIFrameElement;
    // La contrainte de M-I, mot pour mot : caméra, micro, plein écran, rien d'autre.
    expect(cadre.getAttribute("allow")).toBe("camera; microphone; fullscreen");
    await waitFor(() => expect(brancher).toHaveBeenCalledOnce());
  });

  it("RtcFociMissing rend la cause, jamais un bouton inerte", async () => {
    const { RtcFociMissingError } = await import("@tacita/calls");
    decouvrir.mockRejectedValue(new RtcFociMissingError("no-livekit-focus" as never));

    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);

    // La cause est nommée : « pas de service d'appel » ≠ « réseau injoignable ».
    expect(await screen.findByText(/pas de service d'appel/)).toBeTruthy();
    expect(screen.queryByTitle("Appel")).toBeNull();
    expect(screen.getByRole("button", { name: "Retour" })).toBeTruthy();
  });

  it("distingue un serveur injoignable d'un serveur sans service d'appel", async () => {
    const { RtcFociMissingError } = await import("@tacita/calls");
    decouvrir.mockRejectedValue(new RtcFociMissingError("well-known-unreachable" as never));

    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    expect(await screen.findByText(/n'a pas répondu/)).toBeTruthy();
  });

  it("un appel actif dans le salon affiche le bandeau et mène à l'écran d'appel", async () => {
    etatAppel = { status: "active", participants: ["@ana:t"] };
    rendreAvecSession(<BandeauAppel roomId={SALON} />);

    expect(await screen.findByText("Appel en cours")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rejoindre" }));
    expect(pousser).toHaveBeenCalledWith(routeAppel(SALON));
  });

  it("le bandeau n'existe pas sans appel, et disparaît quand il se termine", async () => {
    rendreAvecSession(<BandeauAppel roomId={SALON} />);
    await waitFor(() => expect(notifier).toBeDefined());
    expect(screen.queryByText("Appel en cours")).toBeNull();

    etatAppel = { status: "active", participants: ["@ana:t", "@mira:t"] };
    notifier!(etatAppel);
    expect(await screen.findByText("Appel en cours")).toBeTruthy();
    // Des noms, pas un compte : dans un groupe, « est-ce que je rejoins » dépend
    // entièrement de qui est là. Sans membre connu du salon, l'identifiant sans son
    // domaine — jamais l'identifiant brut, qui n'apprend rien à personne.
    expect(screen.getByText("@ana et @mira y participent.")).toBeTruthy();

    etatAppel = { status: "ended", participants: [] };
    notifier!(etatAppel);
    await waitFor(() => expect(screen.queryByText("Appel en cours")).toBeNull());
  });
});

describe("shell minimal : conteneur, sortie de secours, paramètres de lancement", () => {
  it("passe le paramètre du point d'entrée, audio par défaut", async () => {
    const { rerender } = rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    const audio = (await screen.findByTitle("Appel")) as HTMLIFrameElement;
    expect(audio.src).toContain("video=false");

    rerender(
      <SessionProvider homeserverUrl="https://chat.tacita.test">
        <EcranAppel roomId={SALON} video />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect((screen.getByTitle("Appel") as HTMLIFrameElement).src).toContain("video=true"),
    );

    // Le pont postMessage reçoit la même option : l'URL de l'iframe et celle du widget
    // doivent coïncider, sinon l'origine attendue n'est pas celle de l'iframe.
    expect(brancher.mock.calls.at(-1)?.[3]).toMatchObject({ video: true });
  });

  it("le widget qui ne charge pas laisse un message et une sortie, jamais un écran mort", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    await screen.findByTitle("Appel");

    // Avant le délai : le widget a encore sa chance, et la sortie de secours est là.
    expect(screen.getByRole("button", { name: "Annuler" })).toBeTruthy();

    await vi.advanceTimersByTimeAsync(DELAI_CHARGEMENT_MS + 1);

    expect(await screen.findByText("Appel impossible")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retour" }));
    expect(revenir).toHaveBeenCalledOnce();
  });

  it("la sortie de secours s'efface dès qu'Element Call répond", async () => {
    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    await waitFor(() => expect(widgetPret).toBeDefined());
    expect(screen.getByRole("button", { name: "Annuler" })).toBeTruthy();

    // E-07 : le raccrochage appartient au widget. Deux sorties concurrentes, non.
    act(() => widgetPret!());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Annuler" })).toBeNull());
  });

  it("un widget qui a répondu ne déclenche pas le message d'échec", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    await waitFor(() => expect(widgetPret).toBeDefined());
    act(() => widgetPret!());

    await vi.advanceTimersByTimeAsync(DELAI_CHARGEMENT_MS + 1);
    expect(screen.queryByText("Appel impossible")).toBeNull();
    expect(screen.getByTitle("Appel")).toBeTruthy();
  });

  it("quitter l'écran retire notre appartenance : le salon ne reste pas en appel", async () => {
    const { unmount } = rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    await waitFor(() => expect(brancher).toHaveBeenCalled());

    unmount();
    expect(debrancher).toHaveBeenCalled();
    expect(raccrocher).toHaveBeenCalled();
  });
});

describe("l'appel des Friends interaction buttons prend le même chemin", () => {
  it("la route d'appel est construite à un seul endroit, jamais recopiée", () => {
    // « Même chemin que le header 1:1 » n'est tenable que si c'est le même code : trois
    // gabarits d'URL recopiés divergent au premier changement de route, et personne ne
    // le voit — les trois écrans continuent d'ouvrir *une* page d'appel, deux la bonne.
    const recopies = sourcesLivrees()
      .filter(({ chemin }) => !chemin.endsWith("/lib/routes.ts"))
      // Un gabarit de route d'appel : `/c/appel`. Les imports de `lib/routes` n'en
      // sont pas — ils ne portent pas le chemin en dur.
      .filter(({ code }) => /["'`]\/c\/appel/.test(sansCommentaires(code)))
      .map(({ chemin }) => chemin);

    expect(recopies).toEqual([]);
  });

  it("le point d'entrée audio ne demande pas la vidéo, le point d'entrée vidéo si", () => {
    expect(routeAppel(SALON)).toBe(`/c/appel?room=${encodeURIComponent(SALON)}`);
    expect(routeAppel(SALON, true)).toBe(`/c/appel?room=${encodeURIComponent(SALON)}&video=1`);
    // Un `!salon:serveur` non encodé couperait la route sur son `/`.
    expect(routeAppel(SALON)).not.toContain("!salon:tacita.test");
  });
});

const T0 = 1_700_000_000_000;
const entrant = (reste: Partial<IncomingCall> = {}): IncomingCall => ({
  roomId: SALON,
  from: "@ana:t",
  since: T0,
  ringing: true,
  ...reste,
});

describe("un appel entrant se voit et s'entend depuis n'importe quel écran", () => {
  it("il s'affiche alors qu'aucune conversation n'est ouverte", async () => {
    // Le défaut d'origine : l'appel ne s'annonçait que dans l'écran du salon concerné.
    // Quelqu'un qui appelait pendant qu'on lisait la liste des conversations ne
    // produisait rien du tout — pas un pixel, pas un son.
    cheminCourant = "/";
    entrants = [entrant()];
    rendreAvecSession(<AppelEntrant />);

    expect(await screen.findByRole("alertdialog", { name: /Appel entrant/ })).toBeTruthy();
    expect(screen.getByText("Appel entrant")).toBeTruthy();
  });

  it("répondre mène à l'écran d'appel du bon salon", async () => {
    entrants = [entrant()];
    rendreAvecSession(<AppelEntrant />);

    fireEvent.click(await screen.findByRole("button", { name: "Répondre" }));
    expect(pousser).toHaveBeenCalledWith(routeAppel(SALON));
  });

  it("ignorer fait taire cet appel-là, et lui seul", async () => {
    // MatrixRTC n'a pas de refus : ce bouton n'envoie rien à l'appelant, et son libellé
    // le dit. Promettre « Refuser » serait promettre un signal qui ne part nulle part.
    entrants = [entrant()];
    rendreAvecSession(<AppelEntrant />);

    fireEvent.click(await screen.findByRole("button", { name: "Ignorer" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // Un appel suivant, dans le même salon, sonne de nouveau : c'est un autre appel.
    entrants = [entrant({ since: T0 + 600_000 })];
    act(() => notifierEntrants?.());
    expect(await screen.findByRole("alertdialog", { name: /Appel entrant/ })).toBeTruthy();
  });

  it("un appel commencé il y a longtemps ne sonne pas", async () => {
    entrants = [entrant({ ringing: false })];
    rendreAvecSession(<AppelEntrant />);

    await waitFor(() => expect(notifierEntrants).toBeDefined());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("elle se tait sur l'écran d'appel : on vient de décrocher", async () => {
    // Entre la navigation et la publication de notre appartenance il s'écoule un
    // aller-retour réseau. Sans ce garde, la bannière se rallumait par-dessus l'appel
    // qu'on venait d'accepter.
    cheminCourant = routeAppel(SALON);
    entrants = [entrant()];
    rendreAvecSession(<AppelEntrant />);

    await waitFor(() => expect(notifierEntrants).toBeDefined());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("un seul appel à la fois, et c'est le plus récent", () => {
    const vieux = entrant({ roomId: "!vieux:t", since: T0 });
    const neuf = entrant({ roomId: "!neuf:t", since: T0 + 5_000 });
    expect(appelAMontrer([vieux, neuf], [], new Set())?.roomId).toBe("!neuf:t");
  });

  it("le salon est nommé ; à défaut, c'est l'appelant, jamais l'identifiant du salon", () => {
    // « !abc:serveur vous appelle » ne dit rien à personne.
    const salons = [{ roomId: SALON, name: "Ana", direct: true }] as never;
    expect(appelAMontrer([entrant()], salons, new Set())?.nom).toBe("Ana");
    expect(appelAMontrer([entrant()], [], new Set())?.nom).toBe("@ana:t");
  });
});

describe("la sonnerie se synthétise, échoue en silence, et s'arrête toujours", () => {
  it("sans AudioContext, elle ne lève pas — la bannière reste, et elle suffit", () => {
    const arreter = sonner(undefined);
    expect(() => arreter()).not.toThrow();
  });

  it("elle joue un motif, le répète, et se coupe à l'arrêt", () => {
    vi.useFakeTimers();
    const oscillateurs: { start: unknown; stop: unknown }[] = [];
    const noeud = () => ({
      frequency: { value: 0 },
      connect: (cible: unknown) => cible,
      start: vi.fn(),
      stop: vi.fn(),
    });
    const close = vi.fn();
    const faux = vi.fn(() => ({
      currentTime: 0,
      destination: {},
      createOscillator: () => {
        const o = noeud();
        oscillateurs.push(o);
        return o;
      },
      createGain: () => ({
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
        connect: (cible: unknown) => cible,
      }),
      resume: async () => {},
      close,
    }));

    const arreter = sonner(faux as never);
    const premierMotif = oscillateurs.length;
    expect(premierMotif).toBeGreaterThan(0);

    vi.advanceTimersByTime(4_000);
    expect(oscillateurs.length).toBeGreaterThan(premierMotif);

    arreter();
    const apresArret = oscillateurs.length;
    vi.advanceTimersByTime(20_000);
    expect(oscillateurs).toHaveLength(apresArret);
    expect(close).toHaveBeenCalled();
  });
});

describe("l'écran d'attente dit qui on appelle, au lieu d'une iframe vide", () => {
  it("il porte le point d'entrée choisi, et une sortie nommée pour ce qu'elle fait", async () => {
    // Trois secondes d'écran noir sont exactement le moment où l'on se demande si on a
    // touché le bon bouton — et où les appels se raccrochent avant d'avoir commencé.
    rendreAvecSession(<EcranAppel roomId={SALON} video />);

    expect(await screen.findByText("Appel vidéo · connexion…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Annuler" })).toBeTruthy();
  });

  it("l'attente s'efface dès qu'Element Call répond : c'est lui qui porte l'appel", async () => {
    rendreAvecSession(<EcranAppel roomId={SALON} video={false} />);
    expect(await screen.findByText("Appel audio · connexion…")).toBeTruthy();

    await waitFor(() => expect(widgetPret).toBeDefined());
    act(() => widgetPret!());
    await waitFor(() => expect(screen.queryByText("Appel audio · connexion…")).toBeNull());
  });
});

describe("un appel manqué laisse une trace, et un geste pour rappeler", () => {
  const passe = (reste: Partial<CallLogEntry> = {}): CallLogEntry => ({
    id: "$appel1",
    from: "@ana:t",
    debut: T0,
    fin: T0 + 240_000,
    participants: ["@ana:t"],
    enCours: false,
    mien: false,
    manque: false,
    ...reste,
  });

  it("un appel manqué se nomme et offre de rappeler", () => {
    const rappeler = vi.fn();
    render(<AppelObjet appel={passe({ manque: true })} onRappeler={rappeler} />);

    expect(screen.getByText(/Appel manqué/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rappeler" }));
    expect(rappeler).toHaveBeenCalledOnce();
  });

  it("un appel qui a eu lieu porte sa durée, et pas de bouton", () => {
    render(<AppelObjet appel={passe()} onRappeler={vi.fn()} />);

    expect(screen.getByText("Appel · 4 min")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rappeler" })).toBeNull();
  });

  it("une fin inconnue ne devient pas une durée inventée", () => {
    // Le dernier participant est parti sans le dire, son appartenance a expiré : la fin
    // réelle est inconnue. « Appel de 4 h » serait pire que pas de durée du tout.
    expect(libelleAppel(passe({ fin: undefined }))).not.toContain("h");
    expect(libelleAppel(passe({ fin: undefined })).startsWith("Appel · ")).toBe(true);
  });

  it("les durées se lisent, elles ne se comptent pas", () => {
    expect(dureeAppel(42_000)).toBe("42 s");
    expect(dureeAppel(4 * 60_000)).toBe("4 min");
    expect(dureeAppel(72 * 60_000)).toBe("1 h 12");
  });
});

describe("le journal se place dans l'ordre de /sync, jamais par horodatage", () => {
  const entree = (id: string, reste: Partial<CallLogEntry> = {}): CallLogEntry => ({
    id,
    from: "@ana:t",
    debut: T0,
    fin: T0 + 1_000,
    participants: ["@ana:t"],
    enCours: false,
    mien: false,
    manque: false,
    ...reste,
  });

  it("chaque appel se rattache au message qu'il suit", () => {
    // Interdit n°6 : l'ordre canonique est celui du flux `/sync`. Fusionner les deux
    // listes par date serait exactement le tri qu'il refuse.
    const parAncre = appelsParAncre([
      entree("$a", { apres: "$m1" }),
      entree("$b", { apres: "$m2" }),
      entree("$c", { apres: "$m1" }),
    ]);

    expect(parAncre.get("$m1")?.map((appel) => appel.id)).toEqual(["$a", "$c"]);
    expect(parAncre.get("$m2")?.map((appel) => appel.id)).toEqual(["$b"]);
  });

  it("un appel sans ancre ouvre la fenêtre chargée", () => {
    expect(appelsParAncre([entree("$a")]).get("")?.map((appel) => appel.id)).toEqual(["$a"]);
  });

  it("un appel en cours n'entre pas au journal : c'est le bandeau qui le porte", () => {
    // Deux surfaces pour le même appel se contrediraient au premier décalage.
    expect([...appelsParAncre([entree("$a", { enCours: true, fin: undefined })]).keys()]).toEqual([]);
  });
});

describe("qui participe, plutôt que combien", () => {
  const nom = (id: string) => id.replace("@", "").replace(/:.*/, "");

  it("un, deux, trois se nomment ; au-delà on compte le reste", () => {
    expect(ligneParticipants(["@ana:t"], nom)).toBe("ana y participe.");
    expect(ligneParticipants(["@ana:t", "@sam:t"], nom)).toBe("ana et sam y participent.");
    expect(ligneParticipants(["@ana:t", "@sam:t", "@mira:t"], nom)).toBe(
      "ana, sam et mira y participent.",
    );
    // Six noms ne se lisent plus : au-delà de trois, le compte redevient l'information.
    expect(ligneParticipants(["@a:t", "@b:t", "@c:t", "@d:t", "@e:t"], nom)).toBe(
      "a, b et 3 autres y participent.",
    );
  });
});
