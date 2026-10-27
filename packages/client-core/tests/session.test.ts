import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import {
  AllDevicesIsolationMode,
  OnlySignedDevicesIsolationMode,
} from "matrix-js-sdk/lib/crypto-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createClient, IndexedDBStore, resetSdk, type ClientMock, type CryptoMock } from "./mocks";
import { initSession, restoreSession, type SessionConfig } from "../src";

vi.mock("matrix-js-sdk", async () => (await import("./mocks")).sdkModule());

// Le store SDK est mocké, mais celui des credentials est du vrai IndexedDB : c'est
// lui qu'on teste en. Neuf à chaque test, sinon les sessions débordent
// de l'un sur l'autre.
let config: SessionConfig;

const readSrc = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf-8");
const sources = ["index.ts", "logger.ts", "session.ts"].map(readSrc).join("\n");

/** Les interdits portent sur ce que le module exécute, pas sur ce qu'il documente. */
const code = sources.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Options passées au client définitif (le premier `createClient` ne sert qu'au login). */
const clientOpts = () => createClient.mock.calls.at(-1)![0] as { store: { startup: unknown } };

let crypto: CryptoMock;
let client: ClientMock;

beforeEach(() => {
  ({ crypto, client } = resetSdk());
  config = {
    homeserverUrl: "https://tacita.test",
    identifiant: "bob",
    motDePasse: "motdepasse-essai",
    indexedDB: new IDBFactory(),
  };
});

describe("crypto vodozemac via initRustCrypto, libolm interdit", () => {
  it("initSession initialise la crypto Rust", async () => {
    await initSession(config);
    expect(client.initRustCrypto).toHaveBeenCalledOnce();
    expect(client.initRustCrypto).toHaveBeenCalledWith(
      expect.objectContaining({ useIndexedDB: true }),
    );
  });

  it("aucune session n'est rendue si la crypto n'est pas disponible", async () => {
    client.getCrypto.mockReturnValue(undefined);
    await expect(initSession(config)).rejects.toThrow(/crypto non initialisée/);
  });

  it("le graphe de dépendances installé ne contient pas libolm", () => {
    const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf-8");
    expect(lock).not.toMatch(/@matrix-org\/olm@/);
    expect(lock).not.toMatch(/(^|[/\s])olm@\d/m);
    // vodozemac est livré par ce paquet wasm : sa présence confirme le bon backend.
    expect(lock).toMatch(/@matrix-org\/matrix-sdk-crypto-wasm@/);
  });

  it("aucun code du module n'importe libolm", () => {
    expect(code).not.toMatch(/olm/i);
  });
});

describe("chiffrement sur l'appareil avant tout envoi réseau", () => {
  it("la crypto est prête avant que la boucle /sync ne démarre", async () => {
    await initSession(config);
    const cryptoReady = client.initRustCrypto.mock.invocationCallOrder[0]!;
    const syncStarted = client.startClient.mock.invocationCallOrder[0]!;
    expect(cryptoReady).toBeLessThan(syncStarted);
  });

  it("aucun client n'échappe au module si l'initialisation crypto échoue", async () => {
    client.initRustCrypto.mockRejectedValueOnce(new Error("wasm indisponible"));
    await expect(initSession(config)).rejects.toThrow("wasm indisponible");
    expect(client.startClient).not.toHaveBeenCalled();
  });
});

describe("persistance exclusivement IndexedDB", () => {
  it("le store passé au client est un IndexedDBStore démarré", async () => {
    await initSession(config);
    expect(IndexedDBStore).toHaveBeenCalledWith({
      indexedDB: config.indexedDB,
      dbName: "tacita",
    });
    expect(clientOpts().store.startup).toHaveBeenCalledOnce();
  });

  it("le store est démarré après avoir été confié au client, jamais avant", async () => {
    await initSession(config);

    // Le vrai SDK lève « must be called after assigning it to the client » — mais
    // seulement en relisant un store existant, donc jamais au premier lancement ni
    // sur un mock. Seul l'ordre est observable ici ; c'est lui qu'on fige.
    const clientCréé = createClient.mock.invocationCallOrder.at(-1)!;
    const storeDémarré = (clientOpts().store.startup as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]!;
    expect(clientCréé).toBeLessThan(storeDémarré);
  });

  it("la crypto persiste elle aussi dans IndexedDB, dans un magasin par appareil", async () => {
    await initSession(config);

    // Le nom du magasin est dérivé du `device_id` et non laissé au défaut fixe du
    // SDK : un magasin de clés appartient à un appareil, pas à un navigateur. Sans
    // ça, deux identités dans le même profil se marchent dessus et le SDK refuse
    // d'ouvrir un magasin qui appartient à quelqu'un d'autre.
    expect(client.initRustCrypto).toHaveBeenCalledWith({
      useIndexedDB: true,
      cryptoDatabasePrefix: "matrix-js-sdk-DEVICE1",
    });
  });

  it("aucun code du module ne touche localStorage ni sessionStorage", () => {
    expect(code).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("/sync est du long-polling HTTP, jamais du WebSocket", () => {
  it("la boucle /sync est ouverte par startClient", async () => {
    await initSession(config);
    expect(client.startClient).toHaveBeenCalledWith({ initialSyncLimit: 20 });
  });

  it("ni le code ni la doc du package ne décrivent le transport comme du WebSocket", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    expect(sources).not.toMatch(/web\s?socket/i);
    expect(readme).not.toMatch(/web\s?socket/i);
  });
});

describe("clés Megolm partagées avec les seuls appareils signés", () => {
  it("le mode d'isolation « appareils signés uniquement » est posé", async () => {
    await initSession(config);
    expect(crypto.isolationMode).toBeInstanceOf(OnlySignedDevicesIsolationMode);
  });

  it("le mode est verrouillé : tout desserrage lève", async () => {
    await initSession(config);

    // `AllDevicesIsolationMode` est l'autre mode du SDK : celui qui repartagerait
    // avec des appareils non signés. C'est exactement ce que D-08 refuse.
    expect(() => crypto.setDeviceIsolationMode(new AllDevicesIsolationMode(false))).toThrow(
      //
    );
    expect(crypto.isolationMode).toBeInstanceOf(OnlySignedDevicesIsolationMode);
  });

  it("reposer le même mode ne lève pas : le verrou vise le desserrage, pas l'idempotence", async () => {
    await initSession(config);
    expect(() =>
      crypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode()),
    ).not.toThrow();
  });

  it("identityResetOf rend true quand le SDK signale un changement d'identité", async () => {
    crypto.getUserVerificationStatus.mockResolvedValue({ needsUserApproval: true });
    const session = await initSession(config);

    // D-08 — l'UI bloque l'envoi vers cet utilisateur jusqu'à confirmation
    // explicite. Le module remonte l'état ; il ne décide pas de l'écran.
    await expect(session.identityResetOf("@bob:tacita.test")).resolves.toBe(true);
    expect(crypto.getUserVerificationStatus).toHaveBeenCalledWith("@bob:tacita.test");
  });

  it("rend false dans le cas normal, sans rien exiger de l'UI", async () => {
    const session = await initSession(config);
    await expect(session.identityResetOf("@bob:tacita.test")).resolves.toBe(false);
  });

  it("est un prédicat : il ne lève jamais, et le repli n'affaiblit rien", async () => {
    // Repli permissif assumé : la protection vient du mode d'isolation, qui fait lever
    // le chiffrement à l'envoi si l'identité a changé. Replier sur `true` bloquerait
    // tout envoi à la moindre panne passagère du crypto, pour un gain nul.
    crypto.getUserVerificationStatus.mockRejectedValue(new Error("crypto pas prête"));
    const session = await initSession(config);
    await expect(session.identityResetOf("@bob:tacita.test")).resolves.toBe(false);
  });

  it("confirmIdentityOf épingle la nouvelle identité : l'envoi peut repartir", async () => {
    const session = await initSession(config);
    await session.confirmIdentityOf("@bob:tacita.test");
    expect(crypto.pinCurrentUserIdentity).toHaveBeenCalledWith("@bob:tacita.test");
  });

  it("une confirmation qui échoue le dit, plutôt que de laisser l'UI débloquer", async () => {
    // Le SDK lève sur notre propre identifiant, ou sur un utilisateur sans identité
    // connue. Avaler l'erreur ferait croire à l'UI que l'envoi est rouvert alors que le
    // chiffrement refusera toujours — c'est le contraire de l'interdit n°13.
    crypto.pinCurrentUserIdentity.mockRejectedValueOnce(new Error("identité inconnue"));
    const session = await initSession(config);
    await expect(session.confirmIdentityOf("@inconnu:tacita.test")).rejects.toThrow(
      /identité inconnue/,
    );
  });

  it("le contrat V1 n'annonce plus de vérification interactive", () => {
    // D-08 renvoie SAS/QR au post-V1, dans sa spec dédiée. Un exporté sans appelant sur
    // un chemin de clés est un piège : interdit n°13, on n'annonce pas ce qu'on ne rend
    // pas. `@tacita/client-core` a perdu la ligne en même temps.
    expect(code).not.toMatch(/verifyDevice|requestDeviceVerification/);
  });

  it("le module ne s'appuie plus sur le drapeau que ce mode rend inopérant", () => {
    // Le SDK documente « Ignored when deviceIsolationMode is
    // OnlySignedDevicesIsolationMode » : verrouiller `globalBlacklistUnverifiedDevices`
    // donnerait une garantie que le SDK n'applique pas. L'override par salon qui
    // primait dessus perd son emprise par la même occasion.
    expect(code).not.toMatch(/globalBlacklistUnverifiedDevices/);
    expect(code).not.toMatch(/setBlacklistUnverifiedDevices/);
  });
});

describe("l'état de chiffrement est un prédicat, pas une assertion", () => {
  it("rend true quand le SDK dit que le salon est chiffré", async () => {
    crypto.isEncryptionEnabledInRoom.mockResolvedValue(true);
    const session = await initSession(config);
    expect(await session.isEncrypted("!salon:tacita.test")).toBe(true);
  });

  it("rend false plutôt que de lever quand l'état du salon est inconnu", async () => {
    // Avant le premier /sync abouti, le SDK peut lever. Dans le doute, on n'envoie
    // pas : c'est un prédicat, il ne remonte jamais d'exception à la garde d'envoi.
    crypto.isEncryptionEnabledInRoom.mockRejectedValue(new Error("état non chargé"));
    const session = await initSession(config);
    await expect(session.isEncrypted("!inconnu:tacita.test")).resolves.toBe(false);
  });

  it("ne mémorise rien : une garde qui ment est pire que pas de garde", async () => {
    crypto.isEncryptionEnabledInRoom.mockResolvedValue(true);
    const session = await initSession(config);
    await session.isEncrypted("!salon:tacita.test");
    await session.isEncrypted("!salon:tacita.test");
    expect(crypto.isEncryptionEnabledInRoom).toHaveBeenCalledTimes(2);
  });
});

describe("identifiant et mot de passe, portés par Synapse", () => {
  it("se connecte par mot de passe et construit le client avec ses credentials", async () => {
    await initSession(config);
    /*
     * `m.id.user` et non l'identifiant complet : Synapse accepte les deux, mais l'écran
     * demande un nom d'utilisateur. Le compléter en `@nom:serveur` ici ferait échouer
     * quiconque a tapé son identifiant entier.
     */
    expect(client.loginRequest).toHaveBeenCalledWith({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: "bob" },
      password: "motdepasse-essai",
    });
    expect(clientOpts()).toMatchObject({
      accessToken: "syt_access",
      userId: "@bob:tacita.test",
      deviceId: "DEVICE1",
    });
  });

  it("le mot de passe traverse le module, il n'y est jamais conservé", () => {
    /*
     * Réécrit. L'assertion était `code` sans aucun `password` —
     * elle ne peut plus tenir, le module portant désormais la connexion. Ce qui reste
     * vrai et qui compte : rien ne le range. `StoredCredentials` est le seul objet écrit
     * en IndexedDB, et il ne porte que le jeton et l'identité d'appareil.
     */
    expect(code).toMatch(/interface StoredCredentials \{[^}]*\}/);
    const stocke = /interface StoredCredentials \{([^}]*)\}/.exec(code)![1]!;
    expect(stocke).not.toMatch(/password|motDePasse/i);
    // Et aucune trace du mot de passe dans un log : le seul sink est `createLogger`.
    expect(code).not.toMatch(/log\.[a-z]+\([^)]*motDePasse/);
  });
});

describe("reprise de session sans réseau", () => {
  it("rouvre la session précédente sans redemander le mot de passe", async () => {
    await initSession(config);

    // Rechargement de page : objets SDK neufs, même IndexedDB. C'est aussi ce qui
    // rend la crypto neuve — `initSession` verrouille la sienne, et la reverrouiller
    // lèverait.
    ({ crypto, client } = resetSdk());

    const reprise = await restoreSession(config);

    expect(reprise).not.toBeNull();
    // L'assertion qui compte : aucune requête de login, donc aucun réseau requis.
    expect(client.loginRequest).not.toHaveBeenCalled();
    expect(clientOpts()).toMatchObject({
      accessToken: "syt_access",
      userId: "@bob:tacita.test",
      deviceId: "DEVICE1",
    });
  });

  it("rend null quand aucune session locale n'existe, sans rien tenter", async () => {
    expect(await restoreSession(config)).toBeNull();
    expect(client.loginRequest).not.toHaveBeenCalled();
    expect(client.startClient).not.toHaveBeenCalled();
  });

  it("la déconnexion referme la porte : plus rien à reprendre", async () => {
    const session = await initSession(config);
    await session.logout();

    expect(await restoreSession(config)).toBeNull();
  });

  it("un échec de restauration rend null sans détruire ce qui pourrait resservir", async () => {
    await initSession(config);
    ({ crypto, client } = resetSdk());
    client.initRustCrypto.mockRejectedValueOnce(new Error("wasm indisponible"));

    // Ni exception, ni session bancale : l'UI n'a qu'un chemin, l'OIDC.
    expect(await restoreSession(config)).toBeNull();

    // Mais la panne était passagère. Effacer les credentials aurait force un OIDC,
    // donc du réseau — ce que l'utilisateur hors ligne n'a justement pas.
    ({ crypto, client } = resetSdk());
    expect(await restoreSession(config)).not.toBeNull();
  });
});

describe("un jeton refusé ne rouvre pas la session", () => {
  it("un `M_UNKNOWN_TOKEN` à la reprise rend null et efface les credentials", async () => {
    // Mesuré au navigateur : jeton révoqué côté serveur, page rechargée,
    // et l'application se rouvrait entièrement — liste des conversations comprise. Le
    // refus n'arrivait que plus tard, dans /sync, où le gestionnaire de sauvegarde du
    // SDK l'avalait sans que rien ne remonte à l'UI.
    await initSession(config);
    ({ crypto, client } = resetSdk());
    client.whoami.mockRejectedValueOnce(
      Object.assign(new Error("Invalid access token"), { errcode: "M_UNKNOWN_TOKEN", httpStatus: 401 }),
    );

    expect(await restoreSession(config)).toBeNull();

    // Effacés : garder un jeton que le serveur refuse ne peut que refaire échouer la
    // tentative suivante.
    ({ crypto, client } = resetSdk());
    expect(await restoreSession(config)).toBeNull();
  });

  it("un serveur injoignable ne compte pas pour un refus", async () => {
    // La distinction est tout l'enjeu : traiter une panne réseau comme une révocation
    // jetterait dehors quelqu'un qui a seulement perdu la connexion — soit l'inverse de
    // ce que promet.
    await initSession(config);
    ({ crypto, client } = resetSdk());
    client.whoami.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    expect(await restoreSession(config)).not.toBeNull();
  });
});

describe("déconnexion = wipe complet des données locales", () => {
  it("efface les stores SDK et chaque store applicatif enregistré", async () => {
    const session = await initSession(config);
    const wipeSearch = vi.fn();
    const wipeOutbox = vi.fn(async () => {});
    session.registerWipe("search", wipeSearch);
    session.registerWipe("outbox", wipeOutbox);

    await session.logout();

    expect(client.logout).toHaveBeenCalledWith(true);
    expect(wipeSearch).toHaveBeenCalledOnce();
    expect(wipeOutbox).toHaveBeenCalledOnce();
    expect(client.clearStores).toHaveBeenCalledOnce();
  });

  it("l'échec d'un store n'empêche ni les autres ni l'effacement SDK", async () => {
    const session = await initSession(config);
    const wipeOk = vi.fn();
    session.registerWipe("cassé", () => {
      throw new Error("quota");
    });
    session.registerWipe("ok", wipeOk);

    await expect(session.logout()).resolves.toBeUndefined();
    expect(wipeOk).toHaveBeenCalledOnce();
    expect(client.clearStores).toHaveBeenCalledOnce();
  });

  it("le wipe local a lieu même si la révocation serveur échoue", async () => {
    const session = await initSession(config);
    const wipe = vi.fn();
    session.registerWipe("search", wipe);
    client.logout.mockRejectedValueOnce(new Error("hors ligne"));

    await session.logout();

    expect(wipe).toHaveBeenCalledOnce();
    expect(client.clearStores).toHaveBeenCalledOnce();
  });
});
