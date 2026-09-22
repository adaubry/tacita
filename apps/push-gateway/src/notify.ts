import webpush from "web-push";

/** Données de pusher enregistrées par le client : les clés de la subscription Web Push.
 *  L'endpoint n'y est pas répété — c'est la `pushkey`, qui identifie déjà la subscription. */
type PusherData = { p256dh?: string; auth?: string };
type Device = { pushkey?: string; data?: PusherData };

/** Payload `POST /_matrix/push/v1/notify` de Synapse (champs utilisés seulement). */
export type Notification = {
  event_id?: string;
  room_id?: string;
  /** Métadonnées que Synapse connaît en clair ; relayées pour « Nouveau message de X ». */
  sender?: string;
  sender_display_name?: string;
  devices?: Device[];
};

/**
 * Les quatre réglages d'émission, mesurés contre le comportement des services push et
 * non contre leurs valeurs par défaut :
 *
 * - `TTL` — le défaut de `web-push` est de **28 jours**. Un « nouveau message » remis
 *   trois semaines plus tard n'est plus une notification, c'est du bruit. Vingt-quatre
 *   heures couvrent une nuit et un téléphone éteint, et rien au-delà ;
 * - `urgency` — le défaut est `normal`, que les services push regroupent et diffèrent
 *   pour économiser la batterie. Une messagerie est le cas d'usage de `high` ;
 * - `timeout` — sans lui, un service push muet retient la requête de Synapse, qui a son
 *   propre délai et considérera le pusher en échec. Mieux vaut échouer vite : le message
 *   est de toute façon rattrapé par le `/sync` suivant.
 */
const OPTIONS = {
  TTL: 86_400,
  urgency: "high",
  timeout: 10_000,
  // Écrit alors que c'est déjà le défaut de `web-push@3.6.7` : **Apple n'accepte que
  // celui-ci**, et un défaut de bibliothèque qui change à la faveur d'un bump retirerait
  // silencieusement les iPhone du produit. Écrit ici, il est relu par un test.
  contentEncoding: "aes128gcm",
} as const;

/** Relaie une notification Synapse en Web Push ; retourne les pushkeys à supprimer. */
export async function notify(notification: Notification): Promise<string[]> {
  const { event_id, room_id, sender, sender_display_name, devices = [] } = notification;
  // Synapse envoie aussi des notifications sans event_id (mise à jour du badge seul) : rien à réveiller.
  if (!event_id || !room_id) return [];

  const rejected: string[] = [];
  await Promise.all(
    devices.map(async ({ pushkey, data }) => {
      if (!pushkey) return;
      if (!data?.p256dh || !data.auth) {
        rejected.push(pushkey); // pusher inutilisable : aucun push ne peut être chiffré pour lui
        return;
      }
      try {
        // Les deux identifiants et l'expéditeur, rien d'autre : le client déchiffre l'aperçu
        // après réveil, et l'expéditeur est le repli quand il ne le peut pas (app fermée).
        // Synapse envoie l'événement entier (contenu chiffré, nom de salon…) : les champs
        // sont listés un par un, jamais un `...notification`.
        const subscription = { endpoint: pushkey, keys: { p256dh: data.p256dh, auth: data.auth } };
        const envoi = await webpush.sendNotification(
          subscription,
          JSON.stringify({ event_id, room_id, sender, sender_display_name }),
          OPTIONS,
        );
        // un code de statut, rien d'autre. C'est la seule preuve qu'un
        // push est bien parti, et le seul endroit du déploiement où elle soit lisible.
        console.info("push_ok", { status: envoi?.statusCode ?? 0 });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) rejected.push(pushkey);
        // ID d'événement et code de statut, jamais le payload ni l'erreur brute.
        console.warn("push_failed", { event_id, status: status ?? 0 });
      }
    }),
  );
  return rejected;
}
