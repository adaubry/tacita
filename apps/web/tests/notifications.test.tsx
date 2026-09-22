import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InvitePush } from "../components/notifications/InvitePush";
import { NotificationsGlobales } from "../components/settings/NotificationsGlobales";
import { brancherNotifications, effacerNotifications } from "../lib/notifications";
import { activerPush } from "../lib/push";
import { lire, sansCommentaires, sourcesLivrees } from "./sources";

vi.mock("next/navigation", () => ({
  usePathname: () => "/reglages",
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/** Le paquet 05 rend le texte et les libellés ; le shard n'en dérive aucun. */
vi.mock("@tacita/messaging", () => ({
  messageText: (evenement: { getContent: () => { body?: string } }) =>
    evenement.getContent().body ?? "",
  mentionCandidates: () => [{ id: "@ana:t", label: "ana" }],
}));

const poserPusher = vi.fn(async (_pusher: Record<string, unknown>) => ({}));
const evenementDuSalon = vi.fn<() => unknown>();

const session = () =>
  ({
    client: {
      baseUrl: "https://chat.tacita.test",
      getDeviceId: () => "DEVICE1",
      getRoom: () => ({ findEventById: () => evenementDuSalon() }),
      setPusher: (pusher: Record<string, unknown>) => poserPusher(pusher),
    },
  }) as never;

const messageChiffre = (body: string, echec = false) => ({
  getContent: () => ({ body }),
  getSender: () => "@ana:t",
  isDecryptionFailure: () => echec,
});

/**
 * Charge `public/sw.js` dans un bac à sable : c'est du script de worker, pas un module,
 * et c'est **le** fichier que les deux exigences décrivent. Le tester par sa source
 * plutôt qu'en le paraphrasant est la seule façon d'éprouver ce qui tournera vraiment.
 */
function chargerServiceWorker(onglets: unknown[], affichees: unknown[] = []) {
  const gestionnaires = new Map<string, (evenement: never) => void>();
  const montrer = vi.fn(async (_titre: string, _options: Record<string, unknown>) => {});
  const badge = { setAppBadge: vi.fn(async (_n: number) => {}), clearAppBadge: vi.fn(async () => {}) };
  const caches = {
    open: vi.fn(async () => ({ addAll: vi.fn(), put: vi.fn() })),
    keys: vi.fn(async () => []),
    match: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
  };
  const clients = {
    matchAll: vi.fn(async () => onglets),
    openWindow: vi.fn(async () => null),
  };
  const worker = {
    addEventListener: (type: string, gestionnaire: (evenement: never) => void) =>
      gestionnaires.set(type, gestionnaire),
    registration: { showNotification: montrer, getNotifications: vi.fn(async () => affichees) },
    navigator: badge,
    clients,
    location: { origin: "https://tacita.test" },
  };

  new Function("self", "caches", lire("public/sw.js"))(worker, caches);
  return { gestionnaires, montrer, caches, clients, badge };
}

/** Déclenche un événement du worker et attend ce que son `waitUntil` a retenu. */
async function declencher(
  gestionnaires: Map<string, (evenement: never) => void>,
  type: string,
  evenement: Record<string, unknown>,
) {
  const attentes: Promise<unknown>[] = [];
  gestionnaires.get(type)!({
    ...evenement,
    waitUntil: (promesse: Promise<unknown>) => attentes.push(promesse),
  } as never);
  await Promise.all(attentes);
}

/** L'onglet ouvert, tel que le worker le voit : un `postMessage` avec un port de retour. */
const ongletOuvert = () => ({
  focus: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
  postMessage: (message: unknown, transfert: MessagePort[]) =>
    globalThis.navigator.serviceWorker.dispatchEvent(
      new MessageEvent("message", { data: message, ports: transfert }),
    ),
});

let indexedDB: IDBFactory;

beforeEach(() => {
  indexedDB = new IDBFactory();
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: Object.assign(new EventTarget(), {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn(async () => null),
          subscribe: vi.fn(async () => ({
            endpoint: "https://push.example.org/abonnement-1",
            toJSON: () => ({ keys: { p256dh: "cle-p256dh", auth: "cle-auth" } }),
          })),
        },
      }),
    }),
    configurable: true,
  });
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", {
    permission: "default",
    requestPermission: vi.fn(async () => "granted"),
  });
  evenementDuSalon.mockReturnValue(messageChiffre("on se voit à 18h ?"));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("REQ-UI-18 — abonnement Web Push, réveil, déchiffrement local, notification", () => {
  it("s'abonne avec la clé VAPID de la passerelle et enregistre le pusher", async () => {
    const reseau = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ vapid_public_key: "BO_Q5R3h" })));

    expect(await activerPush(session())).toBe("actif");

    // REQ-PSH-03 : la clé publique est lue sur la passerelle, jamais recopiée dans le client.
    expect(String(reseau.mock.calls[0]![0])).toBe("https://chat.tacita.test/push/config");

    const pusher = poserPusher.mock.calls[0]![0] as {
      pushkey: string;
      app_id: string;
      data: Record<string, string>;
    };
    expect(pusher.pushkey).toBe("https://push.example.org/abonnement-1");
    expect(pusher.app_id).toBe("org.tacita.web");
    // REQ-PSH-02 : ce format est ce qui garantit que Synapse n'envoie que des IDs.
    expect(pusher.data.format).toBe("event_id_only");
    expect(pusher.data).toMatchObject({ p256dh: "cle-p256dh", auth: "cle-auth" });
  });

  it("ne demande jamais la permission au premier lancement", async () => {
    render(<InvitePush declenche={false} session={session()} indexedDB={indexedDB} />);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it("la propose après un message reçu, et une seule fois si on l'écarte", async () => {
    const { unmount } = render(
      <InvitePush declenche session={session()} indexedDB={indexedDB} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Plus tard" }));

    unmount();
    render(<InvitePush declenche session={session()} indexedDB={indexedDB} />);
    // Insister est le plus court chemin vers un refus définitif du navigateur.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Plus tard" })).toBeNull());
  });

  it("le réveil du worker construit la notification à partir de l'événement déchiffré", async () => {
    const debrancher = brancherNotifications(session());
    const { gestionnaires, montrer } = chargerServiceWorker([ongletOuvert()]);

    await declencher(gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e1", room_id: "!dm:t" }) },
    });

    // L'expéditeur et l'aperçu viennent du déchiffrement local, jamais du payload — qui
    // ne porte que deux identifiants (REQ-PSH-02).
    expect(montrer).toHaveBeenCalledWith("ana", {
      body: "on se voit à 18h ?",
      tag: "!dm:t",
      renotify: true,
      data: { room_id: "!dm:t" },
    });
    debrancher();
  });

  it("les notifications d'une même conversation sont groupées par un tag", async () => {
    brancherNotifications(session());
    const { gestionnaires, montrer } = chargerServiceWorker([ongletOuvert()]);

    await declencher(gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e1", room_id: "!dm:t" }) },
    });
    await declencher(gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e2", room_id: "!dm:t" }) },
    });

    for (const appel of montrer.mock.calls) expect((appel[1] as { tag: string }).tag).toBe("!dm:t");
  });

  it("le badge suit les notifications en attente : il monte au push, retombe au tap", async () => {
    // Deux conversations ont une notification affichée : le badge dit 2.
    const avecDeux = chargerServiceWorker([], [{}, {}]);
    await declencher(avecDeux.gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e1", room_id: "!dm:t" }) },
    });
    expect(avecDeux.badge.setAppBadge).toHaveBeenCalledWith(2);

    // Tap sur la dernière : fermée, plus rien en attente, le badge s'efface.
    const fermer = vi.fn();
    const aucune = chargerServiceWorker([ongletOuvert()], []);
    await declencher(aucune.gestionnaires, "notificationclick", {
      notification: { close: fermer, data: { room_id: "!dm:t" } },
    });
    expect(fermer).toHaveBeenCalled();
    expect(aucune.badge.clearAppBadge).toHaveBeenCalled();
  });

  it("ouvrir une conversation ferme ses notifications, et seulement les siennes", async () => {
    const duSalon = { close: vi.fn() };
    const dAilleurs = { close: vi.fn() };
    const getNotifications = vi.fn(async (filtre?: { tag?: string }) =>
      filtre?.tag === "!dm:t" ? [duSalon] : [dAilleurs],
    );
    Object.assign(globalThis.navigator.serviceWorker, {
      getRegistration: vi.fn(async () => ({ getNotifications })),
    });
    const setAppBadge = vi.fn(async () => {});
    Object.defineProperty(globalThis.navigator, "setAppBadge", { value: setAppBadge, configurable: true });
    try {
      await effacerNotifications("!dm:t");

      expect(duSalon.close).toHaveBeenCalled();
      expect(dAilleurs.close).not.toHaveBeenCalled();
      // Il reste la notification de l'autre conversation : le badge le dit.
      expect(setAppBadge).toHaveBeenCalledWith(1);
    } finally {
      delete (globalThis.navigator as { setAppBadge?: unknown }).setAppBadge;
    }
  });

  it("le tap ouvre la conversation, sans doubler un onglet déjà ouvert", async () => {
    const onglet = ongletOuvert();
    const { gestionnaires, clients } = chargerServiceWorker([onglet]);

    await declencher(gestionnaires, "notificationclick", {
      notification: { close: vi.fn(), data: { room_id: "!dm:t" } },
    });

    expect(onglet.navigate).toHaveBeenCalledWith("/c/!dm:t");
    expect(onglet.focus).toHaveBeenCalled();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("le refus de permission est un état visible, avec son chemin de rattrapage", async () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });
    render(<NotificationsGlobales session={session()} />);

    expect(await screen.findByText(/bloquées par votre navigateur/)).toBeTruthy();
    expect(screen.getByText(/réglages du site/)).toBeTruthy();
    // Redemander est impossible : un bouton qui prétend le contraire serait inerte.
    expect(screen.queryByRole("button", { name: "Activer les notifications" })).toBeNull();
  });

  it("les réglages disent la limite plutôt que de promettre l'aperçu partout", async () => {
    render(<NotificationsGlobales session={session()} />);
    expect(await screen.findByText(/application est fermée/)).toBeTruthy();
  });
});

describe("REQ-UIX-40 — le worker ne persiste rien, et l'échec reste silencieux", () => {
  it("un déchiffrement en échec donne « Nouveau message », sans contenu", async () => {
    evenementDuSalon.mockReturnValue(messageChiffre("** Unable to decrypt **", true));
    brancherNotifications(session());
    const { gestionnaires, montrer } = chargerServiceWorker([ongletOuvert()]);

    await declencher(gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e1", room_id: "!dm:t" }) },
    });

    expect(montrer).toHaveBeenCalledWith("Nouveau message", {
      body: undefined,
      tag: "!dm:t",
      renotify: true,
      data: { room_id: "!dm:t" },
    });
  });

  it("sans onglet pour déchiffrer, la notification reste générique", async () => {
    const { gestionnaires, montrer } = chargerServiceWorker([]);

    await declencher(gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e1", room_id: "!dm:t" }) },
    });

    expect(montrer).toHaveBeenCalledWith("Nouveau message", expect.objectContaining({ body: undefined }));
  });

  it("aucun cache touché et rien de journalisé pendant le réveil", async () => {
    const espions = (["log", "info", "warn", "error", "debug"] as const).map((niveau) =>
      vi.spyOn(console, niveau).mockImplementation(() => {}),
    );
    brancherNotifications(session());
    const { gestionnaires, caches } = chargerServiceWorker([ongletOuvert()]);

    await declencher(gestionnaires, "push", {
      data: { json: () => ({ event_id: "$e1", room_id: "!dm:t" }) },
    });

    // Interdit n°8 : un aperçu déchiffré qui entrerait au cache survivrait à la
    // déconnexion, hors de portée du registre de wipe.
    expect(caches.open).not.toHaveBeenCalled();
    for (const espion of espions) expect(espion).not.toHaveBeenCalled();
    for (const espion of espions) espion.mockRestore();
  });

  it("un payload illisible ne fait ni erreur bruyante ni notification muette", async () => {
    const { gestionnaires, montrer } = chargerServiceWorker([ongletOuvert()]);

    await declencher(gestionnaires, "push", {
      data: {
        json: () => {
          throw new SyntaxError("payload illisible");
        },
      },
    });

    expect(montrer).toHaveBeenCalledWith("Nouveau message", expect.anything());
  });

  it("ni le worker ni le pont ne peuvent journaliser : il n'y a aucun appel", () => {
    // Structurel, comme REQ-UI-01 sur le précache : la règle tient par construction,
    // pas par vigilance. Un `console.log` de débogage ajouté demain échoue ici.
    expect(sansCommentaires(lire("public/sw.js"))).not.toMatch(/console\./);

    for (const chemin of ["/lib/notifications.ts", "/lib/push.ts"]) {
      const source = sourcesLivrees().find((fichier) => fichier.chemin.endsWith(chemin))!.code;
      expect(sansCommentaires(source), chemin).not.toMatch(/console\.|localStorage|sessionStorage/);
    }
  });
});
