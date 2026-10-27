import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { genererVapid, planifier, resteAFaire, valider } from "../src/init.ts";
import { clesGarage, lireEnv } from "../src/verifications.ts";
import { monde } from "./monde.ts";

const REPONSES = { domaine: "chat.tacita.fr", email: "adam@tacita.fr" };

/** Un extrait fidèle de `.env.example` : commentaires compris, ce sont eux qui documentent. */
const EXEMPLE = `# Copie en .env, ne jamais committer .env (secrets réels)

SERVER_NAME=chat.example.org

POSTGRES_USER=synapse
POSTGRES_PASSWORD=change-me

SYNAPSE_REGISTRATION_SHARED_SECRET=change-me
SYNAPSE_MACAROON_SECRET_KEY=change-me
SYNAPSE_FORM_SECRET=change-me

S3_BUCKET=synapse-media
S3_ACCESS_KEY_ID=change-me
S3_SECRET_ACCESS_KEY=change-me
# 32 octets en hexadécimal ; génération : openssl rand -hex 32
GARAGE_RPC_SECRET=change-me

VAPID_SUBJECT=mailto:admin@example.org
VAPID_PUBLIC_KEY=change-me
VAPID_PRIVATE_KEY=change-me
SYNAPSE_IP_RANGE_WHITELIST=["172.16.0.0/12"]

# Deux variables, et rien d'autre à décider : le SFU et le TURN tiennent sur l'IP de l'hôte.
LIVEKIT_KEY=change-me
LIVEKIT_SECRET=change-me
`;

describe("la paire VAPID, produite sans dépendance ni conteneur jetable", () => {
  it("respecte au caractère près les formats qu'attendent la passerelle et le navigateur", () => {
    // 87 et 43 ne sont pas des conventions : ce sont les longueurs en base64url d'un
    // point P-256 non compressé (65 octets) et de sa clé privée (32 octets).
    const { publique, privee } = genererVapid();
    expect(publique).toHaveLength(87);
    expect(privee).toHaveLength(43);
    expect(Buffer.from(publique, "base64url")).toHaveLength(65);
    expect(Buffer.from(publique, "base64url")[0]).toBe(4);
    expect(Buffer.from(privee, "base64url")).toHaveLength(32);
  });

  it("rend une paire différente à chaque appel", () => {
    expect(genererVapid().publique).not.toBe(genererVapid().publique);
  });
});

describe("la préparation d'infra/.env depuis l'exemple", () => {
  const { contenu, modifications } = planifier(EXEMPLE, REPONSES);
  const valeurs = lireEnv(contenu);
  const actionDe = (cle: string) => modifications.find((m) => m.cle === cle)?.action;

  it("ne laisse aucun « change-me » derrière elle", () => {
    expect(contenu).not.toContain("change-me");
  });

  it("produit un fichier que le doctor accepte, longueurs comprises", async () => {
    expect(valeurs.get("VAPID_PUBLIC_KEY")).toHaveLength(87);
    expect(valeurs.get("VAPID_PRIVATE_KEY")).toHaveLength(43);
    expect((await clesGarage.verifier(monde({ env: valeurs }))).etat).toBe("ok");
    expect(valeurs.get("SERVER_NAME")).toBe("chat.tacita.fr");
    expect(valeurs.get("VAPID_SUBJECT")).toBe("mailto:adam@tacita.fr");
  });

  it("préserve les commentaires et l'ordre, qui portent l'essentiel de la documentation", () => {
    // Les remplacer par une liste de clés échangerait une documentation vivante contre
    // un fichier que plus personne ne comprend six mois plus tard.
    expect(contenu).toContain("# Copie en .env, ne jamais committer .env (secrets réels)");
    expect(contenu).toContain("# 32 octets en hexadécimal ; génération : openssl rand -hex 32");
    expect(contenu.indexOf("SERVER_NAME")).toBeLessThan(contenu.indexOf("POSTGRES_USER"));
  });

  it("pose un identifiant de clé S3 que Garage accepte, et un secret RPC au bon format", () => {
    // Six caractères — « tacita » — suffisaient avant ; Garage en exige huit, et le dit
    // seulement dans le journal d'un conteneur qui redémarre en boucle.
    expect(valeurs.get("S3_ACCESS_KEY_ID")!.length).toBeGreaterThanOrEqual(8);
    expect(valeurs.get("GARAGE_RPC_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(actionDe("GARAGE_RPC_SECRET")).toBe("généré");
  });

  it("les appels n'ont plus une seule valeur que l'administrateur doive deviner", () => {
    // Il fallait deux IPv4 publiques que l'outil laissait vides, faute de pouvoir les
    // inventer — donc une pile qui refusait de démarrer, sur une machine qui n'en a
    // qu'une. Le TURN-TLS ayant quitté le 443 pour le 5349, il ne reste que la paire de
    // clés du SFU, et `init` la génère comme les autres.
    expect(actionDe("LIVEKIT_KEY")).toBe("renseigné");
    expect(actionDe("LIVEKIT_SECRET")).toBe("généré");
    expect(valeurs.get("LIVEKIT_SECRET")).toHaveLength(64);
    for (const disparue of ["WEB_BIND_IP", "TURN_BIND_IP", "TURN_DOMAIN"]) {
      expect(modifications.map((m) => m.cle)).not.toContain(disparue);
    }
  });

  it("rend compte de chaque clé, y compris celles qu'elle n'a pas touchées", () => {
    expect(actionDe("SYNAPSE_MACAROON_SECRET_KEY")).toBe("généré");
    expect(actionDe("SERVER_NAME")).toBe("renseigné");
    expect(actionDe("SYNAPSE_IP_RANGE_WHITELIST")).toBe("conservé");
  });

  it("ne divulgue aucun secret dans son compte rendu", () => {
    // Un rapport qui s'affiche à l'écran, se copie dans un ticket et finit dans un
    // historique de shell n'a aucune raison de porter les secrets qu'il vient de poser.
    const secret = valeurs.get("SYNAPSE_MACAROON_SECRET_KEY")!;
    for (const { apercu } of modifications) expect(apercu).not.toContain(secret);
  });

  it("tire un secret différent pour chaque variable", () => {
    const secrets = ["POSTGRES_PASSWORD", "SYNAPSE_FORM_SECRET", "SYNAPSE_MACAROON_SECRET_KEY"].map(
      (cle) => valeurs.get(cle),
    );
    expect(new Set(secrets).size).toBe(secrets.length);
  });
});

describe("la relance, qui ne doit rien casser de ce qui tourne déjà", () => {
  it("aucun secret déjà posé n'est régénéré", () => {
    // Régénérer un macaroon invalide toutes les sessions ouvertes ; régénérer le secret
    // S3 fait refuser à Garage de démarrer, la clé étant déjà associée à l'ancien. La
    // relance doit être sans effet.
    const premier = planifier(EXEMPLE, REPONSES).contenu;
    const second = planifier(premier, REPONSES).contenu;
    expect(second).toBe(premier);
  });

  it("le compte rendu d'une relance ne dit que « conservé »", () => {
    const premier = planifier(EXEMPLE, REPONSES).contenu;
    const { modifications } = planifier(premier, REPONSES);
    const actions = new Set(modifications.map((m) => m.action));
    expect(actions).toEqual(new Set(["conservé"]));
  });

  it("un fichier à moitié rempli ne voit compléter que ce qui manque", () => {
    const partiel = EXEMPLE.replace("POSTGRES_PASSWORD=change-me", "POSTGRES_PASSWORD=déjà-posé");
    const { contenu, modifications } = planifier(partiel, REPONSES);
    expect(lireEnv(contenu).get("POSTGRES_PASSWORD")).toBe("déjà-posé");
    expect(modifications.find((m) => m.cle === "POSTGRES_PASSWORD")?.action).toBe("conservé");
    expect(modifications.find((m) => m.cle === "SYNAPSE_FORM_SECRET")?.action).toBe("généré");
  });

  it("un SERVER_NAME réel n'est jamais remplacé, même par un autre domaine", () => {
    // Le changer abandonnerait le homeserver : chaque identifiant Matrix le porte.
    const pose = EXEMPLE.replace("SERVER_NAME=chat.example.org", "SERVER_NAME=chat.deja.fr");
    const { contenu } = planifier(pose, { domaine: "chat.autre.fr", email: REPONSES.email });
    expect(lireEnv(contenu).get("SERVER_NAME")).toBe("chat.deja.fr");
  });
});

describe("la validation des deux réponses, refusée tôt plutôt que payée au certificat", () => {
  it.each([
    [{ domaine: "chat.tacita.fr", email: "adam@tacita.fr" }, undefined],
    [{ domaine: "pas un domaine", email: "adam@tacita.fr" }, /nom de domaine/],
    [{ domaine: "localhost", email: "adam@tacita.fr" }, /nom de domaine/],
    [{ domaine: "chat.example.org", email: "adam@tacita.fr" }, /ne résoudra jamais/],
    [{ domaine: "chat.tacita.fr", email: "pas-une-adresse" }, /e-mail/],
  ])("%o", (reponses, attendu) => {
    const probleme = valider(reponses);
    if (attendu === undefined) expect(probleme).toBeUndefined();
    else expect(probleme).toMatch(attendu);
  });
});

describe("ce que l'outil dit ne pas pouvoir faire", () => {
  it("en production, il nomme le DNS, le certificat et le hook de renouvellement", () => {
    const etapes = resteAFaire("chat.tacita.fr", false).join("\n");
    expect(etapes).toContain("enregistrements A");
    expect(etapes).toContain("certbot");
    expect(etapes).toContain("renewal-hooks");
    expect(etapes).toContain("call.chat.tacita.fr");
  });

  it("en développement, il nomme le fichier hosts et le certificat auto-signé", () => {
    const etapes = resteAFaire("chat.example.org", true).join("\n");
    expect(etapes).toContain("hosts");
    expect(etapes).toContain("generate-dev-certs.sh");
    expect(etapes).not.toContain("certbot");
  });

  it("la commande de démarrage monte le RTC, des deux côtés", () => {
    // Une commande sans `rtc/` monterait une pile sans SFU : le `.well-known` n'annonce
    // alors aucun focus, et le bouton d'appel rend `RtcFociMissing`. L'administrateur
    // aurait suivi la procédure à la lettre pour obtenir des appels qui ne partent pas.
    expect(resteAFaire("chat.tacita.fr", false).join("\n")).toContain(
      "-f rtc/docker-compose.yml",
    );
    const dev = resteAFaire("chat.example.org", true).join("\n");
    expect(dev).toContain("-f rtc/docker-compose.yml");
    // En dev le SFU doit annoncer la boucle locale : sans cet overlay il part chercher
    // une IP publique que le navigateur de la machine ne joindra jamais.
    expect(dev).toContain("-f rtc/dev.docker-compose.yml");
  });

  it("en production, il rappelle d'ouvrir les ports du média", () => {
    // L'oubli ne se voit pas : l'appel se connecte, affiche les participants, et coupe
    // à 15-20 s quand ICE expire ses candidats.
    expect(resteAFaire("chat.tacita.fr", false).join("\n")).toContain("host-ufw.sh");
  });
});

describe("le fichier écrit ne laisse pas ses secrets lisibles par la machine", () => {
  /**
   * Éprouvé en lançant réellement la commande, parce que la propriété tient à un appel
   * système et non à une valeur calculable : `writeFileSync` n'applique son `mode` qu'à
   * la **création**. Un `.env` déjà présent en 644 le restait, et ses six secrets, sa
   * clé privée VAPID et son mot de passe PostgreSQL demeuraient lisibles par tout
   * compte de la machine.
   */
  const depotJetable = () => {
    const racine = mkdtempSync(join(tmpdir(), "tacita-init-"));
    mkdirSync(join(racine, "apps", "admin"), { recursive: true });
    mkdirSync(join(racine, "infra"), { recursive: true });
    cpSync(new URL("../src", import.meta.url), join(racine, "apps", "admin", "src"), {
      recursive: true,
    });
    writeFileSync(join(racine, "infra", ".env.example"), EXEMPLE);
    return racine;
  };

  const lancerInit = (racine: string) =>
    execFileSync(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        join(racine, "apps", "admin", "src", "index.ts"),
        "init",
        "--domaine=chat.tacita.fr",
        "--email=adam@tacita.fr",
      ],
      { stdio: "pipe", encoding: "utf-8" },
    );

  const mode = (chemin: string) => (statSync(chemin).mode & 0o777).toString(8);

  it("un .env créé de zéro naît en 600", () => {
    const racine = depotJetable();
    lancerInit(racine);
    expect(mode(join(racine, "infra", ".env"))).toBe("600");
    rmSync(racine, { recursive: true, force: true });
  });

  it("un .env existant trop ouvert est resserré, et l'outil le dit", () => {
    const racine = depotJetable();
    lancerInit(racine);
    const chemin = join(racine, "infra", ".env");
    chmodSync(chemin, 0o644);

    const sortie = lancerInit(racine);
    expect(mode(chemin)).toBe("600");
    expect(sortie).toContain("permissions resserrées de 644 à 600");
    rmSync(racine, { recursive: true, force: true });
  });
});
