import type { Session } from "@tacita/client-core";

/**
 * REQ-UI-18 — l'abonnement Web Push, de bout en bout : clé VAPID de la passerelle
 * (spec 03), permission navigateur, souscription, puis enregistrement du pusher auprès
 * de Synapse.
 *
 * Rien n'est journalisé ici, jamais (interdit n°8) : une souscription porte un endpoint
 * qui identifie l'appareil, et une trace d'erreur de push emporte facilement le payload.
 */

/** L'URL du pusher est le **nom interne** du service : c'est Synapse qui l'appelle, depuis
 *  le réseau du compose, jamais le navigateur (infra/README.md, REQ-INF-14). */
const URL_NOTIFY =
  process.env.NEXT_PUBLIC_PUSH_GATEWAY_URL ?? "http://push-gateway:8008/_matrix/push/v1/notify";

/** Fixé par le déploiement (infra/README.md) : Synapse le renvoie tel quel à la passerelle. */
const APP_ID = "org.tacita.web";

export type EtatPush =
  /** Ni Notification, ni PushManager : rien à proposer, et rien à promettre non plus. */
  | "non-supporte"
  /** Permission jamais demandée, ou accordée sans souscription active. */
  | "a-demander"
  /** Refus explicite du navigateur : seul l'utilisateur peut le lever (chemin M-H). */
  | "refuse"
  | "actif";

const supporte = (): boolean =>
  typeof Notification !== "undefined" &&
  typeof navigator !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in globalThis;

/**
 * L'état courant, lu et non mémorisé : la permission se change aussi depuis le navigateur.
 *
 * En développement, `serviceWorker.ready` **ne résout jamais** : `register-sw.tsx`
 * n'enregistre rien hors production. L'écran reste alors sur son état d'attente, ce qui est
 * le bon comportement — sans worker, il n'y a effectivement pas d'abonnement possible.
 */
export async function etatPush(): Promise<EtatPush> {
  if (!supporte()) return "non-supporte";
  if (Notification.permission === "denied") return "refuse";
  if (Notification.permission !== "granted") return "a-demander";

  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) ? "actif" : "a-demander";
}

/**
 * La clé VAPID est publiée en base64url ; `applicationServerKey` veut des octets. Cinq
 * lignes plutôt qu'une dépendance : `atob` ne connaît que le base64 standard, d'où les
 * deux substitutions et le rembourrage.
 */
function octetsDeLaCle(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binaire = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));

  // `new Uint8Array(n)` plutôt que `Uint8Array.from` : depuis TypeScript 5.7 le second
  // rend un tampon générique, que `applicationServerKey` refuse.
  const octets = new Uint8Array(binaire.length);
  for (let rang = 0; rang < binaire.length; rang += 1) octets[rang] = binaire.charCodeAt(rang);
  return octets;
}

/**
 * REQ-UI-18 — demande la permission puis abonne. Appelée **depuis un geste** (invite
 * après un premier message reçu, ou réglages), jamais au premier lancement : une
 * permission demandée avant qu'on sache ce qu'elle sert est une permission refusée.
 *
 * Rend l'état atteint. Une panne réseau sur la clé VAPID ou sur le pusher se propage :
 * l'appelant doit pouvoir dire « ça n'a pas marché » plutôt que d'afficher « actif ».
 */
export async function activerPush(session: Session): Promise<EtatPush> {
  if (!supporte()) return "non-supporte";
  if ((await Notification.requestPermission()) !== "granted") return "refuse";

  const registration = await navigator.serviceWorker.ready;
  const reponse = await fetch(new URL("/push/config", session.client.baseUrl));
  const { vapid_public_key } = (await reponse.json()) as { vapid_public_key: string };

  const abonnement =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      // Exigé par les navigateurs, et vrai chez nous : chaque réveil affiche une
      // notification, y compris quand le contenu reste indéchiffrable (REQ-UIX-40).
      userVisibleOnly: true,
      applicationServerKey: octetsDeLaCle(vapid_public_key),
    }));

  const cles = abonnement.toJSON().keys ?? {};

  /**
   * `p256dh` et `auth` sortent du type `data` du SDK, qui ne connaît que `url`, `format`
   * et `brand` — mais la passerelle en a besoin pour chiffrer le push, et sans elles elle
   * rejette la pushkey (REQ-PSH-01). Hors du littéral, TypeScript laisse passer les
   * champs supplémentaires : c'est la forme la plus honnête d'un type trop étroit.
   */
  const donnees = {
    url: URL_NOTIFY,
    // REQ-PSH-02 (amendée E-12) — **pas** de `format: "event_id_only"` : il retirait aussi
    // l'expéditeur, seul repli possible quand l'app est fermée. Synapse envoie donc
    // l'événement complet à la passerelle — contenu **chiffré**, jamais du clair — qui
    // n'en relaie au navigateur que les identifiants et l'expéditeur.
    p256dh: cles.p256dh,
    auth: cles.auth,
  };

  await session.client.setPusher({
    kind: "http",
    app_id: APP_ID,
    // L'endpoint **est** l'identifiant de la souscription côté passerelle (REQ-PSH-01).
    pushkey: abonnement.endpoint,
    app_display_name: "Tacita",
    device_display_name: session.client.getDeviceId() ?? "Navigateur",
    lang: "fr",
    data: donnees,
    append: false,
  });

  return "actif";
}
