import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { createGateway } from "../src/server.ts";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() } }));
const sendNotification = vi.mocked(webpush.sendNotification);

const VAPID_PUBLIC_KEY = "BK7uT3xk-test-public-key";
const server = createGateway(VAPID_PUBLIC_KEY);
const url = (path: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;

beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
afterAll(() => new Promise((resolve) => server.close(resolve)));
afterEach(() => vi.restoreAllMocks());

const device = (pushkey: string) => ({
  app_id: "org.tacita.web",
  pushkey,
  data: { p256dh: "p256dh-" + pushkey, auth: "auth-" + pushkey },
});

/** Payload tel que Synapse l'émet : il contient du contenu en clair, la passerelle ne doit rien en relayer. */
const synapsePayload = (devices: unknown[]) => ({
  notification: {
    event_id: "$evt:tacita.chat",
    room_id: "!room:tacita.chat",
    type: "m.room.message",
    sender: "@alice:tacita.chat",
    sender_display_name: "Alice",
    room_name: "Vacances",
    content: { msgtype: "m.text", body: "rendez-vous à 18h" },
    counts: { unread: 2 },
    devices,
  },
});

const postNotify = (body: unknown) =>
  fetch(url("/_matrix/push/v1/notify"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const gone = (statusCode: number) => Object.assign(new Error("dead subscription"), { statusCode });

describe("endpoint /_matrix/push/v1/notify conforme", () => {
  it("relaie un payload Synapse valide vers la subscription et ne rejette rien", async () => {
    const response = await postNotify(synapsePayload([device("https://push.example/ep1")]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ rejected: [] });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0]?.[0]).toEqual({
      endpoint: "https://push.example/ep1",
      keys: { p256dh: "p256dh-https://push.example/ep1", auth: "auth-https://push.example/ep1" },
    });
  });

  it.each([410, 404])("rejette la pushkey quand le push service répond %i", async (statusCode) => {
    sendNotification.mockRejectedValueOnce(gone(statusCode));

    const response = await postNotify(synapsePayload([device("https://push.example/dead")]));

    await expect(response.json()).resolves.toEqual({ rejected: ["https://push.example/dead"] });
  });

  it("ne rejette pas sur une panne passagère du push service (500)", async () => {
    sendNotification.mockRejectedValueOnce(gone(500));

    const response = await postNotify(synapsePayload([device("https://push.example/flaky")]));

    await expect(response.json()).resolves.toEqual({ rejected: [] });
  });

  it("rejette un pusher sans clés de chiffrement, qu'aucun push ne peut atteindre", async () => {
    const response = await postNotify(synapsePayload([{ pushkey: "https://push.example/bare" }]));

    await expect(response.json()).resolves.toEqual({ rejected: ["https://push.example/bare"] });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("n'émet aucun push pour une notification de badge seul (sans event_id)", async () => {
    const response = await postNotify({
      notification: { counts: { unread: 3 }, devices: [device("https://push.example/ep1")] },
    });

    await expect(response.json()).resolves.toEqual({ rejected: [] });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each(["{", "{}"])("répond 400 sur un corps inexploitable (%s)", async (body) => {
    const response = await fetch(url("/_matrix/push/v1/notify"), { method: "POST", body });

    expect(response.status).toBe(400);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("l'émission est réglée pour une messagerie, pas pour un bulletin", () => {
  /**
   * Trois valeurs posées à une jonction que **personne ne relit** — la règle 7. Elles ne
   * changent rien à un test fonctionnel, et tout à ce que l'utilisateur reçoit :
   * un défaut de `web-push` remettrait un « nouveau message » vingt-huit jours plus tard,
   * en `urgency: normal` que les services push regroupent et diffèrent, et le jour où la
   * bibliothèque changerait son encodage par défaut, **les iPhone sortiraient du produit
   * en silence** — Apple n'accepte que `aes128gcm`.
   */
  it("borne la durée de vie, priorise la remise, et fixe l'encodage exigé par Apple", async () => {
    await postNotify(synapsePayload([device("https://push.example/ep1")]));

    expect(sendNotification.mock.calls[0]?.[2]).toMatchObject({
      TTL: 86_400,
      urgency: "high",
      contentEncoding: "aes128gcm",
    });
    // Sans délai, un service push muet retient la requête de Synapse jusqu'à son propre
    // abandon, et le pusher passe pour défaillant.
    expect(sendNotification.mock.calls[0]?.[2]?.timeout).toBeGreaterThan(0);
  });
});

describe("le payload sortant : les deux identifiants et l'expéditeur, rien d'autre", () => {
  it("relaie l'expéditeur, jamais le nom de salon ni le contenu", async () => {
    // Le fixture est un événement Synapse complet, contenu compris : c'est ce que la
    // passerelle reçoit, le pusher n'étant plus en `event_id_only`.
    await postNotify(synapsePayload([device("https://push.example/ep1")]));

    const payload = JSON.parse(String(sendNotification.mock.calls[0]?.[1]));
    expect(payload).toEqual({
      event_id: "$evt:tacita.chat",
      room_id: "!room:tacita.chat",
      sender: "@alice:tacita.chat",
      sender_display_name: "Alice",
    });
    expect(JSON.stringify(payload)).not.toMatch(/rendez-vous|Vacances|body|content/);
  });
});

describe("clé publique VAPID exposée pour l'abonnement client", () => {
  it("GET /config retourne la clé publique et rien d'autre", async () => {
    const response = await fetch(url("/config"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ vapid_public_key: VAPID_PUBLIC_KEY });
  });
});

describe("aucun contenu utilisateur dans les logs", () => {
  const spyConsole = () => {
    const lines: string[] = [];
    const record = (...args: unknown[]) => void lines.push(args.map((a) => JSON.stringify(a)).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation(record);
    }
    return lines;
  };
  const secrets = ["rendez-vous à 18h", "Alice", "@alice:tacita.chat", "Vacances", "p256dh-", "auth-"];

  it("ne logge rien du payload entrant sur un push réussi", async () => {
    const lines = spyConsole();

    await postNotify(synapsePayload([device("https://push.example/ep1")]));

    expect(lines.join("\n")).not.toMatch(new RegExp(secrets.join("|")));
  });

  it("laisse une trace du push réussi — un code de statut, et rien d'autre", async () => {
    // La seule preuve, depuis le déploiement, que Synapse a bien appelé la passerelle et
    // que le service push a accepté. **Aucun de ces maillons n'est observable depuis un
    // poste de développement** ; `docker compose logs push-gateway` est le seul endroit
    // où la chaîne se lit, et une chaîne qu'on ne peut pas lire ne se répare pas.
    const lines = spyConsole();
    sendNotification.mockResolvedValueOnce({ statusCode: 201, body: "", headers: {} });

    await postNotify(synapsePayload([device("https://push.example/ep1")]));

    const logs = lines.join("\n");
    expect(logs).toContain("push_ok");
    expect(logs).toContain("201");
    expect(logs).not.toMatch(new RegExp(secrets.join("|")));
  });

  it("ne logge qu'un ID d'événement et un code de statut quand le push échoue", async () => {
    const lines = spyConsole();
    sendNotification.mockRejectedValueOnce(gone(410));

    await postNotify(synapsePayload([device("https://push.example/dead")]));

    const logs = lines.join("\n");
    expect(logs).not.toMatch(new RegExp(secrets.join("|")));
    expect(logs).toContain("push_failed");
    expect(logs).toContain("410");
  });
});
