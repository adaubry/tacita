import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api";

import { resetSdk, type ClientMock, type CryptoMock } from "./mocks";
import {
  connexionParCle,
  creerCompte,
  initSession,
  restoreSession,
  type SessionConfig,
} from "../src";

vi.mock("matrix-js-sdk", async () => (await import("./mocks")).sdkModule());

const config: SessionConfig = {
  homeserverUrl: "https://tacita.test",
  identifiant: "alice",
  motDePasse: "motdepasse-essai",
  indexedDB: new IDBFactory(),
};

let crypto: CryptoMock;
let client: ClientMock;

/** Une vraie clé encodée : `decodeRecoveryKey` n'est pas mocké, il vérifie la parité. */
const CLE = encodeRecoveryKey(new Uint8Array(32).fill(7))!;

/** Cet appareil n'est pas encore signé par son propriétaire : la porte est fermée. */
const appareilNonSigne = () => crypto.getDeviceVerificationStatus.mockResolvedValue(null);

beforeEach(() => {
  ({ crypto, client } = resetSdk());
});

describe("clé de récupération E2EE obligatoire à l'inscription", () => {
  it("setupRecoveryKey crée le backup et rend la clé à afficher à l'utilisateur", async () => {
    const session = await initSession(config);
    const key = await session.setupRecoveryKey();

    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledOnce();
    expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({ setupNewKeyBackup: true }),
    );
    expect(key.encodedPrivateKey).toBe("EsTb ABCD EFGH");
  });

  it("échoue franchement si le secret storage existait déjà, sans inventer de clé", async () => {
    // Secret storage déjà provisionné : le SDK n'appelle pas notre fabrique.
    crypto.bootstrapSecretStorage.mockImplementation(async () => {});
    const session = await initSession(config);
    await expect(session.setupRecoveryKey()).rejects.toThrow(/aucune clé de récupération/);
  });

  it("« j'ai perdu ma clé » remplace le secret storage et l'identité, dans cet ordre", async () => {
    // L'ordre est le fond du test : `resetCrossSigning` réexporte les nouvelles clés
    // d'identité vers le secret storage courant. Lancé avant que celui-ci soit remplacé,
    // il chiffrerait avec la clé que l'utilisateur vient de perdre.
    const appels: string[] = [];
    crypto.bootstrapSecretStorage.mockImplementation(async (opts) => {
      appels.push("secretStorage");
      await opts.createSecretStorageKey?.();
    });
    crypto.bootstrapCrossSigning.mockImplementation(async () => {
      appels.push("crossSigning");
    });

    const session = await initSession(config);
    await session.setupRecoveryKey({ reinitialiser: true });

    expect(appels).toEqual(["secretStorage", "crossSigning"]);
    expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(
      expect.objectContaining({ setupNewSecretStorage: true }),
    );
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith(
      expect.objectContaining({ setupNewCrossSigning: true }),
    );
  });

  /*
   * L'UIA du remplacement d'identité. Relu dans le servlet de la v1.155.0 : un **premier**
   * dépôt de clés de signature passe sans authentification, remplacer une identité
   * existante en demande une. Le 401 n'arrive donc qu'ici, et il n'est pas une panne.
   *
   * Le faux `envoyer` reproduit la forme exacte de la réponse mesurée contre le serveur
   * : un flow **`m.login.password`** à une seule étape. Il disait
   * `m.login.sso` — hérité de Keycloak, supprimé le matin même par D-12 — et c'est ce
   * décalage qui fermait le chemin « j'ai perdu ma clé » sans que rien ne le dise.
   */
  const envoyerQuiDemandeUneUia = (flows: { stages: string[] }[]) => {
    const appels: unknown[] = [];
    return {
      appels,
      envoyer: vi.fn(async (auth: unknown) => {
        appels.push(auth);
        if (auth !== null) return;
        throw Object.assign(new Error("Unauthorized"), {
          httpStatus: 401,
          data: { session: "sessionUia", flows },
        });
      }),
    };
  };

  it("le remplacement d'identité franchit l'épreuve avec le mot de passe de la session", async () => {
    const { appels, envoyer } = envoyerQuiDemandeUneUia([{ stages: ["m.login.password"] }]);
    crypto.bootstrapCrossSigning.mockImplementation(async (opts) => {
      await opts.authUploadDeviceSigningKeys?.(envoyer);
    });

    const session = await initSession(config);
    const demanderMotDePasse = vi.fn(async () => "jamais-demandé");
    await session.setupRecoveryKey({ reinitialiser: true, demanderMotDePasse });

    // Premier essai sans auth — le chemin de l'inscription —, puis rejeu avec le mot de
    // passe de *cette* session UIA.
    expect(appels).toEqual([
      null,
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bob:tacita.test" },
        password: config.motDePasse,
        session: "sessionUia",
      },
    ]);
    // **Et l'écran n'a pas été montré** : redemander à quelqu'un le mot de passe qu'il
    // vient de taper est un geste que rien ne justifie.
    expect(demanderMotDePasse).not.toHaveBeenCalled();
  });

  it("la nouvelle clé est ré-épinglée côté serveur, mot de passe à l'appui", async () => {
    // Sans cet appel, le serveur ne croirait que l'ancienne clé : changement de mot de
    // passe et connexion par clé refuseraient la nouvelle.
    const session = await initSession(config);
    await session.setupRecoveryKey({ reinitialiser: true });

    const appel = client.http.requestOtherUrl.mock.calls.find(([, url]) =>
      url.endsWith("/_synapse/client/tacita/recovery_key"),
    );
    expect(appel?.[2]).toEqual({ password: config.motDePasse });
  });

  it("après un rechargement, il demande le mot de passe — personne ne l'a plus", async () => {
    /*
     * `restoreSession` rouvre une session depuis le disque : le mot de passe n'y est pas,
     * et il n'a aucune raison d'y être. C'est le seul cas où l'écran de confirmation
     * s'affiche, et sans lui la réinitialisation serait impossible après un F5.
     */
    const { appels, envoyer } = envoyerQuiDemandeUneUia([{ stages: ["m.login.password"] }]);
    crypto.bootstrapCrossSigning.mockImplementation(async (opts) => {
      await opts.authUploadDeviceSigningKeys?.(envoyer);
    });

    await initSession(config);
    ({ crypto, client } = resetSdk());
    crypto.bootstrapCrossSigning.mockImplementation(async (opts) => {
      await opts.authUploadDeviceSigningKeys?.(envoyer);
    });
    const rouverte = await restoreSession({
      homeserverUrl: config.homeserverUrl,
      indexedDB: config.indexedDB,
    });

    const demanderMotDePasse = vi.fn(async () => "tapé-à-l-écran");
    await rouverte!.setupRecoveryKey({ reinitialiser: true, demanderMotDePasse });

    expect(demanderMotDePasse).toHaveBeenCalledOnce();
    expect(appels.at(-1)).toMatchObject({ password: "tapé-à-l-écran" });
  });

  /*
   * Ce test affirmait l'inverse — « l'inscription ne demande aucune confirmation : le
   * premier dépôt passe sans UIA » — et son `envoyer` ne levait jamais. Il ne prouvait
   * donc rien de Synapse : il prouvait le mock (règle 3).
   *
   * MSC3967 n'est pas activé sur ce déploiement — ni par défaut en v1.155.0, ni dans
   * `infra/synapse/homeserver.yaml.tmpl`, qui ne porte aucun `experimental_features`.
   * L'inscription prend donc le 401 comme la réinitialisation, et le rappel d'UIA est
   * son chemin normal, pas son chemin d'exception. Escalade E-22.
   */
  it("l'inscription franchit l'épreuve aussi, si le serveur en pose une", async () => {
    /*
     * Le premier dépôt d'identité passe sans épreuve sur la version déployée — mesuré le
     * 25/08/2026 — mais la fonction ne le suppose pas : elle tente sans, et franchit ce
     * que le serveur oppose. Deviner lequel des deux cas on vit coûterait une requête de
     * plus pour une réponse que le serveur donne de toute façon.
     */
    const { appels, envoyer } = envoyerQuiDemandeUneUia([{ stages: ["m.login.password"] }]);
    crypto.bootstrapCrossSigning.mockImplementation(async (opts) => {
      await opts.authUploadDeviceSigningKeys?.(envoyer);
    });

    const session = await initSession(config);
    const cle = await session.setupRecoveryKey();

    expect(appels).toHaveLength(2);
    expect(appels.at(-1)).toMatchObject({ type: "m.login.password" });
    // Et la clé est bel et bien rendue : l'épreuve franchie, l'inscription aboutit.
    expect(cle.encodedPrivateKey).toBe("EsTb ABCD EFGH");
  });

  /*
   * **Le point mort remonté par l'utilisateur, en un test.**
   *
   * Première tentative : le secret storage et la sauvegarde sont écrits, puis le dépôt de
   * l'identité échoue (UIA abandonnée, fenêtre fermée, réseau). Le compte porte désormais
   * un secret storage et aucune identité.
   *
   * Seconde tentative : avec `setupNewSecretStorage: false`, le SDK ne rappelait plus la
   * fabrique, `generated` restait vide, et la fonction levait « secret storage déjà
   * initialisé » — à chaque essai, sans issue. La seule sortie était « j'ai perdu ma clé »,
   * proposée à quelqu'un qui n'en avait jamais eu.
   */
  it("une inscription interrompue au dépôt de l'identité se rejoue, sans point mort", async () => {
    const session = await initSession(config);

    crypto.bootstrapCrossSigning.mockRejectedValueOnce(new Error("dépôt interrompu"));
    await expect(session.setupRecoveryKey()).rejects.toThrow(/dépôt interrompu/);
    // La première tentative a bien laissé un secret storage derrière elle.
    expect(crypto.secretStorageAUneCle).toBe(true);

    // La seconde repart d'une clé neuve plutôt que de buter sur celle qui traîne.
    const cle = await session.setupRecoveryKey();
    expect(cle.encodedPrivateKey).toBe("EsTb ABCD EFGH");
  });

  it("un défi que le mot de passe seul n'achève pas remonte, plutôt que de le demander pour rien", async () => {
    // Deux étapes : rejouer la session après le seul mot de passe ne terminerait pas
    // l'UIA. Faire comme si serait exactement ce que l'interdit n°13 refuse.
    const { envoyer } = envoyerQuiDemandeUneUia([
      { stages: ["m.login.password", "m.login.terms"] },
    ]);
    crypto.bootstrapCrossSigning.mockImplementation(async (opts) => {
      await opts.authUploadDeviceSigningKeys?.(envoyer);
    });

    const session = await initSession(config);
    const demanderMotDePasse = vi.fn(async () => "jamais-demandé");
    await expect(
      session.setupRecoveryKey({ reinitialiser: true, demanderMotDePasse }),
    ).rejects.toThrow(/Unauthorized/);
    expect(demanderMotDePasse).not.toHaveBeenCalled();
  });
});

describe("l'inscription franchit les étapes de l'UIA, et rien d'autre", () => {
  /*
   * **Le défaut trouvé en montant la pile.** `creerCompte` ne franchissait
   * qu'une étape et tenait le 401 suivant pour une panne : aucune inscription n'aboutissait.
   *
   * Relu dans le code de l'image v1.155.0 (`_calculate_registration_flows`) : sans e-mail
   * ni MSISDN configurés, la liste de base vaut `[[m.login.dummy]]`. D-13 ayant retiré
   * `registration_requires_token`, c'est le flow entier — mais la fonction ne le suppose
   * pas, elle lit ce que le serveur annonce.
   *
   * Ni la compilation ni la suite ne voyaient le défaut — le mock répondait ce qu'on
   * attendait.
   */
  const serveurUia = (stages: string[]) => {
    const faits: string[] = [];
    return vi.fn(async (corps: { auth?: { type: string } }) => {
      const etape = corps.auth?.type;
      if (etape && stages.includes(etape)) faits.push(etape);
      if (stages.every((stage) => faits.includes(stage))) {
        return { access_token: "syt_access", user_id: "@neuf:tacita.test", device_id: "DEV1" };
      }
      throw Object.assign(new Error("Unauthorized"), {
        httpStatus: 401,
        data: { session: "sessionUia", completed: [...faits], flows: [{ stages }] },
      });
    });
  };

  it("le défi annoncé est franchi, sans rien demander à saisir", async () => {
    const registre = serveurUia(["m.login.dummy"]);
    client.registerRequest = registre;

    const session = await creerCompte(config);

    expect(session).toBeTruthy();
    const types = registre.mock.calls.map((c) => c[0].auth?.type);
    expect(types).toEqual([undefined, "m.login.dummy"]);
  });

  it("D-13 — un serveur qui redemande un jeton d'inscription échoue franchement", async () => {
    /*
     * Le garde retiré côté serveur, le client ne sait plus soumettre de jeton : il n'y a
     * plus de champ pour le saisir. Si `registration_requires_token` revenait, l'échec
     * doit être immédiat et bruyant — pas une boucle, ni un compte à moitié créé.
     */
    client.registerRequest = serveurUia(["m.login.registration_token", "m.login.dummy"]);
    await expect(creerCompte(config)).rejects.toMatchObject({
      errcode: "TACITA_INSCRIPTION_IMPOSSIBLE",
    });
  });

  it("un flow qu'on ne sait pas franchir échoue franchement", async () => {
    // Un e-mail exigé : avancer dans ce flow ferait croire que ça progresse, et
    // s'arrêterait dans un cul-de-sac. On refuse au premier regard.
    client.registerRequest = vi.fn(async () => {
      throw Object.assign(new Error("Unauthorized"), {
        httpStatus: 401,
        data: { session: "s", flows: [{ stages: ["m.login.email.identity"] }] },
      });
    });
    await expect(creerCompte(config)).rejects.toMatchObject({
      errcode: "TACITA_INSCRIPTION_IMPOSSIBLE",
    });
  });
});

describe("recoveryState distingue l'inscription de la reconnexion", () => {
  it("un appareil signé par son propriétaire est prêt, sans rien demander au serveur", async () => {
    const session = await initSession(config);
    await expect(session.recoveryState()).resolves.toBe("prete");
    // Hors ligne, c'est exactement ce qui compte : la réponse ne coûte aucun appel.
    expect(crypto.userHasCrossSigningKeys).not.toHaveBeenCalled();
  });

  it("un appareil non signé sur un compte sans identité : c'est une inscription", async () => {
    appareilNonSigne();
    crypto.userHasCrossSigningKeys.mockResolvedValue(false);
    const session = await initSession(config);
    await expect(session.recoveryState()).resolves.toBe("creation");
  });

  it("un appareil non signé sur un compte qui a déjà son identité : déverrouillage, jamais création", async () => {
    // Le défaut réparé : chaque reconnexion OIDC donne un `device_id` neuf, donc un
    // appareil non signé. Répondre « création » proposait d'écraser l'identité.
    appareilNonSigne();
    crypto.userHasCrossSigningKeys.mockResolvedValue(true);
    const session = await initSession(config);
    await expect(session.recoveryState()).resolves.toBe("deverrouillage");
  });

  /*
   * **La sauvegarde ne décide pas.** C'est l'état qu'une inscription interrompue laisse
   * derrière elle : `setupRecoveryKey` provisionne le secret storage *et la sauvegarde*
   * avant de déposer l'identité, et seul ce dépôt peut échouer sur une UIA.
   *
   * Lu sur la sauvegarde, cet état répondait `deverrouillage` : l'écran proposait de saisir
   * une clé qui n'ouvre rien — il n'y a aucune identité à redescendre — et le parcours
   * d'inscription devenait inatteignable. C'est le défaut remonté.
   */
  it("une sauvegarde sans identité reste une inscription, pas un déverrouillage", async () => {
    appareilNonSigne();
    crypto.getKeyBackupInfo.mockResolvedValue({ version: "1" });
    crypto.userHasCrossSigningKeys.mockResolvedValue(false);
    const session = await initSession(config);
    await expect(session.recoveryState()).resolves.toBe("creation");
  });

  it("serveur injoignable : déverrouillage, l'erreur ne penche jamais vers l'écrasement", async () => {
    appareilNonSigne();
    crypto.userHasCrossSigningKeys.mockRejectedValue(new Error("réseau"));
    const session = await initSession(config);
    await expect(session.recoveryState()).resolves.toBe("deverrouillage");
  });
});

describe("unlockRecovery : la deuxième connexion", () => {
  it("signe cet appareil et rebranche la sauvegarde", async () => {
    const session = await initSession(config);
    await session.unlockRecovery(CLE);

    // Le geste qui sort l'appareil du silence de D-08.
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalledWith({});
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalledOnce();
    expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledOnce();
  });

  it("accepte une clé recopiée avec ses espaces et ses retours à la ligne", async () => {
    const session = await initSession(config);
    await expect(session.unlockRecovery(`  ${CLE.replace(/ /g, "\n")}  `)).resolves.toBeUndefined();
  });

  it("une clé malformée lève avant tout appel réseau", async () => {
    const session = await initSession(config);
    await expect(session.unlockRecovery("pas une clé")).rejects.toThrow();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("une clé bien formée mais étrangère au compte lève sans rien amorcer", async () => {
    // Vérifié avant le bootstrap : à moitié amorcé, l'appareil resterait dans un état
    // que rien ne sait rattraper.
    client.secretStorage.checkKey.mockResolvedValue(false);
    const session = await initSession(config);
    await expect(session.unlockRecovery(CLE)).rejects.toThrow(/incorrecte/);
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("un compte sans secret storage lève, plutôt que de faire croire au déverrouillage", async () => {
    client.secretStorage.getKey.mockResolvedValue(null);
    const session = await initSession(config);
    await expect(session.unlockRecovery(CLE)).rejects.toThrow(/pas de clé de récupération/);
  });
});

describe("la clé de récupération ouvre une session", () => {
  const CHEMIN = "/_synapse/client/tacita/login_recovery";

  /** Ce que le module rend quand la clé ouvre : un jeton de connexion, rien d'autre. */
  const serveurAccepte = () =>
    client.http.requestOtherUrl.mockResolvedValue({ login_token: "syl_secours" });

  it("échange la clé contre un jeton de connexion, puis ouvre la session par `m.login.token`", async () => {
    serveurAccepte();

    const session = await connexionParCle({ ...config, cleRecuperation: CLE });

    const [, url, corps] = client.http.requestOtherUrl.mock.calls[0]!;
    expect(url).toContain(CHEMIN);
    expect(corps).toMatchObject({ user: "alice" });
    // La clé part en base64 des 32 octets, pas dans sa forme lisible : c'est ce que le
    // module décode (`b64decode(validate=True)`), et la jonction n'a pas d'autre garde.
    expect(atob((corps as { recovery_key: string }).recovery_key)).toHaveLength(32);

    // Le module ne rend **pas** de jeton d'accès : c'est Synapse qui ouvre la session, par
    // son chemin natif, avec tout ce qu'il applique au passage (appareil, limites, trace).
    expect(client.loginRequest).toHaveBeenCalledWith({
      type: "m.login.token",
      token: "syl_secours",
    });
    expect(session).toBeTruthy();
  });

  it("déverrouille dans la foulée : la porte ne redemande pas la clé qu'on vient de taper", async () => {
    serveurAccepte();

    await connexionParCle({ ...config, cleRecuperation: CLE });

    // `bootstrapCrossSigning` est le geste d'`unlockRecovery` qui signe cet appareil —
    // sans lui, `recoveryState()` rendrait `deverrouillage` et l'écran redemanderait la
    // même clé trente secondes plus tard.
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalled();
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalled();
  });

  it("un déverrouillage qui échoue ne perd pas la session ouverte", async () => {
    serveurAccepte();
    // Le serveur a déjà validé la clé contre le descripteur du compte : un refus local
    // est une anomalie, pas une clé fausse. Faire échouer la connexion pour ça renverrait
    // au formulaire quelqu'un qui est authentifié.
    crypto.bootstrapCrossSigning.mockRejectedValue(new Error("crypto indisponible"));

    await expect(connexionParCle({ ...config, cleRecuperation: CLE })).resolves.toBeTruthy();
  });

  it("une clé mal recopiée ne part pas sur le réseau", async () => {
    /*
     * `decodeRecoveryKey` vérifie préfixe, longueur et parité. L'échec porte le même
     * `errcode` que le refus du serveur, et c'est voulu : pour qui tape, « mal recopiée »
     * et « pas celle de ce compte » se corrigent de la même façon (règle 2).
     */
    await expect(
      connexionParCle({ ...config, cleRecuperation: "pas une clé" }),
    ).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });

    expect(client.http.requestOtherUrl).not.toHaveBeenCalled();
  });

  it("le refus du serveur remonte tel quel, sans être traduit en panne", async () => {
    client.http.requestOtherUrl.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { httpStatus: 403, errcode: "M_FORBIDDEN" }),
    );

    await expect(
      connexionParCle({ ...config, cleRecuperation: CLE }),
    ).rejects.toMatchObject({ errcode: "M_FORBIDDEN" });
    expect(client.loginRequest).not.toHaveBeenCalled();
  });

  it("un 200 sans jeton échoue ici, plutôt que de partir en `/login` sans rien", async () => {
    client.http.requestOtherUrl.mockResolvedValue({});
    await expect(connexionParCle({ ...config, cleRecuperation: CLE })).rejects.toThrow(
      /jeton de connexion/,
    );
  });
});

describe("D-15 — se connecter avec son mot de passe suffit, sur un appareil neuf", () => {
  /*
   * **Le défaut, remonté par l'utilisateur** : « je me connecte et j'ai un
   * écran "entrez votre clé de récupération" ». Chaque connexion donne un `device_id`
   * neuf, donc un appareil non signé, donc un mur — devant quelqu'un qui venait de donner
   * le seul secret que le produit lui demande de retenir.
   *
   * La clé est désormais **dérivée du mot de passe** : le même mot de passe la redonne à
   * chaque connexion. Ce que ces tests ne prouvent pas, et qui se joue dans
   * `infra/smoke/onboarding.smoke.test.ts` contre un vrai Synapse : que l'appareil
   * ressorte réellement signé (règle 4).
   */
  const descripteurAvecPhrase = () =>
    client.secretStorage.getKey.mockResolvedValue([
      "cleId",
      {
        algorithm: "m.secret_storage.v1.aes-hmac-sha2",
        // 1 000 itérations et non les 500 000 du SDK : on éprouve le branchement, pas
        // PBKDF2, et une suite qui coûte une seconde par test finit par ne plus être lancée.
        passphrase: { algorithm: "m.pbkdf2", salt: "selDeTest", iterations: 1000 },
      },
    ]);

  it("l'inscription dérive la clé du mot de passe, elle ne la tire pas au hasard", async () => {
    const session = await creerCompte(config);
    await session.setupRecoveryKey();

    // Sans cet argument, la clé est aléatoire et aucune connexion suivante ne peut la
    // retrouver : c'est toute la différence entre un mur et une porte.
    expect(crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledWith(config.motDePasse);
  });

  it("la connexion déverrouille sans rien demander quand la clé vient du mot de passe", async () => {
    descripteurAvecPhrase();

    await initSession(config);

    // `bootstrapCrossSigning` est le geste d'`unlockRecovery` qui signe l'appareil.
    expect(crypto.bootstrapCrossSigning).toHaveBeenCalled();
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalled();
  });

  it("une clé aléatoire d'avant D-15 ne déclenche aucune tentative", async () => {
    // Le descripteur par défaut du mock n'a pas de `passphrase` : rien à dériver, et
    // essayer quand même enverrait une clé fausse à `checkKey` à chaque connexion.
    await initSession(config);
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("un déverrouillage impossible ne fait pas échouer la connexion", async () => {
    /*
     * Le cas normal, et il arrivera : un mot de passe changé depuis (D-12 ne re-dérive
     * pas la clé). La connexion doit aboutir — l'écran de saisie de la clé existe et il
     * marche. Échouer ici enfermerait dehors quelqu'un dont le mot de passe est juste.
     */
    descripteurAvecPhrase();
    client.secretStorage.checkKey.mockResolvedValue(false);

    await expect(initSession(config)).resolves.toBeTruthy();
  });

  it("l'identité est relue après signature, sinon la porte se referme derrière", async () => {
    /*
     * Mesuré contre un vrai Synapse : `bootstrapCrossSigning` signe
     * l'appareil, et `getDeviceVerificationStatus` — la source de `recoveryState` —
     * continue de répondre « non signé » tant qu'aucun `/keys/query` n'a eu lieu. Le
     * `true` force ce téléchargement ; sans lui, l'écran de clé revient juste après avoir
     * été franchi, et c'est exactement ce que l'utilisateur a vu.
     */
    const session = await initSession(config);
    crypto.userHasCrossSigningKeys.mockClear();
    await session.unlockRecovery(CLE);

    expect(crypto.userHasCrossSigningKeys).toHaveBeenCalledWith(undefined, true);
  });
});

describe("voir ses appareils, et pouvoir les déconnecter", () => {
  /*
   * L'audit : les jetons de ce déploiement n'expirent pas, le changement de
   * mot de passe ne déconnecte personne, et la clé ouvre une session à elle seule
   *. Sans ces deux membres, une fuite de jeton n'avait **aucune** réponse.
   */
  const uiaPuisSucces = () => {
    let demande = false;
    client.deleteMultipleDevices.mockImplementation(async (_ids, auth) => {
      if (!demande) {
        demande = true;
        throw Object.assign(new Error("Unauthorized"), {
          httpStatus: 401,
          data: { session: "sessionUia", flows: [{ stages: ["m.login.password"] }] },
        });
      }
      return { auth } as never;
    });
  };

  it("la liste distingue l'appareil d'où l'on regarde", async () => {
    const session = await initSession(config);
    const appareils = await session.appareils();

    // Sans ce drapeau, l'écran offrirait de se déconnecter soi-même par le même bouton
    // que les autres — et le geste ne veut pas dire la même chose.
    expect(appareils).toEqual([
      {
        id: "DEVICE1",
        nom: "Ce téléphone",
        derniereActivite: 1_700_000_000_000,
        courant: true,
      },
      { id: "AUTRE", nom: "Portable", derniereActivite: undefined, courant: false },
    ]);
  });

  it("la révocation franchit l'épreuve avec le mot de passe de la session", async () => {
    uiaPuisSucces();
    const session = await initSession(config);

    await session.revoquerAppareils(["AUTRE"]);

    // Tentée sans auth d'abord : envoyer le mot de passe d'emblée l'exposerait sur un
    // chemin qui ne le demande pas forcément.
    expect(client.deleteMultipleDevices.mock.calls[0]).toEqual([["AUTRE"]]);
    expect(client.deleteMultipleDevices.mock.calls[1]).toEqual([
      ["AUTRE"],
      {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: "@bob:tacita.test" },
        password: config.motDePasse,
        session: "sessionUia",
      },
    ]);
  });

  it("après un rechargement, c'est celui que l'écran a demandé qui sert", async () => {
    await initSession(config);
    // Rechargement de page : objets SDK neufs sur le même disque. C'est ce qui fait
    // qu'aucun mot de passe ne survit — et donc que l'écran doit le demander.
    ({ crypto, client } = resetSdk());
    uiaPuisSucces();
    const rouverte = await restoreSession({
      homeserverUrl: config.homeserverUrl,
      indexedDB: config.indexedDB,
    });

    await rouverte!.revoquerAppareils(["AUTRE"], "tapé-à-l-écran");

    expect(client.deleteMultipleDevices.mock.calls.at(-1)?.[1]).toMatchObject({
      password: "tapé-à-l-écran",
    });
  });

  it("sans mot de passe à opposer, l'échec remonte — il ne se tait pas", async () => {
    /*
     * Interdit n°13 : une révocation qu'on croit faite et qui ne l'est pas est pire que
     * pas de bouton du tout. L'écran doit pouvoir dire que rien n'a été déconnecté.
     */
    await initSession(config);
    ({ crypto, client } = resetSdk());
    uiaPuisSucces();
    const rouverte = await restoreSession({
      homeserverUrl: config.homeserverUrl,
      indexedDB: config.indexedDB,
    });

    await expect(rouverte!.revoquerAppareils(["AUTRE"])).rejects.toThrow(/Unauthorized/);
  });

  it("une liste vide n'appelle rien", async () => {
    const session = await initSession(config);
    await session.revoquerAppareils([]);
    expect(client.deleteMultipleDevices).not.toHaveBeenCalled();
  });
});
