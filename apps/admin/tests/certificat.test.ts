import { describe, expect, it } from "vitest";

import {
  apresEmission,
  HOOK_DESTINATION,
  HOOK_SOURCE,
  planifier,
  type Faits,
} from "../src/certificat.ts";

const FAITS: Faits = {
  domaine: "chat.tacita.fr",
  email: "alice@tacita.fr",
  dev: false,
  certbotPresent: true,
  nomsMuets: [],
  port80: "libre",
  certificatExistant: undefined,
  force: false,
};

const avec = (modifications: Partial<Faits> = {}) => planifier({ ...FAITS, ...modifications });

describe("ce qui empêche l'émission est dit avant, jamais découvert pendant", () => {
  it("un DNS qui ne résout pas bloque, parce que certbot brûlerait une tentative", () => {
    // Let's Encrypt compte les échecs dans son quota. Lancer certbot sur un nom muet
    // consomme une des cinq tentatives hebdomadaires pour rien, et rend un message
    // qui ne nomme jamais le DNS.
    const plan = avec({ nomsMuets: ["call.chat.tacita.fr"] });
    expect(plan.obstacles.map((o) => o.quoi)).toContain(
      "call.chat.tacita.fr ne résout pas encore",
    );
    expect(plan.obstacles[0]?.remede).toContain("pnpm admin dns");
  });

  it("certbot absent bloque", () => {
    expect(avec({ certbotPresent: false }).obstacles[0]?.remede).toContain("apt install");
  });

  it("le port 80 occupé bloque, parce que le défi HTTP s'y lie", () => {
    const plan = avec({ port80: "occupe" });
    expect(plan.obstacles[0]?.quoi).toContain("port 80");
  });

  it("un port 80 non vérifiable ne bloque pas — on ne peut pas conclure sans privilèges", () => {
    expect(avec({ port80: "inconnu" }).obstacles).toEqual([]);
  });

  it("rien ne bloque quand tout est en place", () => {
    expect(avec().obstacles).toEqual([]);
  });
});

describe("le quota de Let's Encrypt, protégé par défaut", () => {
  it("un certificat encore valide longtemps bloque la réémission", () => {
    const plan = avec({ certificatExistant: { joursRestants: 60 } });
    expect(plan.obstacles[0]?.quoi).toContain("60 jours");
    expect(plan.obstacles[0]?.remede).toContain("--force");
  });

  it("un certificat proche de l'expiration laisse passer", () => {
    // Sous trente jours, réémettre est le geste normal — c'est même ce que fait
    // `certbot renew` tout seul.
    expect(avec({ certificatExistant: { joursRestants: 12 } }).obstacles).toEqual([]);
  });

  it("--force lève l'obstacle et ajoute --force-renewal à la commande", () => {
    const plan = avec({ certificatExistant: { joursRestants: 60 }, force: true });
    expect(plan.obstacles).toEqual([]);
    expect(plan.etapes.at(-1)?.args).toContain("--force-renewal");
  });

  it("le quota est annoncé avant d'agir, pas découvert après", () => {
    expect(avec().avertissements.join(" ")).toMatch(/cinq certificats identiques par semaine/);
  });
});

describe("l'ordre des étapes, qui n'est pas indifférent", () => {
  it("le hook de renouvellement est posé AVANT l'émission", () => {
    // Certbot exécute ses hooks de déploiement dès la première émission : posé après,
    // il ne servirait qu'au renouvellement suivant, et les fichiers ne seraient pas en
    // place pour le proxy aujourd'hui.
    const [premier, second] = avec().etapes;
    expect(premier?.args).toEqual(["install", "-D", "-m", "755", HOOK_SOURCE, HOOK_DESTINATION]);
    expect(second?.args).toContain("certonly");
  });

  it("l'émission couvre les deux noms, et le sous-domaine des appels avec", () => {
    const args = avec().etapes.at(-1)?.args ?? [];
    expect(args).toContain("chat.tacita.fr");
    expect(args).toContain("call.chat.tacita.fr");
  });

  it("c'est --standalone et non --nginx", () => {
    // Notre nginx tourne en conteneur, avec une configuration montée en lecture seule,
    // et il n'écoute pas sur le 80. `--nginx` n'aurait rien à modifier.
    const args = avec().etapes.at(-1)?.args ?? [];
    expect(args).toContain("--standalone");
    expect(args).not.toContain("--nginx");
  });

  it("l'e-mail donné est celui transmis à Let's Encrypt", () => {
    expect(avec().etapes.at(-1)?.args).toContain("alice@tacita.fr");
  });

  it("chaque étape porte son motif, pour que le plan s'explique lui-même", () => {
    for (const etape of avec().etapes) expect(etape.motif.length).toBeGreaterThan(20);
  });
});

describe("en développement, ce n'est pas du tout la même opération", () => {
  const plan = avec({ dev: true });

  it("aucun appel à Let's Encrypt : un auto-signé, et une seule étape", () => {
    expect(plan.etapes).toHaveLength(1);
    expect(plan.etapes[0]?.commande).toContain("generate-dev-certs.sh");
    expect(JSON.stringify(plan)).not.toContain("certbot");
  });

  it("le chemin du script part de la racine du dépôt, d'où il sera lancé", () => {
    // Lancé depuis `infra/`, le chemin serait faux ; le script, lui, se repère par
    // `dirname $0` et tourne depuis n'importe où.
    expect(plan.etapes[0]?.commande).toBe("./infra/proxy/generate-dev-certs.sh");
  });

  it("il dit que le certificat devra être importé, sans quoi pas de service worker", () => {
    expect(plan.avertissements.join(" ")).toMatch(/autorité de confiance/);
    expect(plan.avertissements.join(" ")).toMatch(/contexte sécurisé/);
  });
});

describe("ce qui suit l'émission", () => {
  it("en production, monter la pile puis relancer le diagnostic", () => {
    const suite = apresEmission(false).join(" ");
    expect(suite).toContain("staging/docker-compose.yml");
    // Le RTC est de la pile, pas d'une option : une commande sans lui laisse le
    // `.well-known` sans focus et le bouton d'appel inerte.
    expect(suite).toContain("rtc/docker-compose.yml");
    expect(suite).toContain("pnpm admin doctor");
  });

  it("en développement, importer le certificat d'abord", () => {
    expect(apresEmission(true)[0]).toContain("autorité de confiance");
  });
});
