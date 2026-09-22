import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import type { Conversation } from "@tacita/messaging";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PushNotifications } from "../components/notifications/PushNotifications";
import { NotificationsPush } from "../components/settings/NotificationsPush";
import { SessionProvider } from "../components/onboarding/SessionProvider";
import { PUSH_CONFIG_URL, PUSH_NOTIFY_URL } from "../lib/config";
import {
  apercuLocal,
  brancherPush,
  demanderEtBrancher,
  effacerNotifications,
  TYPE_APERCU,
} from "../lib/push";
import { lire } from "./sources";
import { routeConversation } from "../lib/routes";

const SALON = "!salon:tacita.test";
const EVENEMENT = "$evt:tacita.test";
/** base64url de 0x01 0x02 0x03 0x04 — une clé VAPID en réduction, décodable par `atob`. */
const CLE_VAPID = "AQIDBA";
const OCTETS_VAPID = new Uint8Array([1, 2, 3, 4]);
const ENDPOINT = "https://push.example/abonnement-1";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const restoreSession = vi.fn<() => Promise<Session | null>>();
vi.mock("@tacita/client-core", async (original) => ({
  ...(await original<typeof import("@tacita/client-core")>()),
  initSession: vi.fn(),
  restoreSession: () => restoreSession(),
}));

/** La timeline que le SDK a déjà déchiffrée pour cette fenêtre. */
let timeline: { id: string; sender: string; body?: string }[] = [];
let salons: Conversation[] = [];
/** L'abonnement de `messaging` : c'est lui qui dit qu'un message est arrivé. */
let notifierSalons: (() => void) | undefined;

vi.mock("@tacita/messaging", () => ({
  messages: () =>
    timeline.map((evenement) => ({
      getId: () => evenement.id,
      getSender: () => evenement.sender,
      getContent: () => (evenement.body === undefined ? {} : { body: evenement.body }),
    })),
  messageText: (evenement: { getContent: () => { body?: string } }) =>
    evenement.getContent().body ?? "",
  mentionCandidates: () => [{ id: "@mira:t", label: "mira" }],
  conversations: () => salons,
  subscribeConversations: (_session: unknown, listener: () => void) => {
    notifierSalons = listener;
    return () => {
      notifierSalons = undefined;
    };
  },
}));

const conversation = (unread: number): Conversation => ({
  roomId: SALON,
  name: "mira",
  direct: true,
  peerId: "@mira:t",
  preview: "",
  timestamp: 0,
  unread,
  mention: false,
  pinned: false,
});

/** Les pushers que Synapse porte pour ce compte — la troisième moitié de la chaîne. */
let pushers: { app_id: string; pushkey: string; data: Record<string, unknown> }[] = [];
const setPusher = vi.fn(async (pusher: { app_id: string; pushkey: string; data: Record<string, unknown> }) => {
  pushers = [...pushers.filter((p) => p.pushkey !== pusher.pushkey), pusher];
});

const session = () =>
  asSession({
    client: {
      getUserId: () => "@luca:t",
      getDeviceId: () => "D1",
      on: vi.fn(),
      off: vi.fn(),
      getPushers: async () => ({ pushers }),
      setPusher,
    },
    recoveryState: async () => "prete" as const,
  } as never);

/**
 * Le service worker vu depuis la fenêtre : un bus de messages **et** un `pushManager`.
 * Les deux moitiés comptent — l'ancien double n'avait que la première, et c'est
 * exactement l'endroit où la chaîne se cassait sans que rien ne le prouve.
 */
let abonnement: ReturnType<typeof faireAbonnement> | null;

function faireAbonnement(cle: Uint8Array = OCTETS_VAPID, endpoint = ENDPOINT) {
  return {
    endpoint,
    options: { applicationServerKey: cle.buffer.slice(0) as ArrayBuffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-test", auth: "auth-test" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function faireServiceWorker() {
  const ecouteurs = new Set<(evenement: MessageEvent) => void>();
  const pushManager = {
    getSubscription: vi.fn(async () => abonnement),
    subscribe: vi.fn(async () => (abonnement = faireAbonnement())),
  };
  const enregistrement = { active: {}, pushManager };
  return {
    ecouteurs,
    enregistrement,
    pushManager,
    addEventListener: (_type: string, ecouteur: (evenement: MessageEvent) => void) =>
      void ecouteurs.add(ecouteur),
    removeEventListener: (_type: string, ecouteur: (evenement: MessageEvent) => void) =>
      void ecouteurs.delete(ecouteur),
    ready: Promise.resolve(enregistrement),
    getRegistration: vi.fn(async () => enregistrement),
    register: vi.fn(async () => enregistrement),
  };
}

let serviceWorker: ReturnType<typeof faireServiceWorker>;
let base: IDBFactory;

const rendre = (contenu: ReactNode) =>
  render(
    <SessionProvider homeserverUrl="https://chat.tacita.test">
      {contenu}
    </SessionProvider>,
  );

beforeEach(() => {
  timeline = [{ id: EVENEMENT, sender: "@mira:t", body: "on se voit demain ?" }];
  salons = [conversation(0)];
  notifierSalons = undefined;
  pushers = [];
  abonnement = null;
  base = new IDBFactory();
  serviceWorker = faireServiceWorker();
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: serviceWorker,
    configurable: true,
  });
  // jsdom ne la définit pas, et `vi.unstubAllGlobals` ne défait pas un `defineProperty` :
  // remise à zéro ici pour que le test iPad ne déteigne pas sur les suivants.
  Object.defineProperty(globalThis.navigator, "maxTouchPoints", { value: 0, configurable: true });
  restoreSession.mockResolvedValue(session());
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ vapid_public_key: CLE_VAPID }) })),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("abonnement Web Push, réveil, déchiffrement local, notification", () => {
  it("rend l'aperçu déchiffré localement à partir du seul couple {event_id, room_id}", () => {
    // C'est tout ce que la passerelle a le droit d'envoyer — le reste se
    // lit dans la timeline déjà déchiffrée par cette fenêtre.
    expect(apercuLocal(session(), SALON, EVENEMENT)).toEqual({
      expediteur: "mira",
      texte: "on se voit demain ?",
    });
  });

  it("répond au service worker qui demande l'aperçu d'un événement", async () => {
    rendre(<PushNotifications indexedDB={base} />);
    await waitFor(() => expect(serviceWorker.ecouteurs.size).toBe(1));

    const reponses: unknown[] = [];
    const evenement = {
      data: { type: TYPE_APERCU, roomId: SALON, eventId: EVENEMENT },
      ports: [{ postMessage: (valeur: unknown) => reponses.push(valeur) }],
    } as unknown as MessageEvent;

    for (const ecouteur of serviceWorker.ecouteurs) ecouteur(evenement);
    expect(reponses).toEqual([{ expediteur: "mira", texte: "on se voit demain ?" }]);
  });

  it("ne demande jamais la permission au premier lancement — seulement après un message", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });

    rendre(<PushNotifications indexedDB={base} />);

    // Session prête, aucun message reçu : rien n'est proposé.
    await waitFor(() => expect(notifierSalons).toBeDefined());
    expect(screen.queryByText(/Être prévenu/)).toBeNull();

    salons = [conversation(1)];
    act(() => notifierSalons!());
    expect(await screen.findByText(/Être prévenu/)).toBeTruthy();
    // Et la demande système passe par un geste, jamais par une invite surgie seule.
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Activer les notifications" })).toBeTruthy();
  });

  it("un refus laisse un chemin de rattrapage plutôt qu'un silence", async () => {
    const demander = vi.fn(async () => "denied");
    vi.stubGlobal("Notification", { permission: "default", requestPermission: demander });
    salons = [conversation(1)];

    rendre(<PushNotifications indexedDB={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Activer les notifications" }));

    expect(await screen.findByText(/Réglages › Notifications/)).toBeTruthy();
    expect(demander).toHaveBeenCalledOnce();
  });
});

/**
 * Les quatre retours utilisateurs, chacun sur sa cause. Ce ne sont pas
 * quatre symptômes d'un même défaut : la feuille qui revient, le bouton qui n'existe pas,
 * l'activation qui ne fait rien et le push qui n'arrive jamais ont quatre origines
 * distinctes, et une seule d'entre elles était visible depuis un poste de développement.
 */
describe("la proposition est faite une fois, et une seule", () => {
  const permissionParDefaut = () =>
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });

  it("« Plus tard » ferme définitivement : le `/sync` suivant ne la ramène pas", async () => {
    permissionParDefaut();
    salons = [conversation(1)];

    rendre(<PushNotifications indexedDB={base} />);
    fireEvent.click(await screen.findByRole("button", { name: "Plus tard" }));
    await waitFor(() => expect(screen.queryByText(/Être prévenu/)).toBeNull());

    // Le défaut exact : l'abonnement de `messaging` rappelait le déclencheur à chaque
    // synchronisation, et la feuille revenait — sans aucun moyen de s'en défaire.
    act(() => notifierSalons!());
    await waitFor(() => expect(notifierSalons).toBeDefined());
    expect(screen.queryByText(/Être prévenu/)).toBeNull();
  });

  it("un rechargement de l'application ne la repose pas non plus", async () => {
    permissionParDefaut();
    salons = [conversation(1)];

    const premier = rendre(<PushNotifications indexedDB={base} />);
    await screen.findByText(/Être prévenu/);
    premier.unmount();

    // Même base IndexedDB : c'est le même appareil, la question a déjà été posée.
    rendre(<PushNotifications indexedDB={base} />);
    await waitFor(() => expect(notifierSalons).toBeDefined());
    expect(screen.queryByText(/Être prévenu/)).toBeNull();
  });

  it("une permission accordée après le montage coupe le déclencheur", async () => {
    const permission = { permission: "default", requestPermission: vi.fn() };
    vi.stubGlobal("Notification", permission);

    rendre(<PushNotifications indexedDB={base} />);
    await waitFor(() => expect(notifierSalons).toBeDefined());

    // La permission est accordée ailleurs — l'écran des réglages, ou le navigateur.
    // L'effet ne se remonte pas pour autant : c'est la relecture **à chaque passage**
    // qui doit l'arrêter, et c'est elle qui manquait.
    permission.permission = "granted";
    salons = [conversation(1)];
    act(() => notifierSalons!());

    await waitFor(() => expect(notifierSalons).toBeDefined());
    expect(screen.queryByText(/Être prévenu/)).toBeNull();
    expect(permission.requestPermission).not.toHaveBeenCalled();
  });
});

describe("la chaîne se répare seule, et se dit quand elle ne le peut pas", () => {
  it("enregistre le pusher que Synapse ne porte pas encore, et le relit pour le croire", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });

    const diagnostic = await brancherPush(session());

    expect(diagnostic).toEqual({ etat: "abonne", permission: true, abonnement: true, pusher: true });
    expect(setPusher).toHaveBeenCalledOnce();
    const enregistre = setPusher.mock.calls[0]![0];
    expect(enregistre.pushkey).toBe(ENDPOINT);
    expect(enregistre.data).toMatchObject({
      url: PUSH_NOTIFY_URL,
      // Sans elles la passerelle rejette le pusher : les enregistrer sans
      // les clés, c'est enregistrer une panne.
      p256dh: "p256dh-test",
      auth: "auth-test",
    });
    // Plus de `event_id_only` : il retirait aussi l'expéditeur, seul repli app fermée.
    expect(enregistre.data.format).toBeUndefined();
  });

  it("réécrit un pusher resté en event_id_only, pour que l'expéditeur arrive", async () => {
    // Les appareils abonnés avant le changement : leur pusher existe, mais Synapse ne
    // leur enverrait jamais l'expéditeur. Le réparer à l'ouverture suffit à les migrer.
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    abonnement = faireAbonnement();
    pushers = [{ app_id: "org.tacita.web", pushkey: ENDPOINT, data: { format: "event_id_only" } }];

    await brancherPush(session());
    expect(setPusher).toHaveBeenCalledOnce();
  });

  it("ne réécrit rien quand les trois maillons sont déjà en place", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    abonnement = faireAbonnement();
    pushers = [{ app_id: "org.tacita.web", pushkey: ENDPOINT, data: {} }];

    expect((await brancherPush(session())).etat).toBe("abonne");
    expect(setPusher).not.toHaveBeenCalled();
    expect(serviceWorker.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("réenregistre le pusher quand le navigateur a tourné son abonnement", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    // L'endpoint enregistré sur le compte n'est plus celui du navigateur : c'est le cas
    // après un `pushsubscriptionchange`, et rien ne le signale à personne.
    abonnement = faireAbonnement(OCTETS_VAPID, "https://push.example/abonnement-2");
    pushers = [{ app_id: "org.tacita.web", pushkey: ENDPOINT, data: {} }];

    expect((await brancherPush(session())).etat).toBe("abonne");
    expect(setPusher.mock.calls[0]![0].pushkey).toBe("https://push.example/abonnement-2");
  });

  it("se réabonne quand l'abonnement porte une autre clé VAPID que la passerelle", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    // Clé régénérée au déploiement : le service push répond 403 et rien n'arrive jamais.
    const perime = faireAbonnement(new Uint8Array([9, 9, 9, 9]));
    abonnement = perime;

    expect((await brancherPush(session())).etat).toBe("abonne");
    expect(perime.unsubscribe).toHaveBeenCalledOnce();
    expect(serviceWorker.pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it("garde l'abonnement quand le navigateur n'expose pas sa clé", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    const opaque = { ...faireAbonnement(), options: {} };
    abonnement = opaque as unknown as ReturnType<typeof faireAbonnement>;

    expect((await brancherPush(session())).etat).toBe("abonne");
    // Se réabonner « dans le doute » changerait d'endpoint à chaque ouverture, et
    // laisserait un pusher mort derrière chaque fois.
    expect(serviceWorker.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("ne reste jamais suspendu quand aucun service worker n'est enregistré", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    // `navigator.serviceWorker.ready` **n'échoue pas** : sans enregistrement, elle
    // attend pour toujours. C'était le « ça ne fait rien » du bouton d'activation.
    serviceWorker.getRegistration.mockResolvedValue(undefined as never);

    const diagnostic = await brancherPush(session());
    expect(diagnostic).toEqual({
      etat: "a-reparer",
      permission: true,
      abonnement: false,
      pusher: false,
    });
  });

  it("dit « à réparer » quand la passerelle ne rend pas sa clé", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

    expect((await brancherPush(session())).etat).toBe("a-reparer");
    expect(setPusher).not.toHaveBeenCalled();
  });

  it("dit « à réparer » quand Synapse n'a pas gardé le pusher qu'on vient d'écrire", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    // Une promesse résolue ne prouve que l'acceptation du POST : c'est la relecture qui
    // prouve que Synapse appellera la passerelle.
    setPusher.mockResolvedValueOnce(undefined);

    const diagnostic = await brancherPush(session());
    expect(diagnostic).toMatchObject({ etat: "a-reparer", abonnement: true, pusher: false });
  });

  it("n'appelle jamais `requestPermission` hors d'un geste", async () => {
    const demander = vi.fn();
    vi.stubGlobal("Notification", { permission: "default", requestPermission: demander });

    const diagnostic = await brancherPush(session());
    expect(diagnostic.etat).toBe("possible");
    expect(demander).not.toHaveBeenCalled();
  });

  it("l'invite fermée sans réponse laisse la question ouverte, elle ne la referme pas", async () => {
    vi.stubGlobal("Notification", {
      permission: "default",
      requestPermission: vi.fn(async () => "default"),
    });

    expect((await demanderEtBrancher(session())).etat).toBe("possible");
  });
});

describe("les réglages disent l'état, et portent toujours l'action", () => {
  const reglages = () => rendre(<NotificationsPush />);

  it("affiche les trois maillons et laisse rebrancher une chaîne cassée", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });
    serviceWorker.getRegistration.mockResolvedValue(undefined as never);

    reglages();

    expect(await screen.findByText("Notifications interrompues")).toBeTruthy();
    expect(screen.getByText("Autorisation du navigateur")).toBeTruthy();
    expect(screen.getByText("Enregistrement sur votre compte")).toBeTruthy();
    // Le « bouton invisible » : l'ancienne table ne rendait d'action que pour une
    // permission jamais demandée. Tout appareil ayant déjà répondu n'avait plus rien.
    expect(screen.getByRole("button", { name: "Réactiver" })).toBeTruthy();
  });

  it("annonce « activées » seulement quand le pusher est vraiment sur le compte", async () => {
    vi.stubGlobal("Notification", { permission: "granted", requestPermission: vi.fn() });

    reglages();

    expect(await screen.findByText("Notifications activées")).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText("en place")).toHaveLength(3));
  });

  it("propose d'activer quand la permission n'a jamais été demandée", async () => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });

    reglages();
    expect(await screen.findByRole("button", { name: "Activer" })).toBeTruthy();
  });

  it("un refus n'offre pas de bouton qui ne pourrait qu'échouer", async () => {
    vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn() });

    reglages();
    expect(await screen.findByText("Notifications refusées")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sur iPhone hors écran d'accueil, dit le geste qui manque et pas « navigateur incapable »", async () => {
    // Safari hors standalone ne définit même pas `Notification` : lu dans le mauvais
    // ordre, le diagnostic devient « ce navigateur ne gère pas les notifications », ce
    // qui est faux et sans issue.
    vi.stubGlobal("Notification", undefined);
    vi.spyOn(globalThis.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
    );

    reglages();
    expect(await screen.findByRole("heading", { name: /écran d'accueil/ })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("un iPad en « site pour ordinateur » reçoit le même message qu'un iPhone", async () => {
    // iPadOS 13+ se présente comme un Macintosh, ce qui est son défaut sur grand écran.
    // Sans la seconde branche du prédicat, il tombe dans « navigateur incapable » — faux,
    // et sans issue, alors qu'il lui manque exactement le même geste.
    vi.stubGlobal("Notification", undefined);
    vi.spyOn(globalThis.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );
    // jsdom ne définit pas `maxTouchPoints` : c'est aussi pourquoi le prédicat la lit
    // avec un défaut, un navigateur sans la propriété ne devant pas passer pour un iPad.
    Object.defineProperty(globalThis.navigator, "maxTouchPoints", {
      value: 5,
      configurable: true,
    });

    reglages();
    expect(await screen.findByRole("heading", { name: /écran d'accueil/ })).toBeTruthy();
  });
});

/**
 * Le service worker est du JavaScript sans module : il s'évalue avec son `self` et son
 * `caches` fournis. C'est bien **le fichier livré** qui est exercé — un double
 * réimplémenté ici ne prouverait rien de ce qui part en production.
 */
function chargerServiceWorker() {
  const code = lire("public/sw.js");
  const handlers = new Map<string, (evenement: unknown) => void>();
  const notifications: { titre: string; options: Record<string, unknown> }[] = [];
  let fenetres: unknown[] = [];

  const self = {
    addEventListener: (type: string, handler: (evenement: unknown) => void) =>
      void handlers.set(type, handler),
    location: { origin: "https://app.tacita.test" },
    skipWaiting: vi.fn(),
    registration: {
      showNotification: (titre: string, options: Record<string, unknown>) => {
        notifications.push({ titre, options });
        return Promise.resolve();
      },
      // Les notifications réellement affichées : c'est ce que le badge compte.
      getNotifications: () => Promise.resolve(notifications),
    },
    navigator: {
      setAppBadge: vi.fn((_n: number) => Promise.resolve()),
      clearAppBadge: vi.fn(() => Promise.resolve()),
    },
    clients: {
      claim: vi.fn(),
      matchAll: () => Promise.resolve(fenetres),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
  };

  const caches = { open: vi.fn(), match: vi.fn(), keys: vi.fn(() => Promise.resolve([])) };
  new Function("self", "caches", code)(self, caches);

  return {
    handlers,
    notifications,
    caches,
    self,
    fenetresOuvertes: (liste: unknown[]) => (fenetres = liste),
  };
}

/** Une fenêtre qui répond à la demande d'aperçu, ou qui n'y répond pas. */
const fenetreQuiRepond = (reponse: unknown) => ({
  postMessage: (_message: unknown, transfert: MessagePort[]) => {
    if (reponse !== undefined) transfert[0]!.postMessage(reponse);
  },
  focus: () => Promise.resolve({ navigate: vi.fn() }),
});

async function pousser(sw: ReturnType<typeof chargerServiceWorker>, charge: unknown) {
  let attente: Promise<unknown> = Promise.resolve();
  sw.handlers.get("push")!({
    data: charge === undefined ? null : { json: () => charge },
    waitUntil: (promesse: Promise<unknown>) => (attente = promesse),
  });
  await attente;
}

describe("le service worker n'écrit rien, ne journalise rien, ne devine rien", () => {
  it("construit la notification à partir de l'aperçu rendu par la fenêtre", async () => {
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([fenetreQuiRepond({ expediteur: "mira", texte: "on se voit demain ?" })]);

    await pousser(sw, { event_id: EVENEMENT, room_id: SALON });

    expect(sw.notifications).toHaveLength(1);
    expect(sw.notifications[0]!.titre).toBe("mira");
    expect(sw.notifications[0]!.options.body).toBe("on se voit demain ?");
    // Groupées par conversation : un salon bavard remplace, il n'empile pas.
    expect(sw.notifications[0]!.options.tag).toBe(SALON);
  });

  it("réalerte à chaque message d'une même conversation", async () => {
    // `tag` sans `renotify` remplace **en silence** : à partir du deuxième message,
    // plus de son, plus de vibration, plus rien à l'écran verrouillé. Du point de vue
    // de l'utilisateur, c'est indiscernable d'une chaîne push cassée.
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([]);

    await pousser(sw, { event_id: EVENEMENT, room_id: SALON });
    expect(sw.notifications[0]!.options.renotify).toBe(true);
    // Sans icône, Android affiche un rond gris à la place de l'application.
    expect(sw.notifications[0]!.options.icon).toBe("/icone-192.png");
    expect(sw.notifications[0]!.options.badge).toBe("/icone-192.png");
  });

  it("sans déchiffrement possible, la notification est générique et silencieuse", async () => {
    const sw = chargerServiceWorker();
    // Aucune fenêtre ouverte : les clés Megolm sont hors de portée du service worker.
    sw.fenetresOuvertes([]);

    await pousser(sw, { event_id: EVENEMENT, room_id: SALON });

    expect(sw.notifications[0]!.titre).toBe("Nouveau message");
    expect(sw.notifications[0]!.options).toMatchObject({
      body: "",
      tag: SALON,
      data: { roomId: SALON, eventId: EVENEMENT },
    });
  });

  it("application fermée : la notification nomme l'expéditeur relayé, sans aperçu", async () => {
    // Aucune fenêtre pour déchiffrer — le cas nominal sur iOS.
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([]);

    await pousser(sw, { event_id: EVENEMENT, room_id: SALON, sender: "@alice:t", sender_display_name: "Alice" });
    expect(sw.notifications[0]!.titre).toBe("Nouveau message de Alice");
    expect(sw.notifications[0]!.options.body).toBe("");

    // Sans nom d'affichage, la partie locale de l'identifiant.
    await pousser(sw, { event_id: EVENEMENT, room_id: SALON, sender: "@ana:t" });
    expect(sw.notifications[1]!.titre).toBe("Nouveau message de ana");
  });

  it("une fenêtre qui ne sait pas déchiffrer donne le même résultat générique", async () => {
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([fenetreQuiRepond(null)]);

    await pousser(sw, { event_id: EVENEMENT, room_id: SALON });
    expect(sw.notifications[0]!.titre).toBe("Nouveau message");
    expect(sw.notifications[0]!.options.body).toBe("");
  });

  it("aucun contenu n'entre au cache, et aucun journal n'est écrit", async () => {
    const espions = (["log", "info", "warn", "error", "debug"] as const).map((niveau) =>
      vi.spyOn(console, niveau).mockImplementation(() => {}),
    );

    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([fenetreQuiRepond({ expediteur: "mira", texte: "secret" })]);
    await pousser(sw, { event_id: EVENEMENT, room_id: SALON });

    // Interdit n°8 : le réveil push n'a aucun chemin vers le cache — pas une précaution,
    // aucune branche n'y mène.
    expect(sw.caches.open).not.toHaveBeenCalled();
    for (const espion of espions) expect(espion).not.toHaveBeenCalled();
    for (const espion of espions) espion.mockRestore();
  });

  it("le fichier livré ne contient aucun appel de journalisation", () => {
    // Le test ci-dessus prouve le chemin exercé ; celui-ci ferme les autres. Un
    // `console.warn` ajouté demain dans une branche d'erreur porterait un identifiant
    // d'événement dans un journal que personne ne relit avant l'incident.
    expect(lire("public/sw.js")).not.toMatch(/console\./);
  });

  it("un réveil sans payload exploitable affiche quand même quelque chose", async () => {
    // `userVisibleOnly` est un contrat : un réveil muet fait afficher au navigateur
    // « ce site a été mis à jour en arrière-plan », puis finit par lui retirer la
    // permission — une panne définitive que l'utilisateur ne peut pas diagnostiquer.
    // La passerelle n'émet rien sans `room_id` : ce cas est une anomalie,
    // et « Nouveau message » y est plus vrai que le silence.
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([]);

    await pousser(sw, { event_id: EVENEMENT });
    expect(sw.notifications).toHaveLength(1);
    expect(sw.notifications[0]!.titre).toBe("Nouveau message");
  });

  it("le badge suit les notifications : il monte au push, retombe au tap", async () => {
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([]);

    await pousser(sw, { event_id: EVENEMENT, room_id: SALON });
    expect(sw.self.navigator.setAppBadge).toHaveBeenCalledWith(1);

    // Tap : la notification se ferme, plus rien en attente, le badge s'efface.
    sw.notifications.length = 0;
    let attente: Promise<unknown> = Promise.resolve();
    sw.handlers.get("notificationclick")!({
      notification: { close: vi.fn(), data: { roomId: SALON } },
      waitUntil: (promesse: Promise<unknown>) => (attente = Promise.all([attente, promesse])),
    });
    await attente;
    expect(sw.self.navigator.clearAppBadge).toHaveBeenCalled();
  });

  it("ouvrir une conversation ferme ses notifications, et seulement les siennes", async () => {
    const duSalon = { close: vi.fn() };
    const dAilleurs = { close: vi.fn() };
    const getNotifications = vi.fn((filtre?: { tag?: string }) =>
      Promise.resolve(filtre?.tag === SALON ? [duSalon] : [dAilleurs]),
    );
    const setAppBadge = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", {
      ...navigator,
      serviceWorker: { getRegistration: () => Promise.resolve({ getNotifications }) },
      setAppBadge,
    });

    await effacerNotifications(SALON);

    expect(duSalon.close).toHaveBeenCalled();
    expect(dAilleurs.close).not.toHaveBeenCalled();
    // Il reste la notification de l'autre conversation : le badge le dit.
    expect(setAppBadge).toHaveBeenCalledWith(1);
    vi.unstubAllGlobals();
  });

  it("prend la main dès son installation, sans attendre la fermeture des onglets", () => {
    // Une PWA installée ne ferme jamais tous ses onglets : sans ce couple, un worker
    // corrigé reste « en attente » et la correction n'atteint personne.
    const sw = chargerServiceWorker();
    let attente: Promise<unknown> = Promise.resolve();
    sw.caches.open.mockReturnValue(Promise.resolve({ addAll: () => Promise.resolve() }));
    sw.handlers.get("install")!({ waitUntil: (p: Promise<unknown>) => (attente = p) });

    return attente.then(() => expect(sw.self.skipWaiting).toHaveBeenCalled());
  });

  it("le tap sur la notification ouvre la conversation", async () => {
    const sw = chargerServiceWorker();
    const naviguer = vi.fn();
    sw.fenetresOuvertes([{ focus: () => Promise.resolve({ navigate: naviguer }) }]);

    let attente: Promise<unknown> = Promise.resolve();
    sw.handlers.get("notificationclick")!({
      notification: { close: vi.fn(), data: { roomId: SALON } },
      waitUntil: (promesse: Promise<unknown>) => (attente = promesse),
    });
    await attente;

    // Le service worker ne peut pas importer `lib/routes` : ce test est la seule
    // chose qui garde les deux gabarits alignés. Une notification qui ouvre une
    // route morte ne se voit nulle part ailleurs.
    expect(naviguer).toHaveBeenCalledWith(routeConversation(SALON));
  });

  it("un tap sur une fenêtre non contrôlée ouvre quand même la conversation", async () => {
    // `navigate` rejette sur un onglet ouvert avant l'installation du worker. Un tap
    // qui n'ouvre rien est la pire réponse possible.
    const sw = chargerServiceWorker();
    sw.fenetresOuvertes([
      { focus: () => Promise.resolve({ navigate: () => Promise.reject(new Error("non contrôlée")) }) },
    ]);

    let attente: Promise<unknown> = Promise.resolve();
    sw.handlers.get("notificationclick")!({
      notification: { close: vi.fn(), data: { roomId: SALON } },
      waitUntil: (promesse: Promise<unknown>) => (attente = promesse),
    });
    await attente;

    expect(sw.self.clients.openWindow).toHaveBeenCalledWith(routeConversation(SALON));
  });
});

describe("le client vise les adresses que le déploiement expose vraiment", () => {
  // `join` et non `new URL` : sous jsdom, le `URL` global est celui de jsdom, que
  // `node:fs` refuse (« The URL must be of scheme file »). Même lacune que celle déjà
  // documentée dans `tests/sources.ts`.
  const contratInfra = readFileSync(
    join(import.meta.dirname, "../../../infra/README.md"),
    "utf-8",
  );

  /**
   * Trouvé en montant la pile. Le shard visait une origine publique
   * `https://push.example.org`, qui n'existe dans aucun déploiement : la lecture de la
   * clé partait en 404, et le pusher enregistré pointait vers un hôte injoignable — donc
   * aucune notification n'aurait jamais été délivrée. Rien ne l'attrapait, parce que les
   * deux moitiés du contrat vivaient dans deux dépôts de vérité sans lien.
   */
  it("lit la clé VAPID là où le proxy la publie, derrière le homeserver", () => {
    expect(new URL(PUSH_CONFIG_URL).pathname).toBe("/push/config");
    // Et c'est bien ce que l'infra documente, pas une convention inventée ici.
    expect(contratInfra).toContain("/push/config");
  });

  it("enregistre le pusher sur l'adresse interne, jamais une URL publique", () => {
    // `/_matrix/push/v1/notify` n'a aucune authentification : la publier ferait de la
    // passerelle un relais de push ouvert. C'est Synapse qui appelle, depuis le réseau
    // du déploiement — l'adresse est donc interne par construction.
    expect(PUSH_NOTIFY_URL).toContain("/_matrix/push/v1/notify");
    expect(PUSH_NOTIFY_URL).not.toContain("push.example.org");
    expect(contratInfra).toContain(PUSH_NOTIFY_URL);
  });
});
