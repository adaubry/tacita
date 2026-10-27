import { describe, expect, it } from "vitest";

import type { Execution } from "../src/contrat.ts";
import { readFileSync } from "node:fs";

import {
  appelsAudioVideo,
  lireConteneurs,
  overlayDeFumee,
  pileDemarree,
  servicesEnBonneSante,
  servicesQuiBouclent,
  SERVICES_RTC,
} from "../src/pile.ts";
import { monde } from "./monde.ts";

const conteneur = (service: string, reste: Record<string, unknown> = {}) => ({
  Name: `tacita-${service}-1`,
  Service: service,
  State: "running",
  Health: "healthy",
  Publishers: [],
  ...reste,
});

const PILE_SAINE = [
  conteneur("postgres"),
  conteneur("synapse", { Health: "" }),
  conteneur("push-gateway", { Health: "" }),
  conteneur("proxy", { Health: "", Publishers: [{ PublishedPort: 443 }] }),
  conteneur("garage"),
];

const MAINTENANT = new Date("2026-08-25T22:00:00Z");
const DEBOUT_DEPUIS_LONGTEMPS = "2026-08-25T07:00:00Z";
const DEMARRE_A_L_INSTANT = "2026-08-25T21:59:55Z";

type Relance = { compte: number; redemarre?: boolean; depuis?: string };

/** Simule `docker compose ps` puis `docker inspect`, les deux commandes réellement lancées. */
const avecPile = (
  conteneurs: unknown[],
  relances: Record<string, Relance> = {},
  modifications: Parameters<typeof monde>[0] = {},
) =>
  monde({
    maintenant: MAINTENANT,
    executer: async (_commande, args): Promise<Execution> => {
      if (args.includes("ps")) return { code: 0, sortie: JSON.stringify(conteneurs) };
      if (args[0] === "inspect") {
        const nom = args[args.length - 1] ?? "";
        const { compte, redemarre, depuis } = relances[nom] ?? { compte: 0 };
        return {
          code: 0,
          sortie: `${compte} ${redemarre === true} ${depuis ?? DEBOUT_DEPUIS_LONGTEMPS}`,
        };
      }
      return { code: 0, sortie: "" };
    },
    ...modifications,
  });

describe("la lecture de `docker compose ps`, dont le format change selon les versions", () => {
  it("accepte un tableau JSON", () => {
    expect(lireConteneurs('[{"Service":"synapse"}]')).toHaveLength(1);
  });

  it("accepte un objet par ligne", () => {
    // Certaines versions du plugin rendent du JSONL. Ne gérer qu'un seul format
    // ferait dépendre le diagnostic de la version installée chez l'administrateur.
    expect(lireConteneurs('{"Service":"synapse"}\n{"Service":"proxy"}')).toHaveLength(2);
  });

  it("ignore une ligne illisible sans perdre les autres", () => {
    expect(lireConteneurs('{"Service":"synapse"}\nbruit\n{"Service":"proxy"}')).toHaveLength(2);
  });

  it("rend une liste vide sur une sortie vide", () => {
    expect(lireConteneurs("   ")).toEqual([]);
  });
});

describe("la pile non démarrée n'est pas une panne", () => {
  it("elle met en attente au lieu d'échouer", async () => {
    // On peut lancer le diagnostic avant de démarrer : c'est même l'ordre recommandé.
    const constat = await pileDemarree.verifier(avecPile([]));
    expect(constat.etat).toBe("attente");
    expect(constat.constat).toContain("pas démarrée");
  });

  it("les vérifications qui en dépendent attendent aussi", async () => {
    for (const verification of [
      servicesEnBonneSante,
      servicesQuiBouclent,
      appelsAudioVideo,
      overlayDeFumee,
    ]) {
      expect((await verification.verifier(avecPile([]))).etat).toBe("attente");
    }
  });

  it("un Docker muet met en attente plutôt que d'accuser la pile", async () => {
    const constat = await pileDemarree.verifier(
      monde({ executer: async () => ({ code: 1, sortie: "cannot connect" }) }),
    );
    expect(constat.etat).toBe("attente");
  });
});

describe("l'état des services", () => {
  it("une pile saine passe", async () => {
    expect((await servicesEnBonneSante.verifier(avecPile(PILE_SAINE))).etat).toBe("ok");
  });

  it("un conteneur sorti est une panne, même en 0 — plus aucun job n'a le droit de sortir", async () => {
    // L'exception existait pour le job d'init du stockage objet. Garage s'amorce tout seul :
    // la tolérance est partie avec lui, et sans ce test elle reviendrait sans se voir.
    const sorti = [...PILE_SAINE, conteneur("quelconque", { State: "exited", Health: "", ExitCode: 0 })];
    const constat = await servicesEnBonneSante.verifier(avecPile(sorti));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("quelconque (exited)");
  });

  it("un service arrêté bloque et est nommé", async () => {
    const casse = [...PILE_SAINE.slice(0, 4), conteneur("synapse", { State: "exited" })];
    const constat = await servicesEnBonneSante.verifier(avecPile(casse));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("synapse");
  });

  it("un service unhealthy bloque aussi", async () => {
    const malade = [conteneur("postgres", { Health: "unhealthy" })];
    expect((await servicesEnBonneSante.verifier(avecPile(malade))).etat).toBe("casse");
  });
});

describe("le service qui redémarre en boucle, que « Up » ne montre jamais", () => {
  it("un service qui vient de relancer pour la 47e fois bloque et est nommé", async () => {
    // Sur le staging, la passerelle push a bouclé depuis le premier jour sans que
    // personne le voie : `docker compose ps` réaffiche « Up » à chaque relance.
    const constat = await servicesQuiBouclent.verifier(
      avecPile(PILE_SAINE, {
        "tacita-push-gateway-1": { compte: 47, depuis: DEMARRE_A_L_INSTANT },
      }),
    );
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("push-gateway");
    expect(constat.constat).toContain("47 fois");
    expect(constat.remede).toContain("logs push-gateway");
  });

  it("quelques relances ne suffisent pas à parler de boucle", async () => {
    // Un redémarrage au démarrage de la machine, ou une dépendance lente, est normal.
    expect(
      (
        await servicesQuiBouclent.verifier(
          avecPile(PILE_SAINE, { "tacita-synapse-1": { compte: 2 } }),
        )
      ).etat,
    ).toBe("ok");
  });

  it("des relances anciennes sur un service debout depuis des heures ne sont pas une boucle", async () => {
    // Le faux positif constaté sur ce dépôt : un service affichait cinq relances —
    // l'attente de PostgreSQL au premier `up` — tout en tournant sans interruption
    // depuis quinze heures. `RestartCount` est cumulatif ; le lire seul crie au loup,
    // et un diagnostic qui crie au loup sur une pile saine ne sera plus jamais lu.
    const constat = await servicesQuiBouclent.verifier(
      avecPile(PILE_SAINE, {
        "tacita-liens-1": { compte: 5, depuis: DEBOUT_DEPUIS_LONGTEMPS },
      }),
    );
    expect(constat.etat).toBe("ok");
  });

  it("un conteneur en cours de relance bloque, quel que soit son compteur", async () => {
    // `State.Restarting` est le signal sans ambiguïté : il boucle en ce moment même.
    const constat = await servicesQuiBouclent.verifier(
      avecPile(PILE_SAINE, {
        "tacita-push-gateway-1": { compte: 1, redemarre: true, depuis: DEMARRE_A_L_INSTANT },
      }),
    );
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("push-gateway");
  });

  it("une pile stable passe", async () => {
    expect((await servicesQuiBouclent.verifier(avecPile(PILE_SAINE))).etat).toBe("ok");
  });
});

describe("l'overlay de fumée, qui ne doit jamais être chargé sur une machine publique", () => {
  it("un port publié en plus du 443 bloque en production", async () => {
    // L'overlay publie PostgreSQL et l'API Synapse sur l'hôte. `ufw` n'y change rien :
    // Docker écrit ses règles de redirection en amont de la chaîne que ufw contrôle.
    const expose = [
      conteneur("proxy", { Publishers: [{ PublishedPort: 443 }] }),
      conteneur("postgres", { Publishers: [{ PublishedPort: 55432 }] }),
      conteneur("synapse", { Publishers: [{ PublishedPort: 8008 }] }),
    ];
    const constat = await overlayDeFumee.verifier(avecPile(expose));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("8008");
    expect(constat.constat).toContain("55432");
    expect(constat.remede).toContain("ufw ne protège pas");
  });

  it("les mêmes ports sont attendus en développement", async () => {
    const expose = [conteneur("postgres", { Publishers: [{ PublishedPort: 55432 }] })];
    expect((await overlayDeFumee.verifier(avecPile(expose, {}, { dev: true }))).etat).toBe("ok");
  });

  it("le 443 seul passe partout", async () => {
    expect((await overlayDeFumee.verifier(avecPile(PILE_SAINE))).etat).toBe("ok");
  });
});

describe("les appels sont déployés, ou leur absence est dite avant le premier appel", () => {
  const AVEC_RTC = [...PILE_SAINE, ...SERVICES_RTC.map((service) => conteneur(service))];

  it("les trois services de l'overlay présents, la vérification passe", async () => {
    expect((await appelsAudioVideo.verifier(avecPile(AVEC_RTC))).etat).toBe("ok");
  });

  it("l'overlay absent, c'est un avertissement et non un blocage", async () => {
    // Une pile sans appels reste un déploiement légitime, et l'application affiche le
    // bon diagnostic. Classer ça en « cassé » enverrait réparer ce qui va bien — ce qui
    // ne va pas, c'est de le découvrir au premier appel.
    const constat = await appelsAudioVideo.verifier(avecPile(PILE_SAINE));
    expect(constat.etat).toBe("attention");
    expect(constat.constat).toContain("RtcFociMissing");
    expect(constat.remede).toContain("rtc/docker-compose.yml");
  });

  it("un seul service manquant suffit, et il est nommé", async () => {
    // Le SFU seul debout donne un focus annoncé dont les jetons ne se signent nulle
    // part : l'appel démarre et meurt à la connexion, ce qui se lit comme un bug client.
    const sansJwt = AVEC_RTC.filter((c) => c.Service !== "lk-jwt-service");
    const constat = await appelsAudioVideo.verifier(avecPile(sansJwt));
    expect(constat.etat).toBe("attention");
    expect(constat.constat).toContain("lk-jwt-service");
    expect(constat.constat).not.toContain("livekit-sfu");
  });
});

describe("les ports du média RTC sont publics par nature, et lus là où ils sont décidés", () => {
  // La jonction que rien d'autre ne tient : `livekit.yaml` arme le SFU et le pare-feu,
  // et le diagnostic doit suivre la même plage. Figée ici, elle dériverait en silence le
  // jour où elle change, et le doctor accuserait une pile correcte d'exposer 101 ports.
  const livekitReel = (chemin: string) =>
    chemin === "infra/rtc/livekit.yaml"
      ? readFileSync(new URL("../../../infra/rtc/livekit.yaml", import.meta.url), "utf-8")
      : undefined;

  const expose = [
    conteneur("proxy", { Publishers: [{ PublishedPort: 443 }] }),
    conteneur("livekit-sfu", {
      Publishers: [
        { PublishedPort: 50000 },
        { PublishedPort: 50100 },
        { PublishedPort: 7881 },
        { PublishedPort: 3478 },
        { PublishedPort: 5349 },
      ],
    }),
  ];

  it("la pile avec RTC en production ne déclenche pas l'alerte de l'overlay de fumée", async () => {
    const constat = await overlayDeFumee.verifier(avecPile(expose, {}, { lire: livekitReel }));
    expect(constat.etat).toBe("ok");
    expect(constat.constat).toContain("ports RTC");
  });

  it("un port étranger à cette liste bloque toujours", async () => {
    // C'est tout l'intérêt : élargir la liste aux ports du média ne doit pas rouvrir la
    // porte à l'overlay de fumée, qui publie PostgreSQL et l'API Synapse.
    const avecPostgres = [...expose, conteneur("postgres", { Publishers: [{ PublishedPort: 55432 }] })];
    const constat = await overlayDeFumee.verifier(avecPile(avecPostgres, {}, { lire: livekitReel }));
    expect(constat.etat).toBe("casse");
    expect(constat.constat).toContain("55432");
    expect(constat.constat).not.toContain("50100");
  });
});
