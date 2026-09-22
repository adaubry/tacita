import webpush from "web-push";

/** Données de pusher enregistrées par le client (spec 11) : les clés de la subscription Web Push.
 *  L'endpoint n'y est pas répété — c'est la `pushkey`, qui identifie déjà la subscription. */
type PusherData = { p256dh?: string; auth?: string };
type Device = { pushkey?: string; data?: PusherData };

/** Payload `POST /_matrix/push/v1/notify` de Synapse (champs utilisés seulement). */
export type Notification = {
  event_id?: string;
  room_id?: string;
  /** Métadonnées que Synapse connaît en clair ; relayées pour le repli « Nouveau message de X ». */
  sender?: string;
  sender_display_name?: string;
  devices?: Device[];
};

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
        // REQ-PSH-02 (amendée E-12) : les deux identifiants et l'expéditeur, rien d'autre.
        // Synapse envoie l'événement entier (contenu chiffré, nom de salon…) : on ne relaie
        // que ces champs, listés un par un — jamais un `...notification`.
        const subscription = { endpoint: pushkey, keys: { p256dh: data.p256dh, auth: data.auth } };
        await webpush.sendNotification(
          subscription,
          JSON.stringify({ event_id, room_id, sender, sender_display_name }),
        );
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) rejected.push(pushkey);
        // REQ-PSH-04 : ID d'événement et code de statut, jamais le payload ni l'erreur brute.
        console.warn("push_failed", { event_id, status: status ?? 0 });
      }
    }),
  );
  return rejected;
}
