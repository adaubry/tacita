/**
 * Les trois adresses de déploiement du shard. Aucune n'est un secret : elles sont
 * publiques dès le premier appel réseau du client. Elles sont ici, ensemble, parce
 * qu'un `process.env` recopié dans trois composants diverge au premier renommage.
 */

/** Homeserver Synapse, derrière le proxy TLS. */
export const HOMESERVER = process.env.NEXT_PUBLIC_HOMESERVER_URL ?? "https://chat.example.org";

/**
 * Notre déploiement Element Call, embarqué en widget (M-I). Servi sous son
 * propre nom d'hôte par l'overlay RTC — le défaut suit `call.<SERVER_NAME>`
 * de `infra/.env.example`, pas une adresse inventée.
 */
export const ELEMENT_CALL_URL =
  process.env.NEXT_PUBLIC_ELEMENT_CALL_URL ?? "https://call.chat.example.org";

/**
 * Passerelle Web Push — **deux adresses distinctes, et c'est voulu.**
 *
 * La clé publique VAPID sort par le proxy, sur `<homeserver>/push/config` : c'est la
 * seule chose de la passerelle qui soit publique. Il n'y a donc pas
 * d'« origine de la passerelle » à configurer côté client — elle vit derrière le
 * homeserver.
 *
 * L'URL de notification, elle, est **interne au réseau du déploiement** : c'est Synapse
 * qui l'appelle, et `/_matrix/push/v1/notify` n'a aucune authentification (la
 * subscription complète arrive dans le payload). La publier ferait de la passerelle un
 * relais de push ouvert. Le client ne peut pas la deviner — il l'enregistre telle que le
 * déploiement la lui donne, d'où cette variable.
 *
 * Corrigé en montant la pile : le shard visait une origine publique
 * `https://push.example.org` qui n'existe dans aucun déploiement. Les deux appels
 * échouaient — la lecture de la clé en 404, et le pusher enregistré pointait vers un
 * hôte injoignable, donc aucune notification n'aurait jamais été délivrée.
 */
export const PUSH_CONFIG_URL = `${HOMESERVER.replace(/\/$/, "")}/push/config`;

/** La page y signale qu'elle est à l'écran : la passerelle ne lui pousse rien pendant ce temps. */
export const PUSH_PRESENCE_URL = `${HOMESERVER.replace(/\/$/, "")}/push/presence`;

export const PUSH_NOTIFY_URL =
  process.env.NEXT_PUBLIC_PUSH_NOTIFY_URL ?? "http://push-gateway:8008/_matrix/push/v1/notify";
