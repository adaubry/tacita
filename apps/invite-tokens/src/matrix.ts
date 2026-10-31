/**
 * Les quatre seules requêtes Matrix du service. Toutes sont des **lectures faites au nom
 * de l'appelant, avec le jeton de l'appelant** : le service ne détient aucun jeton
 * d'administration, aucun droit d'inviter, aucun droit de créer un salon.
 */
export interface MatrixReader {
  /** l'identité vient de Synapse, jamais du corps de la requête. */
  whoami(accessToken: string): Promise<string | undefined>;
  /** l'appelant a-t-il mis `other` dans son `m.ignored_user_list` ? */
  ignores(accessToken: string, self: string, other: string): Promise<boolean>;
  /** un compte désactivé n'a plus de profil lisible. */
  accountExists(accessToken: string, userId: string): Promise<boolean>;
  /**
   * l'appelant est-il membre de `roomId` ? Lu dans **sa propre** liste de salons
   * (`joined_rooms`), avec son jeton : aucun état de salon, aucun droit de plus. Sans ce
   * contrôle, n'importe quel compte émettait un lien de groupe pour un salon étranger
   * (relevé en pentest, confirmé en ligne).
   */
  isMember(accessToken: string, roomId: string): Promise<boolean>;
}

type Fetch = typeof globalThis.fetch;

export function createMatrixReader(homeserverUrl: string, doFetch: Fetch = fetch): MatrixReader {
  const call = async (path: string, accessToken: string): Promise<unknown | undefined> => {
    try {
      const response = await doFetch(new URL(path, homeserverUrl), {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      // Un homeserver injoignable ne doit pas se distinguer d'un jeton invalide : les
      // deux rendent `undefined`, et l'appelant traite les deux en échec.
      return undefined;
    }
  };

  return {
    async whoami(accessToken) {
      const body = (await call("/_matrix/client/v3/account/whoami", accessToken)) as
        | { user_id?: unknown }
        | undefined;
      return typeof body?.user_id === "string" ? body.user_id : undefined;
    },

    async ignores(accessToken, self, other) {
      const body = (await call(
        `/_matrix/client/v3/user/${encodeURIComponent(self)}/account_data/m.ignored_user_list`,
        accessToken,
      )) as { ignored_users?: Record<string, unknown> } | undefined;
      // Absent = personne n'est ignoré ; c'est le cas courant et il rend 404.
      return Object.hasOwn(body?.ignored_users ?? {}, other);
    },

    async accountExists(accessToken, userId) {
      const profile = await call(
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
        accessToken,
      );
      return profile !== undefined;
    },

    async isMember(accessToken, roomId) {
      const body = (await call("/_matrix/client/v3/joined_rooms", accessToken)) as
        | { joined_rooms?: unknown }
        | undefined;
      return Array.isArray(body?.joined_rooms) && body.joined_rooms.includes(roomId);
    },
  };
}
