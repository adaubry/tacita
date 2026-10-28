import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * **Le répertoire de projet, c'est `infra/`.** Compose résout les chemins relatifs de
 * *tous* les fichiers `-f` contre le répertoire du **premier** — jamais contre celui du
 * fichier qui les écrit. Les trois overlays sont documentés et lancés depuis `infra/`
 * (`docker compose -f docker-compose.yml -f rtc/docker-compose.yml …`, cf. `install.sh`),
 * donc `./x` veut dire `infra/x` partout, y compris dans `rtc/docker-compose.yml`.
 */
const INFRA = new URL("../", import.meta.url);

const compose = (chemin: string) =>
  parse(readFileSync(new URL(chemin, INFRA), "utf-8")) as {
    services: Record<string, { volumes?: string[] }>;
  };

/**
 * Les montages liés d'un fichier compose, source résolue depuis `infra/`. Les volumes
 * nommés (`postgres-data:`) n'ont pas de chemin et ne sont pas concernés.
 */
function montagesLies(fichier: string): { service: string; source: string; resolu: string }[] {
  const { services } = compose(fichier);
  return Object.entries(services).flatMap(([service, definition]) =>
    (definition.volumes ?? [])
      .map((montage) => montage.split(":")[0]!)
      .filter((source) => source.startsWith("."))
      .map((source) => ({
        service,
        source,
        resolu: fileURLToPath(new URL(source, INFRA)),
      })),
  );
}

const FICHIERS = [
  "docker-compose.yml",
  "rtc/docker-compose.yml",
  "smoke/docker-compose.yml",
  "staging/docker-compose.yml",
];

/**
 * Le défaut, remonté du VPS de staging :
 *
 *   nginx: [crit] pread() "/etc/nginx/well-known.conf" failed (21: Is a directory)
 *
 * `rtc/docker-compose.yml` écrivait `./well-known.conf`, ce qui *se lit* comme le fichier
 * voisin et *désigne* `infra/well-known.conf`, absent. Docker crée alors silencieusement
 * un **répertoire** à ce nom et le monte : le proxy lisait un répertoire, et le SFU
 * comme le TURN lisaient les leurs — quatre sources fausses, dont trois muettes.
 *
 * Aucun test ne pouvait le voir : ils comparaient la chaîne du montage à la chaîne
 * attendue, et les deux étaient d'accord. C'est la règle 7 dans sa forme la plus nue —
 * une valeur posée à une jonction que personne ne relit. Ce test la relit, et la seule
 * lecture qui vaille est le disque.
 */
/**
 * **Les sources produites à l'installation**, et non versionnées : elles ne peuvent pas
 * exister dans un dépôt fraîchement cloné — c'est ce qui rendait la CI rouge. Chacune
 * nomme ce qui la crée ; le test vérifie que ce créateur existe et que Git l'ignore bien,
 * pour qu'une exemption ne devienne jamais une faute de frappe tolérée.
 */
const PRODUITES_A_L_INSTALLATION: Record<string, string> = {
  "./proxy/certs": "proxy/generate-dev-certs.sh",
};

describe("tout montage lié désigne un chemin qui existe, résolu depuis infra/", () => {
  it("chaque source produite à l'installation a son générateur, et Git l'ignore", () => {
    for (const [source, generateur] of Object.entries(PRODUITES_A_L_INSTALLATION)) {
      expect(existsSync(new URL(generateur, INFRA)), generateur).toBe(true);
      expect(readFileSync(new URL("../.gitignore", INFRA), "utf8")).toContain(
        `infra/${source.replace(/^\.\//, "")}/`,
      );
    }
  });

  for (const fichier of FICHIERS) {
    it(`${fichier} : chaque source existe`, () => {
      // Le dossier produit, et ce qu'il contient (`./proxy/certs/fullchain.pem`).
      const produite = (source: string) =>
        Object.keys(PRODUITES_A_L_INSTALLATION).some(
          (dossier) => source === dossier || source.startsWith(`${dossier}/`),
        );
      const manquants = montagesLies(fichier).filter(
        ({ source, resolu }) => !produite(source) && !existsSync(resolu),
      );
      // Le message porte le service et les deux chemins : une source fausse ne se devine
      // pas à la lecture, c'est tout le problème.
      expect(manquants.map((m) => `${m.service} → ${m.source} (${m.resolu})`)).toEqual([]);
    });
  }

  it("aucun overlay n'écrit un chemin relatif à lui-même plutôt qu'à infra/", () => {
    // Le piège de forme, pris à la racine : un overlay vit dans un sous-répertoire, donc
    // sa première composante de chemin doit être ce sous-répertoire — ou un frère de
    // `infra/`. Un `./well-known.conf` nu ne peut être qu'une erreur de repère.
    for (const fichier of FICHIERS.filter((f) => f.includes("/"))) {
      const dossier = fichier.split("/")[0]!;
      for (const { source } of montagesLies(fichier)) {
        expect(source, `${fichier} : ${source} n'est relatif ni à infra/ ni à ${dossier}/`).toMatch(
          /^\.\/[a-z-]+\//,
        );
      }
    }
  });
});
