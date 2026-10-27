import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `fileURLToPath` et non `.pathname` : sous Windows ce dernier rend « /C:/… », que Node
// résout depuis la racine du lecteur courant — d'où « C:\C:\…\install.sh » introuvable, et
// un fichier de tests entier qui ne se charge même pas.
const DEPOT = fileURLToPath(new URL("../../", import.meta.url));
const bootstrap = readFileSync(join(DEPOT, "install.sh"), "utf-8");
const machine = readFileSync(join(DEPOT, "apps/admin/src/machine.ts"), "utf-8");

/**
 * Un dépôt jetable où l'assistant se déroule en entier sans rien installer, sans réseau
 * et sans Docker. L'outil d'administration y est **doublé** : il a ses propres tests, et
 * ce sont les décisions du script qu'on éprouve ici — quelles étapes il saute, dans quel
 * ordre il enchaîne, ce qu'il fait d'un échec.
 */
const bacASable = (
  options: { readonly env?: string; readonly cert?: boolean; readonly adminEchoue?: readonly string[] } = {},
) => {
  const racine = mkdtempSync(join(tmpdir(), "tacita-wizard-"));
  mkdirSync(join(racine, "apps/admin/src"), { recursive: true });
  mkdirSync(join(racine, "infra/proxy/certs"), { recursive: true });
  mkdirSync(join(racine, "infra/rtc/firewall"), { recursive: true });
  mkdirSync(join(racine, "bin"), { recursive: true });

  cpSync(join(DEPOT, "install.sh"), join(racine, "install.sh"));
  // Le script réel, pas une doublure : c'est lui que l'assistant lance en root, et
  // c'est `ufw` qui est doublé plus bas. Une copie ici prouve aussi que le chemin
  // écrit dans l'assistant est celui où le fichier vit vraiment.
  cpSync(
    join(DEPOT, "infra/rtc/firewall/host-ufw.sh"),
    join(racine, "infra/rtc/firewall/host-ufw.sh"),
  );
  cpSync(join(DEPOT, "infra/.env.example"), join(racine, "infra/.env.example"));
  cpSync(join(DEPOT, "package.json"), join(racine, "package.json"));
  if (options.env !== undefined) writeFileSync(join(racine, "infra/.env"), options.env);
  if (options.cert === true) writeFileSync(join(racine, "infra/proxy/certs/fullchain.pem"), "x");

  // L'outil d'administration, réduit à ce que le script attend de lui : une trace et un
  // code de sortie. Les commandes nommées dans `adminEchoue` rendent 1.
  writeFileSync(
    join(racine, "apps/admin/src/index.ts"),
    [
      `const echoue = new Set(${JSON.stringify(options.adminEchoue ?? [])});`,
      "const args = process.argv.slice(2);",
      'console.log("ADMIN " + args.join(" "));',
      "process.exit(args.some((a) => echoue.has(a)) ? 1 : 0);",
      "",
    ].join("\n"),
  );

  const poser = (nom: string, corps: string) => {
    const chemin = join(racine, "bin", nom);
    writeFileSync(chemin, `#!/bin/sh\n${corps}\n`);
    chmodSync(chemin, 0o755);
  };
  poser(
    "id",
    '[ "$1" = "-u" ] && { echo 0; exit 0; }\n[ "$1" = "-un" ] && { echo root; exit 0; }\nexec /usr/bin/id "$@"',
  );
  poser("docker", 'case "$*" in *"compose version"*) echo v2 ;; *"ps -q"*) ;; *) echo ok ;; esac');
  poser("pnpm", "echo 11.18.0");
  poser("certbot", "echo certbot");
  poser("curl", 'echo "# simulé"');
  poser("bash", 'echo "BASH_APPELE $*"');
  poser("apt-get", 'echo "APT_APPELE $*"');
  // Doublé, et non laissé au hasard de la machine : sans ça le test passerait ou non
  // selon qu'un ufw traîne dans le PATH, et les deux branches de l'assistant seraient
  // éprouvées au petit bonheur.
  poser("ufw", 'echo "UFW_APPELE $*"');
  poser("corepack", 'echo "COREPACK_APPELE $*"');
  return racine;
};

/** Rend le code et la sortie plutôt que de lever : un échec est ici un cas à éprouver. */
const lancer = (racine: string, args: readonly string[] = []) => {
  const resultat = spawnSync("sh", [join(racine, "install.sh"), ...args], {
    // PATH délibérément restreint : hériter de celui de la machine ferait dépendre le
    // test de ce qui y est installé — un `pnpm` réel masquerait l'étape qu'on éprouve.
    // `node` reste le vrai : c'est lui qui exécute la doublure de l'outil admin.
    env: { PATH: `${join(racine, "bin")}:${process.env["PATH"] ?? ""}` },
    encoding: "utf-8",
  });
  return { code: resultat.status ?? -1, sortie: `${resultat.stdout ?? ""}${resultat.stderr ?? ""}` };
};

const ENV_COMPLET = readFileSync(join(DEPOT, "infra/.env.example"), "utf-8")
  .replace(/change-me/g, "pose")
  .replace("SERVER_NAME=chat.example.org", "SERVER_NAME=chat.tacita.fr");

const POSE = ["--domaine=chat.tacita.fr", "--email=a@b.fr", "--oui"];

describe("le script d'amorçage tourne là où rien n'est encore installé", () => {
  it("c'est du shell POSIX, pas du bash", () => {
    // Il s'exécute avant Node, avant Docker, et parfois dans une image minimale où
    // `bash` n'existe pas. Supposer bash rendrait le seul script d'amorçage inutilisable
    // là où il est justement le seul recours.
    expect(bootstrap).toMatch(/^#!\/bin\/sh$/m);
    expect(bootstrap).not.toMatch(/^#!.*bash$/m);
  });

  it("il s'arrête à la première erreur plutôt que de continuer sur une base fausse", () => {
    expect(bootstrap).toMatch(/^set -eu$/m);
  });

  it("il n'exige pas sudo quand il tourne déjà en root", () => {
    expect(bootstrap).toMatch(/id -u.*-eq 0/);
    expect(bootstrap).toMatch(/command -v sudo/);
  });
});

describe("les prérequis couverts", () => {
  it.each(["curl", "git", "docker", "compose", "node", "pnpm", "certbot"])(
    "%s a son étape d'installation",
    (outil) => {
      expect(bootstrap).toMatch(new RegExp(`^ *${outil}\\)`, "m"));
    },
  );

  it("la version de Node installée est celle que le diagnostic réclame", () => {
    // La jonction que rien d'autre ne tient : le script installe une version, le
    // diagnostic en exige une autre, et les deux vivent dans des fichiers différents.
    const [, installee] = /^NODE_MAJEUR_MINIMAL=(\d+)$/m.exec(bootstrap) ?? [];
    const [, exigee] = /^export const NODE_MINIMAL = (\d+);$/m.exec(machine) ?? [];
    expect(installee).toBeDefined();
    expect(installee).toBe(exigee);
  });

  it("pnpm vient de corepack, à la version que déclare package.json", () => {
    expect(bootstrap).toMatch(/packageManager/);
    expect(bootstrap).toMatch(/corepack prepare "\$PNPM_VOULU" --activate/);
    expect(bootstrap).not.toMatch(/pnpm@\d+\.\d+\.\d+/);
  });

  it("Docker vient du script officiel, jamais du paquet Ubuntu", () => {
    expect(bootstrap).toContain("get.docker.com");
    expect(bootstrap).not.toMatch(/apt-get install[^\n]*\bdocker\.io\b/);
  });

  it("Node vient de NodeSource, parce qu'Ubuntu 24.04 livre Node 18", () => {
    expect(bootstrap).toContain("deb.nodesource.com/setup_");
  });

  it("l'absence d'apt-get est constatée avant la première installation", () => {
    // Sur Fedora ou Alpine, installer Docker puis échouer sur `apt-get` laisserait la
    // machine dans un état intermédiaire que personne n'avait demandé.
    const garde = bootstrap.indexOf("apt-get est introuvable");
    expect(garde).toBeGreaterThan(-1);
    expect(garde).toBeLessThan(bootstrap.indexOf("curl -fsSL https://get.docker.com |"));
  });
});

describe("tout ce qui se demande, se demande avant", () => {
  const premiereEtape = bootstrap.indexOf('etape 1 "Prérequis"');

  it("le mot de passe sudo est réclamé avant la première étape", () => {
    // Une invite qui surgit entre deux lignes du compte rendu casse l'affichage et
    // laisse devant un écran qui n'avance plus, sans dire qu'il attend quelque chose.
    const preAutorisation = bootstrap.indexOf("sudo -v");
    expect(preAutorisation).toBeGreaterThan(-1);
    expect(preAutorisation).toBeLessThan(premiereEtape);
  });

  it("le domaine et l'e-mail aussi", () => {
    const questions = bootstrap.indexOf("Nom du serveur");
    expect(questions).toBeGreaterThan(-1);
    expect(questions).toBeLessThan(premiereEtape);
  });

  it("il annonce le parcours entier avant de demander à continuer", () => {
    const annonce = bootstrap.indexOf("Ce qui sera fait");
    expect(annonce).toBeGreaterThan(-1);
    expect(annonce).toBeLessThan(bootstrap.indexOf("Continuer ?"));
  });

  it("hors terminal et sans --oui, il refuse plutôt que de supposer un accord", () => {
    const { code, sortie } = lancer(bacASable());
    expect(code).toBe(1);
    expect(sortie).toContain("Ce qui sera fait");
    expect(sortie).toContain("relancer avec --oui");
  });
});

describe("les questions s'affichent, et ne se retrouvent pas dans les réponses", () => {
  /**
   * Le défaut qui faisait paraître le script figé après le « o » de confirmation :
   * `demander` est appelée dans un `$(...)`, qui capture stdout. Son invite, écrite
   * sur stdout, n'apparaissait donc jamais — l'utilisateur voyait un écran muet
   * pendant que `read` attendait sa saisie — et venait de surcroît se coller devant la
   * réponse dans la variable, qu'`admin init` rejetait ensuite.
   *
   * Le test extrait la fonction **du script lui-même** et la fait tourner : une
   * assertion sur le texte ne dirait pas si la capture est propre.
   */
  const fonction = /^demander\(\) \{[\s\S]*?^\}/m.exec(bootstrap)?.[0];

  it("la fonction de saisie existe telle que le test l'attend", () => {
    expect(fonction).toBeDefined();
  });

  it("la variable ne reçoit que la réponse, jamais l'invite", () => {
    const resultat = spawnSync(
      "sh",
      ["-c", `${fonction}\nREPONSE="$(demander 'Nom du serveur')"\nprintf '[%s]' "$REPONSE"`],
      { input: "chat.tacita.fr\n", encoding: "utf-8" },
    );
    expect(resultat.stdout).toBe("[chat.tacita.fr]");
  });

  it("l'invite est bien affichée, sur la sortie d'erreur", () => {
    const resultat = spawnSync("sh", ["-c", `${fonction}\nX="$(demander 'Nom du serveur')"`], {
      input: "x\n",
      encoding: "utf-8",
    });
    expect(resultat.stderr).toContain("Nom du serveur");
  });
});

describe("le parcours enchaîne les six étapes", () => {
  // Un seul déroulé pour les trois assertions : chacun lance un shell et plusieurs
  // processus Node, et les multiplier rendait la suite instable sous charge.
  const { sortie } = lancer(bacASable(), POSE);

  it("configuration, DNS, certificat, pile puis vérification, dans cet ordre", () => {
    const rang = (texte: string) => sortie.indexOf(texte);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(rang(`Étape ${n} sur 6`)).toBeGreaterThan(-1);
      expect(rang(`Étape ${n} sur 6`)).toBeLessThan(rang(`Étape ${n + 1} sur 6`));
    }
  });

  it("il appelle l'outil d'administration, il ne réimplémente rien", () => {
    for (const commande of ["init", "certificat", "doctor"]) {
      expect(sortie).toContain(`ADMIN ${commande}`);
    }
    // `dns` est interrogé en silence tant qu'il répond : ce qui se voit alors est son
    // verdict, pas son appel. C'est bien lui qui décide — le cas d'échec le montre.
    expect(sortie).toContain("les deux noms résolvent");
  });

  it("il monte le RTC, et ouvre les ports du média avant de démarrer", () => {
    // Deux oublis de la même famille, tous deux muets. Sans l'overlay, le `.well-known`
    // n'annonce aucun focus et le bouton d'appel rend `RtcFociMissing` ; sans les ports,
    // l'appel se connecte puis coupe à 15-20 s quand ICE expire ses candidats.
    // Les commandes travaillent en silence, leur sortie part au journal : c'est là
    // qu'on lit ce qui a réellement été lancé, et non dans ce que l'écran affiche.
    const [, journal] = /Journal de cette installation : (\S+)/.exec(sortie) ?? [];
    expect(journal).toBeDefined();
    const trace = readFileSync(journal!, "utf-8");
    expect(trace).toContain("UFW_APPELE allow 50000:50100/udp");
    expect(trace).toContain("UFW_APPELE allow 5349/tcp");
    expect(sortie).toMatch(/Ports RTC ouverts sur ufw[^\n]*ok/);
    expect(bootstrap).toContain("-f rtc/docker-compose.yml");
    // L'ordre compte : ouvrir après le démarrage laisserait une fenêtre où les premiers
    // appels échouent, sur une pile qui a l'air debout.
    expect(bootstrap.indexOf("host-ufw.sh")).toBeLessThan(bootstrap.indexOf("COMPOSE="));
  });

  it("sur une machine sans ufw, il le dit et poursuit au lieu d'échouer", () => {
    // Toutes les distributions n'ont pas ufw, et un pare-feu absent n'est pas une panne
    // d'installation : c'est une consigne à laisser à l'administrateur.
    expect(bootstrap).toContain("command -v ufw");
    expect(bootstrap).toMatch(/pas d'ufw ici/);
  });

  it("init est appelé sans sa liste « ce qui reste à faire »", () => {
    // Cette liste énumère précisément ce que le script s'apprête à faire sous les yeux
    // du lecteur. L'afficher la ferait passer pour un travail à sa charge.
    expect(sortie).toMatch(/ADMIN init[^\n]*--sans-suite/);
  });
});

describe("il reprend où il en était, sans rien refaire", () => {
  const configSeule = lancer(bacASable({ env: ENV_COMPLET }), ["--oui"]).sortie;
  const toutPose = lancer(bacASable({ env: ENV_COMPLET, cert: true }), ["--oui"]).sortie;

  it("une configuration déjà posée n'est pas rejouée, ni le domaine redemandé", () => {
    expect(configSeule).toContain("infra/.env est déjà renseigné");
    expect(configSeule).toContain("domaine : chat.tacita.fr");
    expect(configSeule).not.toContain("ADMIN init");
  });

  it("un certificat déjà en place n'est pas réémis — le quota Let's Encrypt est fini", () => {
    expect(toutPose).toContain("un certificat est déjà en place");
    expect(toutPose).not.toContain("ADMIN certificat");
  });

  it("le plan annoncé dit d'emblée ce qui est déjà fait", () => {
    expect(toutPose).toMatch(/2\. Configuration +déjà faite/);
    expect(toutPose).toMatch(/4\. Certificat +déjà en place/);
  });
});

describe("l'attente et l'échec se gèrent, ils ne se renvoient pas à plus tard", () => {
  it("un DNS qui ne résout pas arrête le parcours, personne ne pouvant répondre", () => {
    // En mode non interactif il n'y a pas de choix à offrir : poursuivre ferait brûler
    // une tentative du quota Let's Encrypt sur un nom qui ne mène nulle part.
    const { code, sortie } = lancer(bacASable({ env: ENV_COMPLET, adminEchoue: ["dns"] }), ["--oui"]);
    expect(code).toBe(1);
    expect(sortie).toContain("le DNS n'est pas prêt");
    expect(sortie).not.toContain("ADMIN certificat");
  });

  it("en interactif, il propose de réessayer, de passer outre ou d'abandonner", () => {
    expect(bootstrap).toContain("[r] réessayer");
    expect(bootstrap).toContain("[p] passer outre");
    expect(bootstrap).toContain("[a] abandonner");
  });

  it("un certificat qui échoue n'arrête pas le parcours, mais le dit", () => {
    // La pile peut démarrer sans : ce qui manquera, c'est le HTTPS, et le diagnostic
    // final le dira. Bloquer ici priverait de tout le reste pour une étape rattrapable.
    const { sortie } = lancer(bacASable({ env: ENV_COMPLET, adminEchoue: ["certificat"] }), ["--oui"]);
    expect(sortie).toContain("l'émission n'a pas abouti");
    expect(sortie).toContain("Étape 5 sur 6");
  });

  it("la conclusion suit le verdict du diagnostic, et le code de sortie avec", () => {
    // Se féliciter juste sous les lignes ✗ qu'on vient d'afficher serait le pire des
    // deux mondes — et un déploiement automatisé doit pouvoir se fier au code.
    const bac = bacASable({ env: ENV_COMPLET, cert: true, adminEchoue: ["doctor"] });
    const { code, sortie } = lancer(bac, ["--oui"]);
    expect(code).toBe(1);
    expect(sortie).toContain("Il reste des lignes ✗");
    expect(sortie).not.toContain("Terminé.");
  });

  it("tout au vert, il conclut et donne l'adresse à ouvrir", () => {
    const { code, sortie } = lancer(bacASable({ env: ENV_COMPLET, cert: true }), ["--oui"]);
    expect(code).toBe(0);
    expect(sortie).toContain("Terminé.");
    expect(sortie).toContain("https://chat.tacita.fr");
  });
});

describe("le groupe docker interrompt le parcours, et c'est le bon comportement", () => {
  it("le script s'arrête et dit de se reconnecter avant de reprendre", () => {
    // Poursuivre mènerait droit à un « permission denied » au démarrage de la pile,
    // qu'on prendrait pour une autre panne.
    expect(bootstrap).toMatch(/usermod -aG docker/);
    const bloc = bootstrap.slice(bootstrap.lastIndexOf('if [ "$BESOIN_GROUPE" -eq 1 ]'));
    expect(bloc).toMatch(/se reconnecter/);
    expect(bloc).toMatch(/reprendra à l'étape 2/);
    // Il sort en 0 : ce n'est pas une panne, c'est une pause que le système impose.
    expect(bloc.slice(0, bloc.indexOf('etape 2'))).toMatch(/exit 0/);
  });
});

describe("il ne détruit rien", () => {
  it.each([/\brm -rf\b/, /\bmkfs\b/, /\bdd if=/, /docker system prune/, /--purge\b/])(
    "aucune occurrence de %s",
    (motif) => {
      // Un script d'amorçage tourne en root sur une machine que son auteur ne voit pas.
      expect(bootstrap).not.toMatch(motif);
    },
  );
});

describe("les scripts du dépôt restent exécutables", () => {
  /**
   * Une perte de bit exécutable est silencieuse : le hook de pré-commit cesse de tourner
   * sans que rien ne le dise, et la porte du dépôt disparaît. C'est arrivé — un outil qui
   * régénérait des fichiers depuis `git show` a effacé le mode de quatre scripts d'un
   * coup. Git suit ce mode, mais rien ne le vérifiait.
   *
   * `staging/certs-deploy-hook.sh` n'est pas de la liste, et c'est volontaire : il n'est
   * jamais lancé depuis le dépôt, mais posé par `install -D -m 755`, qui fixe son mode à
   * destination.
   */
  it.each([
    "install.sh",
    "infra/proxy/generate-dev-certs.sh",
    "infra/postgres/10-invite-tokens.sh",
    "infra/rtc/firewall/host-ufw.sh",
    ".husky/pre-commit",
  ])("%s porte le bit exécutable", (chemin) => {
    const { mode } = statSync(join(DEPOT, chemin));
    expect(mode & 0o111, `${chemin} n'est plus exécutable`).not.toBe(0);
  });
});
