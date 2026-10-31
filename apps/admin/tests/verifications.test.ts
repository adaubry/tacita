import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { diagnostiquer, type Contexte } from "../src/contrat.ts";
import {
  certificat,
  CHEMIN_CERT,
  clesGarage,
  clesVapid,
  fichierEnv,
  lireEnv,
  nomDuServeur,
  plagesAutorisees,
  secretsRemplis,
  sujetVapid,
  VERIFICATIONS_CONFIG,
} from "../src/verifications.ts";
import { monde } from "./monde.ts";

const fixture = (nom: string) => readFileSync(new URL(`fixtures/${nom}`, import.meta.url), "utf-8");

/** Un environnement où tout est correct : chaque test n'écrase que ce qu'il éprouve. */
const ENV_SAIN: Record<string, string> = {
  SERVER_NAME: "chat.tacita.fr",
  POSTGRES_PASSWORD: "b7f2c1a9",
  SYNAPSE_REGISTRATION_SHARED_SECRET: "5d0e4b",
  SYNAPSE_MACAROON_SECRET_KEY: "9a1c7e",
  SYNAPSE_FORM_SECRET: "3f8b2d",
  S3_ACCESS_KEY_ID: "tacita-synapse",
  S3_SECRET_ACCESS_KEY: "c4e9a2".repeat(3),
  VAPID_SUBJECT: "mailto:admin@tacita.fr",
  VAPID_PUBLIC_KEY: "P".repeat(87),
  VAPID_PRIVATE_KEY: "p".repeat(43),
  SYNAPSE_IP_RANGE_WHITELIST: '["172.16.0.0/12"]',
  GARAGE_RPC_SECRET: "0123456789abcdef".repeat(4),
  LIVEKIT_KEY: "tacita",
  LIVEKIT_SECRET: "e1b8a4",
  LIVEKIT_AS_TOKEN: "a5c0d1",
  LIVEKIT_HS_TOKEN: "b7e2f3",
};

const contexte = (modifications: Partial<Contexte> = {}): Contexte =>
  monde({ env: new Map(Object.entries(ENV_SAIN)), ...modifications });

const avec = (paires: Record<string, string>): Contexte =>
  contexte({ env: new Map(Object.entries({ ...ENV_SAIN, ...paires })) });

describe("lecture du fichier d'environnement", () => {
  it("ignore les commentaires et les lignes vides, garde le reste", async () => {
    const valeurs = lireEnv("# un commentaire\n\nSERVER_NAME=chat.tacita.fr\n\n# encore\nPORT=443\n");
    expect([...valeurs]).toEqual([
      ["SERVER_NAME", "chat.tacita.fr"],
      ["PORT", "443"],
    ]);
  });

  it("garde les « = » qui apparaissent dans la valeur", async () => {
    // Le cas réel : une clé base64 se termine souvent par « = ». Couper au premier
    // séparateur tronquerait le secret, et le symptôme serait un service qui refuse
    // de démarrer sans dire que sa clé a été rognée.
    expect(lireEnv("UNE_CLE_BASE64=AAAA==").get("UNE_CLE_BASE64")).toBe("AAAA==");
  });
});

describe("le fichier d'environnement manquant est dit avant tout le reste", () => {
  it("son absence bloque, et le remède est la commande à taper", async () => {
    const constat = await fichierEnv.verifier(contexte({ env: undefined }));
    expect(constat.etat).toBe("casse");
    expect(constat.remede).toContain("pnpm admin init");
  });
});

describe("les secrets laissés sur leur valeur d'exemple", () => {
  it("chaque « change-me » restant est nommé, pas seulement compté", async () => {
    const constat = await secretsRemplis.verifier(
      avec({ POSTGRES_PASSWORD: "change-me", SYNAPSE_FORM_SECRET: "change-me" }),
    );
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("POSTGRES_PASSWORD");
    expect(constat.constat).toContain("SYNAPSE_FORM_SECRET");
    expect(constat.constat).not.toContain("S3_ACCESS_KEY_ID");
  });

  it("un environnement complet passe", async () => {
    expect((await secretsRemplis.verifier(contexte())).etat).toBe("ok");
  });
});

describe("les clés VAPID, dont la mauvaise longueur ne se voit nulle part ailleurs", () => {
  it("une clé trop courte bloque et le constat donne les deux longueurs", async () => {
    const constat = await clesVapid.verifier(avec({ VAPID_PUBLIC_KEY: "trop-court" }));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("10 caractères");
    expect(constat.constat).toContain("87");
  });

  it("le constat dit le symptôme qu'on observerait sinon", async () => {
    // Sans ça, l'administrateur cherche la panne du côté du navigateur ou des push
    // rules, alors que le service n'a jamais démarré une seule fois.
    const constat = await clesVapid.verifier(avec({ VAPID_PRIVATE_KEY: "change-me" }));
    expect(constat.constat).toMatch(/redémarrera en boucle/);
  });

  it("une paire aux bonnes longueurs passe", async () => {
    expect((await clesVapid.verifier(contexte())).etat).toBe("ok");
  });
});

describe("l'émetteur déclaré aux services de push", () => {
  it.each([
    ["mailto:admin@tacita.fr", "ok"],
    ["https://tacita.fr", "ok"],
    ["change-me", "casse"],
    ["admin@tacita.fr", "casse"],
    ["", "casse"],
  ])("« %s » est %s", async (sujet, attendu) => {
    expect((await sujetVapid.verifier(avec({ VAPID_SUBJECT: sujet }))).etat).toBe(attendu);
  });
});

describe("la plage d'adresses que Synapse s'autorise à joindre", () => {
  it.each([["", "casse"], ["[]", "casse"], ['["172.16.0.0/12"]', "ok"]])(
    "« %s » est %s",
    async (liste, attendu) => {
      expect((await plagesAutorisees.verifier(avec({ SYNAPSE_IP_RANGE_WHITELIST: liste }))).etat).toBe(attendu);
    },
  );

  it("le constat dit que la panne serait muette", async () => {
    // C'est la seule chose qui distingue cette vérification d'un détail de config :
    // sans elle, tout paraît fonctionner et aucune notification n'arrive jamais.
    expect((await plagesAutorisees.verifier(avec({ SYNAPSE_IP_RANGE_WHITELIST: "[]" }))).constat).toMatch(
      /rien ne le signalera/,
    );
  });
});

describe("le nom du serveur, qui ne se change plus après le premier démarrage", () => {
  it("le nom d'exemple bloque, et le constat dit pourquoi c'est irréversible", async () => {
    const constat = await nomDuServeur.verifier(avec({ SERVER_NAME: "chat.example.org" }));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("définitif");
    expect(constat.remede).toContain("AVANT le premier docker compose up");
  });

  it("un nom absent bloque aussi", async () => {
    expect((await nomDuServeur.verifier(avec({ SERVER_NAME: "" }))).etat).toBe("casse");
  });

  it("un vrai domaine passe", async () => {
    expect((await nomDuServeur.verifier(contexte())).etat).toBe("ok");
  });

  it("sur une machine de développement, le nom d'exemple est le nom voulu", async () => {
    // Trouvé en lançant le doctor sur le dépôt : `chat.example.org` y est écrit dans
    // le fichier hosts et porté par le certificat auto-signé. Le déclarer bloquant
    // envoyait réparer ce qui marche.
    const constat = await nomDuServeur.verifier(
      contexte({ env: new Map(Object.entries({ ...ENV_SAIN, SERVER_NAME: "chat.example.org" })), dev: true }),
    );
    expect(constat.etat).toBe("ok");
    expect(constat.constat).toContain("attendu en développement");
  });
});

describe("les formats que Garage refuse au démarrage", () => {
  it.each([
    [{ GARAGE_RPC_SECRET: "change-me" }, "casse", "GARAGE_RPC_SECRET"],
    [{ GARAGE_RPC_SECRET: "0".repeat(63) }, "casse", "GARAGE_RPC_SECRET"],
    [{ S3_ACCESS_KEY_ID: "tacita" }, "casse", "S3_ACCESS_KEY_ID"],
    [{ S3_SECRET_ACCESS_KEY: "court" }, "casse", "S3_SECRET_ACCESS_KEY"],
    [{}, "ok", "conformes"],
  ])("%o est %s", async (paires, attendu, nomme) => {
    // Chacun fait sortir Garage en nommant la cause, mais dans le journal d'un conteneur
    // qui repart en boucle : `docker compose ps` montre une pile qui semble démarrer, et
    // Synapse, qui l'attend en `service_healthy`, ne part jamais.
    const constat = await clesGarage.verifier(avec(paires));
    expect(constat.etat).toBe(attendu);
    expect(constat.constat).toContain(nomme);
  });
});

describe("la paire LiveKit est un secret requis, comme ceux de Synapse", () => {
  it("laissée sur change-me, elle bloque au même titre que les autres", async () => {
    // Les appels font partie de la pile : le SFU ne fait confiance qu'aux jetons signés
    // avec cette paire. Partagée entre tous les déploiements, elle laisse n'importe qui
    // forger un jeton — et rien n'échoue au démarrage pour le dire.
    const constat = await secretsRemplis.verifier(avec({ LIVEKIT_SECRET: "change-me" }));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("LIVEKIT_SECRET");
  });
});

describe("le certificat TLS, dont le défaut le plus coûteux est invisible à l'œil", () => {
  const avecCert = (nom: string, modifications: Partial<Contexte> = {}) =>
    contexte({
      env: new Map(Object.entries({ ...ENV_SAIN, SERVER_NAME: "chat.example.org" })),
      lire: (chemin) => (chemin === CHEMIN_CERT ? fixture(nom) : undefined),
      ...modifications,
    });

  it("un certificat sans subjectAltName bloque, alors qu'il paraît valide partout ailleurs", async () => {
    // `service_identity` — donc Twisted, donc Synapse — le refuse, et tout navigateur
    // depuis 2017 aussi. Un `/CN=` seul ne suffit plus à personne.
    const constat = await certificat.verifier(avecCert("cert-sans-san.pem"));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("subjectAltName");
  });

  it("un certificat qui ne couvre pas le nom du serveur bloque, et nomme ce qui manque", async () => {
    const constat = await certificat.verifier(
      contexte({
        env: new Map(Object.entries({ ...ENV_SAIN, SERVER_NAME: "chat.tacita.fr" })),
        lire: (chemin) => (chemin === CHEMIN_CERT ? fixture("cert-bon.pem") : undefined),
      }),
    );
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("chat.tacita.fr");
  });

  it("un certificat absent bloque, et le remède dépend de l'environnement", async () => {
    // Donner les deux chemins à la fois obligeait le lecteur à choisir ; en production
    // « generate-dev-certs.sh » est même le geste à ne surtout pas faire, puisqu'il
    // écraserait le certificat Let's Encrypt par un auto-signé.
    const production = await certificat.verifier(contexte());
    expect(production.etat).toBe("casse");
    expect(production.remede).toContain("certbot");
    expect(production.remede).not.toContain("generate-dev-certs.sh");
    // La commande se copie telle quelle : un « <SERVER_NAME> » à substituer à la main
    // est une invitation à se tromper sur le seul nom qui ne se change plus après coup.
    expect(production.remede).toContain("-d chat.tacita.fr -d call.chat.tacita.fr");

    const developpement = await certificat.verifier(contexte({ dev: true }));
    expect(developpement.remede).toContain("generate-dev-certs.sh");
    expect(developpement.remede).not.toContain("certbot");
  });

  it("un certificat complet et valide passe", async () => {
    expect((await certificat.verifier(avecCert("cert-bon.pem"))).etat).toBe("ok");
  });

  it("un certificat expiré bloque", async () => {
    const constat = await certificat.verifier(
      avecCert("cert-bon.pem", { maintenant: new Date("2099-01-01T00:00:00Z") }),
    );
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("expiré");
  });

  it("un certificat qui expire bientôt avertit sans bloquer", async () => {
    // Le renouvellement est automatique quand le hook est posé ; le signaler sans
    // bloquer, c'est la différence entre prévenir et empêcher de démarrer.
    const expiration = new Date(new X509Certificate(fixture("cert-bon.pem")).validTo);
    const dixJoursAvant = new Date(expiration.getTime() - 10 * 86_400_000);
    const constat = await certificat.verifier(avecCert("cert-bon.pem", { maintenant: dixJoursAvant }));
    expect(constat.etat).toBe("attention");
    expect(constat.constat).toContain("expire dans");
  });
});

describe("le diagnostic complet", () => {
  it("rend un constat par vérification, dans l'ordre déclaré", async () => {
    const constats = await diagnostiquer(contexte(), VERIFICATIONS_CONFIG);
    expect(constats).toHaveLength(VERIFICATIONS_CONFIG.length);
    expect(constats.map((c) => c.nom)).toEqual(VERIFICATIONS_CONFIG.map((v) => v.nom));
  });

  it("sans infra/.env, une seule cause est rouge et les autres attendent", async () => {
    // Le premier lancement sur une machine neuve. Avant l'état « attente », huit
    // constats rouges disaient la même chose et personne ne savait par où commencer.
    const constats = await diagnostiquer(contexte({ env: undefined }), VERIFICATIONS_CONFIG);
    const bloquantes = constats.filter((c) => c.etat === "casse").map((c) => c.nom);
    expect(bloquantes).toEqual(["infra/.env", "certificat TLS"]);
    expect(constats.filter((c) => c.etat === "attente")).toHaveLength(
      VERIFICATIONS_CONFIG.length - 2,
    );
  });
});

describe("le service démarre sous le moteur qui le lance réellement", () => {
  it("`node --experimental-strip-types` exécute la commande d'aide sans broncher", async () => {
    // Vitest transpile, ce moteur ne fait que retirer les types : un paquet peut être
    // vert de bout en bout et refuser de démarrer. Seul ce test le voit.
    // `.pathname` rend « /C:/… » sous Windows, que Node résout depuis la racine du
    // lecteur courant en « C:\C:\… » — le module reste introuvable et le test échoue
    // là où rien n'est cassé. `fileURLToPath` est le seul convertisseur portable.
    const entree = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    expect(() =>
      execFileSync(process.execPath, ["--experimental-strip-types", entree, "--help"], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });
});
