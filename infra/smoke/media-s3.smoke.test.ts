import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { HOMESERVER, registerAccount, uniqueLocalpart } from "./harness";

/**
 * des octets traversent Synapse → Garage → Synapse.
 *
 * La seconde porte, et la seule preuve que le backend média S3 fonctionne.
 * `infra/tests/homeserver.test.ts` assère que le template nomme Garage, la région et le
 * bucket — le contenu des fichiers, pas un comportement — et aucune autre cible de fumée
 * n'envoie de média. Le défaut que rien d'autre ne verrait : 1 000 tests verts et un
 * bucket vide. Ou pire, un bucket qui se remplit et ne rend rien — c'est ce que fait une
 * région de signature absente : les uploads passent, chaque lecture répond 400.
 *
 * Deux tailles, parce que boto3 change de chemin à 8 Mio : un PUT simple en dessous, un
 * upload multipart au-dessus. Et pour que la relecture vienne du bucket, la copie locale
 * de Synapse (`store_local: true`) est effacée dans le conteneur avant le téléchargement :
 * sans elle, Synapse n'a plus que Garage.
 *
 * `docker exec` direct, et non `docker compose exec` : ce dernier exige les fichiers
 * compose dans le répertoire courant, et la cible se lance depuis la racine. Les noms
 * de conteneurs sont ceux du projet `tacita`, les mêmes qu'`apps/admin/tests/pile.test.ts`
 * modélise.
 */

const BUCKET = requireBucket();
const SYNAPSE = "tacita-synapse-1";
const GARAGE = "tacita-garage-1";

function requireBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) {
    throw new Error(
      "S3_BUCKET manquant : lancer via `npm run smoke`, qui charge infra/.env (voir infra/smoke/README.md)",
    );
  }
  return bucket;
}

const sha256 = (octets: Uint8Array): string => createHash("sha256").update(octets).digest("hex");

type Media = { serveur: string; id: string; empreinte: string };

async function televerser(jeton: string, nom: string, taille: number): Promise<Media> {
  const octets = randomBytes(taille);
  const reponse = await fetch(`${HOMESERVER}/_matrix/media/v3/upload?filename=${nom}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/octet-stream" },
    body: octets,
  });
  expect(reponse.status, `upload de ${nom} (${taille} octets) refusé`).toBe(200);
  const { content_uri } = (await reponse.json()) as { content_uri: string };
  const [, serveur, id] = /^mxc:\/\/([^/]+)\/(.+)$/.exec(content_uri) ?? [];
  expect(serveur, `content_uri illisible : ${content_uri}`).toBeTruthy();
  return { serveur: serveur!, id: id!, empreinte: sha256(octets) };
}

/** Le chemin que Synapse donne à une copie locale : `local_content/ab/cd/reste`. */
const effacerCopieLocale = ({ id }: Media): void => {
  execFileSync("docker", [
    "exec",
    SYNAPSE,
    "rm",
    "-f",
    `/data/media_store/local_content/${id.slice(0, 2)}/${id.slice(2, 4)}/${id.slice(4)}`,
  ]);
};

async function telecharger(jeton: string, { serveur, id }: Media): Promise<Response> {
  return fetch(`${HOMESERVER}/_matrix/client/v1/media/download/${serveur}/${id}`, {
    headers: { Authorization: `Bearer ${jeton}` },
  });
}

const objetsDansLeBucket = (): number => {
  const sortie = execFileSync("docker", ["exec", GARAGE, "/garage", "bucket", "info", BUCKET], {
    encoding: "utf-8",
  });
  const [, compte] = /^\s*Objects:\s*(\d+)/m.exec(sortie) ?? [];
  expect(compte, `« Objects: » introuvable dans la sortie de garage bucket info :\n${sortie}`).toBeTruthy();
  return Number(compte);
};

describe("un média envoyé à Synapse se relit depuis Garage, octet pour octet", () => {
  const compte = registerAccount(uniqueLocalpart("media"));

  it.each([
    ["1 Kio — un PUT simple", 1024],
    ["12 Mio — un upload multipart, au-dessus du seuil de 8 Mio de boto3", 12 * 1024 * 1024],
  ])("%s", async (_nom, taille) => {
    const { accessToken } = await compte;
    const media = await televerser(accessToken, "sonde.bin", taille);

    // Avec la copie locale, un GET passerait sans jamais toucher le bucket : l'assertion
    // ne prouverait rien de Garage. Sans elle, Synapse n'a plus que le bucket.
    effacerCopieLocale(media);

    const reponse = await telecharger(accessToken, media);
    expect(reponse.status, "Synapse n'a pas su relire le média depuis Garage").toBe(200);
    const octets = new Uint8Array(await reponse.arrayBuffer());
    expect(octets.byteLength).toBe(taille);
    expect(sha256(octets)).toBe(media.empreinte);
  });

  it("le bucket porte les objets envoyés — Synapse écrit bien dans Garage, pas seulement sur son disque", async () => {
    // Deux uploads au moins ont précédé ce test ; un `Objects: 0` dirait que `store_remote`
    // n'écrit nulle part, et les relectures ci-dessus n'auraient réussi que par hasard.
    expect(objetsDansLeBucket()).toBeGreaterThanOrEqual(2);
  });
});
