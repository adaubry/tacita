import { createServer } from "node:http";
import { notify, signalerPresence, type Notification } from "./notify.ts";

/** Au-delà, le corps est refusé : `/presence` est public, et un corps sans borne se lit sans fin. */
const CORPS_MAX = 1_000_000;

async function readBody(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let taille = 0;
  for await (const chunk of req) {
    taille += (chunk as Buffer).length;
    if (taille > CORPS_MAX) throw new Error("corps trop gros");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/** Passerelle Matrix Push Gateway → Web Push. `vapidPublicKey` est exposée pour l'abonnement client. */
export function createGateway(vapidPublicKey: string) {
  return createServer((req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      // méthode, chemin, statut. Jamais le corps de la requête.
      console.info("request", { method: req.method, url: req.url, status });
    };

    if (req.method === "GET" && req.url === "/config") {
      // clé publique VAPID, seule valeur nécessaire au client pour s'abonner.
      return json(200, { vapid_public_key: vapidPublicKey });
    }

    if (req.method === "POST" && req.url === "/_matrix/push/v1/notify") {
      // Un seul chemin d'échec : corps illisible, `notification` absente ou relais en panne → 400.
      return void readBody(req)
        .then((body) => {
          const notification = (body as { notification?: Notification }).notification;
          if (!notification) throw new Error("notification manquante");
          return notify(notification);
        })
        .then(
          (rejected) => json(200, { rejected }),
          () => json(400, { errcode: "M_BAD_JSON" }),
        );
    }

    if (req.method === "POST" && req.url === "/presence") {
      // La page dit qu'elle est (ou n'est plus) à l'écran : voir `signalerPresence`.
      return void readBody(req)
        .then((body) => {
          const { pushkey, visible } = body as { pushkey?: unknown; visible?: unknown };
          if (typeof pushkey !== "string" || !pushkey.startsWith("https://") || pushkey.length > 2048) {
            throw new Error("pushkey invalide");
          }
          signalerPresence(pushkey, visible === true);
        })
        .then(
          () => json(200, {}),
          () => json(400, { errcode: "M_BAD_JSON" }),
        );
    }

    return json(404, { errcode: "M_UNRECOGNIZED" });
  });
}
