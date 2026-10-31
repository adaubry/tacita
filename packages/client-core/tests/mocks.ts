import { vi } from "vitest";

/**
 * matrix-js-sdk instrumenté (« suite Vitest avec matrix-js-sdk
 * mocké/instrumenté »). Chaque fichier de test fait :
 *
 *   vi.mock("matrix-js-sdk", async () => (await import("./mocks")).sdkModule());
 *
 * L'état est reconstruit à chaque test via `resetSdk()` : `initSession` verrouille
 * `setDeviceIsolationMode` en non-configurable, un objet partagé entre
 * tests serait donc figé dès le premier.
 */

export type CryptoMock = ReturnType<typeof makeCrypto>;
export type ClientMock = ReturnType<typeof makeClient>;

const state: { crypto: CryptoMock; client: ClientMock } = {
  crypto: null as unknown as CryptoMock,
  client: null as unknown as ClientMock,
};

export const createClient = vi.fn((_opts: unknown) => state.client);

export const IndexedDBStore = vi.fn((opts: unknown) => ({
  opts,
  startup: vi.fn(async () => {}),
}));

export const sdkModule = () => ({ createClient, IndexedDBStore });

function makeCrypto() {
  return {
    /**
     * `initSession` pose le mode puis remplace la méthode par le verrou
     * (`defineProperty`). Le spy ne survit donc pas à l'appel : on retient le mode
     * appliqué dans un champ, qui lui reste lisible.
     */
    isolationMode: undefined as unknown,
    setDeviceIsolationMode: vi.fn(function (this: CryptoMock, mode: unknown) {
      this.isolationMode = mode;
    }),
    getActiveSessionBackupVersion: vi.fn(async (): Promise<string | null> => "1"),
    /**
     * la source de `recoveryState()`. Par défaut l'appareil est signé :
     * le cas normal est une session déjà utilisable, et les tests qui veulent une porte
     * fermée le disent.
     */
    getDeviceVerificationStatus: vi.fn(
      async (_userId: string, _deviceId: string): Promise<{ signedByOwner: boolean } | null> => ({
        signedByOwner: true,
      }),
    ),
    /**
     * la seconde source de `recoveryState()`. `false` = ce compte n'a aucune
     * identité cross-signing, donc une inscription.
     *
     * C'est cette question-là et pas `getKeyBackupInfo()` : une sauvegarde peut exister
     * sans identité (inscription interrompue au dépôt), et aucune clé ne déverrouille
     * alors quoi que ce soit.
     */
    userHasCrossSigningKeys: vi.fn(async (): Promise<boolean> => false),
    getKeyBackupInfo: vi.fn(async (): Promise<unknown> => null),
    loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
    checkKeyBackupAndEnable: vi.fn(async () => null),
    isEncryptionEnabledInRoom: vi.fn(async (_roomId: string) => true),
    createRecoveryKeyFromPassphrase: vi.fn(async () => ({
      privateKey: new Uint8Array(32),
      encodedPrivateKey: "EsTb ABCD EFGH",
    })),
    /**
     * `authUploadDeviceSigningKeys` est typé ici parce que les tests d'UIA
     * le rappellent : c'est le SDK qui l'invoque en vrai, avec la requête à envoyer.
     */
    bootstrapCrossSigning: vi.fn(
      async (_opts: {
        setupNewCrossSigning?: boolean;
        authUploadDeviceSigningKeys?: (
          envoyer: (auth: unknown) => Promise<void>,
        ) => Promise<void>;
      }) => {},
    ),
    /**
     * Un secret storage déjà provisionné sur ce compte. Basculé par
     * `bootstrapSecretStorage` lui-même, pour qu'une seconde tentative rencontre l'état
     * que la première a laissé.
     */
    secretStorageAUneCle: false,
    /**
     * **Reproduit la garde du SDK épinglé**, `rust-crypto.js` v42.0.0 :
     *
     *     isNewSecretStorageKeyNeeded = setupNewSecretStorage || !(await hasAESKey())
     *
     * et `createSecretStorageKey` n'est appelé que si ce booléen est vrai.
     *
     * Le mock appelait la fabrique inconditionnellement. Il ne pouvait donc pas infirmer
     * l'hypothèse « le chemin de création est rejouable » — il la confirmait par
     * construction (règle 3), pendant qu'une seconde tentative levait pour de bon contre
     * le vrai SDK.
     */
    bootstrapSecretStorage: vi.fn(async function (
      this: CryptoMock,
      opts: {
        createSecretStorageKey?: () => Promise<unknown>;
        setupNewSecretStorage?: boolean;
      },
    ) {
      if (opts.setupNewSecretStorage || !this.secretStorageAUneCle) {
        await opts.createSecretStorageKey?.();
        this.secretStorageAUneCle = true;
      }
    }),
    // / D-08 — `needsUserApproval` est le signal du SDK pour « cet
    // utilisateur a changé d'identité depuis qu'on l'a vue ». Faux par défaut : le cas
    // normal est qu'il ne se passe rien.
    getUserVerificationStatus: vi.fn(async (_userId: string) => ({
      needsUserApproval: false,
    })),
    pinCurrentUserIdentity: vi.fn(async (_userId: string) => {}),
  };
}

function makeClient(crypto: CryptoMock) {
  return {
    loginRequest: vi.fn(async (_data: unknown) => ({
      access_token: "syt_access",
      user_id: "@bob:tacita.test",
      device_id: "DEVICE1",
    })),
    /**
     * l'inscription. Réussit du premier coup par défaut ; les tests qui
     * veulent l'UIA en deux étapes de Synapse la posent eux-mêmes, parce que c'est
     * exactement ce que le mock ne doit pas décider à leur place (règle 3).
     */
    registerRequest: vi.fn(
      async (
        _corps: { username?: string; password?: string; auth?: { type: string } },
      ): Promise<{ access_token?: string; user_id: string; device_id?: string }> => ({
        access_token: "syt_access",
        user_id: "@bob:tacita.test",
        device_id: "DEVICE1",
      }),
    ),
    initRustCrypto: vi.fn(async (_opts?: unknown) => {}),
    getCrypto: vi.fn((): CryptoMock | undefined => crypto),
    startClient: vi.fn(async (_opts?: unknown) => {}),
    /**
     * la validation du jeton à la reprise. Elle réussit par défaut : les
     * tests qui veulent un jeton refusé le disent explicitement, et ceux qui n'en
     * parlent pas ne doivent pas se voir refuser une session valable.
     */
    whoami: vi.fn(async () => ({ user_id: "@bob:tacita.test" })),
    /**
     * le secret storage tel que `unlockRecovery` l'interroge : quelle clé
     * protège ce compte, et celle qu'on lui présente est-elle la bonne. `checkKey` accepte
     * par défaut ; les tests de saisie fausse la font refuser.
     */
    secretStorage: {
      getKey: vi.fn(async (): Promise<[string, unknown] | null> => ["cleId", { algorithm: "m.secret_storage.v1.aes-hmac-sha2" }]),
      checkKey: vi.fn(async (_key: Uint8Array, _info: unknown) => true),
    },
    /**
     * la page de repli SSO que `setupRecoveryKey` fait ouvrir quand Synapse
     * exige une UIA pour remplacer une identité. Même forme que le SDK.
     */
    getFallbackAuthUrl: vi.fn(
      (loginType: string, sessionId: string) =>
        `https://tacita.test/_matrix/client/v3/auth/${loginType}/fallback/web?session=${sessionId}`,
    ),
    /**
     * l'appel direct au module Synapse (`connexionParCle`, `changerMotDePasse`).
     * Ce n'est pas une route de l'API Matrix : le SDK ne la connaît pas, il ne fait que
     * porter la requête. Rend `{}` par défaut ; les tests qui veulent un jeton de
     * connexion ou un refus le disent eux-mêmes.
     */
    http: {
      requestOtherUrl: vi.fn(
        async (_methode: unknown, _url: string, _corps?: unknown, _opts?: unknown): Promise<unknown> => ({}),
      ),
    },
    getAccessToken: vi.fn((): string | null => "syt_access"),
    baseUrl: "https://tacita.test",
    /**
     * les appareils du compte. Deux par défaut, dont celui de la session :
     * un compte à un seul appareil ne dirait rien de la distinction « le mien / les
     * autres », qui est tout ce que l'écran a à trancher.
     */
    getDevices: vi.fn(async () => ({
      devices: [
        { device_id: "DEVICE1", display_name: "Ce téléphone", last_seen_ts: 1_700_000_000_000 },
        { device_id: "AUTRE", display_name: "Portable", last_seen_ts: undefined },
      ] as { device_id: string; display_name?: string; last_seen_ts?: number }[],
    })),
    /**
     * la révocation. Elle exige une UIA côté serveur ; par défaut le mock
     * accepte, et les tests qui veulent le 401 le posent eux-mêmes (règle 3).
     */
    deleteMultipleDevices: vi.fn(async (_ids: string[], _auth?: unknown) => ({})),
    getRoom: vi.fn((_roomId: string): unknown => null),
    /**
     * la pagination arrière du SDK. Elle rend le salon, et c'est
     * `oldState.paginationToken` — mis à `null` par le SDK quand il n'y a plus rien en
     * amont — qui dit si l'historique est épuisé.
     */
    scrollback: vi.fn(async (room: unknown, _limit?: number) => room),
    logout: vi.fn(async (_stop?: boolean) => ({})),
    clearStores: vi.fn(async () => {}),
  };
}

/** À appeler dans un `beforeEach`. Rend un état frais, déjà branché sur les mocks. */
export function resetSdk(): { crypto: CryptoMock; client: ClientMock } {
  vi.clearAllMocks();
  state.crypto = makeCrypto();
  state.client = makeClient(state.crypto);
  return { crypto: state.crypto, client: state.client };
}

/** Un `MatrixEvent` réduit à ce que le module en lit. */
export function fakeEvent(id: string, originServerTs: number) {
  return {
    getId: () => id,
    getRoomId: () => "!salon:tacita.test",
    getType: () => "m.room.message",
    getTs: () => originServerTs,
  };
}

/**
 * Une `Room` réduite à ce que le module en lit : sa timeline vive, et le jeton de
 * pagination de son ancien état. Un jeton présent = il reste de l'historique
 * en amont ; `null` = début du salon.
 */
export function fakeRoom(events: unknown[], paginationToken: string | null = "t42") {
  return {
    getLiveTimeline: () => ({ getEvents: () => events }),
    oldState: { paginationToken },
  };
}
