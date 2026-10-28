import { describe, expect, it } from "vitest";

import {
  crc32Ogg,
  echantillonsOpus,
  EnregistrementSansSon,
  lireWebmOpus,
  remuxWebmOpusVersOgg,
  type Bytes,
} from "../src";

/**
 * Le WebM d'entrée est **construit selon la spécification Matroska**, pas selon mon
 * lecteur : identifiants réels, vints réels, blocs réels, y compris la taille « inconnue »
 * que `MediaRecorder` écrit sur Segment et Cluster parce qu'il diffuse.
 *
 * Limite assumée, à ne pas masquer (règle 4 — « module terminé » et « produit qui
 * marche » sont deux portes) : ceci prouve la transformation, pas qu'un vrai blob de
 * `MediaRecorder` la traverse. Cette seconde porte demande un navigateur, que l'interdit
 * n°12 ferme à la suite de tests. Elle s'ouvrira au spike E-10, sur appareil réel.
 */

/**
 * `new Uint8Array(...)` et non `Uint8Array.from(...)` : le paquet type ses octets
 * `Uint8Array<ArrayBuffer>`, que `from` n'infère pas — il rend le buffer générique.
 */
const octets = (...valeurs: number[]): Bytes => new Uint8Array(valeurs);

/** Taille EBML sur 4 octets — assez large pour tout ce que ce test fabrique. */
function taille(valeur: number): number[] {
  return [0x10 | ((valeur >> 24) & 0x0f), (valeur >> 16) & 0xff, (valeur >> 8) & 0xff, valeur & 0xff];
}

function element(identifiant: number[], contenu: number[]): number[] {
  return [...identifiant, ...taille(contenu.length), ...contenu];
}

/** Taille inconnue : tous les bits de valeur à 1, ce qu'écrit un enregistrement en direct. */
const TAILLE_INCONNUE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/**
 * `OpusHead` minimal mais réel : signature, version 1, 1 canal, préchargement, 48 kHz.
 * Il n'est pas relu par le remuxeur — il est **recopié**, et c'est la propriété qu'on teste.
 */
const OPUS_HEAD = [
  0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, // « OpusHead »
  0x01, 0x01, 0x38, 0x01, 0x80, 0xbb, 0x00, 0x00, 0x00, 0x00, 0x00,
];

/**
 * Un paquet Opus est identifié par son octet TOC. `0x78` = config 15 (hybride FB 20 ms),
 * code 0 (une trame) → 960 échantillons à 48 kHz.
 */
const paquetOpus = (marqueur: number, longueur = 8) => [
  0x78,
  marqueur,
  // `& 0xff` : au-delà de 255 octets de charge utile, un compteur nu sortirait de la plage
  // d'un octet et le tableau attendu ne serait plus celui que le `Uint8Array` peut porter.
  ...Array.from({ length: longueur - 2 }, (_unused, rang) => rang & 0xff),
];

function blocSimple(paquet: number[], horodatage = 0): number[] {
  // Piste 1 (vint), horodatage relatif sur 2 octets, drapeaux (sans lacing), puis la trame.
  return [0x81, (horodatage >> 8) & 0xff, horodatage & 0xff, 0x80, ...paquet];
}

function webmDeTest(paquets: number[][], opusHead: number[] = OPUS_HEAD): Bytes {
  const tracks = element(
    [0x16, 0x54, 0xae, 0x6b],
    element([0xae], element([0x63, 0xa2], opusHead)),
  );
  const cluster = [
    0x1f, 0x43, 0xb6, 0x75,
    ...TAILLE_INCONNUE,
    ...paquets.flatMap((paquet, rang) => element([0xa3], blocSimple(paquet, rang * 20))),
  ];

  return octets(0x18, 0x53, 0x80, 0x67, ...TAILLE_INCONNUE, ...tracks, ...cluster);
}

/** Relit les pages d'un flux Ogg, en vérifiant leur CRC au passage. */
function lirePagesOgg(flux: Bytes) {
  const pages: { drapeaux: number; granule: number; sequence: number; paquets: Bytes[] }[] = [];
  let position = 0;

  while (position < flux.length) {
    expect(String.fromCharCode(...flux.subarray(position, position + 4))).toBe("OggS");
    const vue = new DataView(flux.buffer, flux.byteOffset + position);
    const segments = flux[position + 26]!;
    const lacing = flux.subarray(position + 27, position + 27 + segments);
    const debutCorps = position + 27 + segments;
    const corps = lacing.reduce((somme, valeur) => somme + valeur, 0);

    // La CRC se vérifie sur la page entière, son propre champ remis à zéro.
    const page = flux.slice(position, debutCorps + corps);
    const annoncee = new DataView(page.buffer).getUint32(22, true);
    new DataView(page.buffer).setUint32(22, 0, true);
    expect(crc32Ogg(page)).toBe(annoncee);

    const paquets: Bytes[] = [];
    let curseur = debutCorps;
    let longueur = 0;
    for (const valeur of lacing) {
      longueur += valeur;
      if (valeur < 255) {
        paquets.push(flux.subarray(curseur, curseur + longueur));
        curseur += longueur;
        longueur = 0;
      }
    }

    pages.push({
      drapeaux: flux[position + 5]!,
      granule: Number(vue.getBigUint64(6, true)),
      sequence: vue.getUint32(18, true),
      paquets,
    });
    position = debutCorps + corps;
  }

  return pages;
}

describe("remuxage WebM → Ogg : le flux Opus traverse intact", () => {
  it("extrait l'OpusHead et les paquets du WebM, dans l'ordre du fichier", () => {
    const lu = lireWebmOpus(webmDeTest([paquetOpus(0xaa), paquetOpus(0xbb)]));

    expect([...(lu.opusHead ?? [])]).toEqual(OPUS_HEAD);
    expect(lu.paquets.map((paquet) => paquet[1])).toEqual([0xaa, 0xbb]);
  });

  it("traverse les tailles inconnues que MediaRecorder écrit en diffusion", () => {
    // Segment et Cluster portent ici une taille « inconnue » : un lecteur qui la prendrait
    // pour une vraie longueur sortirait du fichier et ne trouverait aucun bloc.
    expect(lireWebmOpus(webmDeTest([paquetOpus(0x01)])).paquets).toHaveLength(1);
  });

  it("le flux Ogg s'ouvre sur OpusHead et OpusTags, chacun sur sa page", () => {
    const pages = lirePagesOgg(remuxWebmOpusVersOgg(webmDeTest([paquetOpus(0x01)])));

    expect(pages[0]!.drapeaux).toBe(0x02); // BOS
    expect([...pages[0]!.paquets[0]!]).toEqual(OPUS_HEAD);
    expect(String.fromCharCode(...pages[1]!.paquets[0]!.subarray(0, 8))).toBe("OpusTags");
    expect(pages.map((page) => page.sequence)).toEqual([0, 1, 2]);
  });

  it("les paquets audio sortent identiques, octet pour octet", () => {
    const entree = [paquetOpus(0x01, 5), paquetOpus(0x02, 300), paquetOpus(0x03, 255)];
    const pages = lirePagesOgg(remuxWebmOpusVersOgg(webmDeTest(entree)));

    const sortis = pages.slice(2).flatMap((page) => page.paquets.map((paquet) => [...paquet]));
    expect(sortis).toEqual(entree);
  });

  it("la granule avance de la durée réelle des paquets, lue dans leur TOC", () => {
    const pages = lirePagesOgg(
      remuxWebmOpusVersOgg(webmDeTest([paquetOpus(0x01), paquetOpus(0x02)])),
    );

    // Deux paquets de 960 échantillons : la page audio les achève tous les deux.
    expect(echantillonsOpus(octets(...paquetOpus(0x01)))).toBe(960);
    expect(pages.at(-1)!.granule).toBe(1920);
    expect(pages.at(-1)!.drapeaux).toBe(0x04); // EOS
  });

  it("un paquet multi-trames compte pour toutes ses trames", () => {
    // TOC code 3 : le nombre de trames vit dans les six bits de poids faible de l'octet 2.
    expect(echantillonsOpus(octets(0x7b, 0x03, 0x00))).toBe(2880);
  });

  it("sans OpusHead, le remuxage refuse au lieu de deviner les canaux", () => {
    const sansEntete = webmDeTest([paquetOpus(0x01)], []);
    expect(() => remuxWebmOpusVersOgg(sansEntete)).toThrow(/OpusHead/);
  });

  it("sans paquet audio, il refuse aussi", () => {
    expect(() => remuxWebmOpusVersOgg(webmDeTest([]))).toThrow(/aucun|sans paquet/i);
  });

  /**
   * **La classe, et pas seulement le message.** C'est sur elle que l'UI décide de dire
   * « aucun son n'a été capté » plutôt que « l'envoi a échoué », et un `instanceof` ne se
   * protège pas avec une expression régulière sur un texte. Vu en vrai sur iPhone : un
   * appel téléphonique garde la session audio, le chronomètre tourne, et le conteneur
   * sort sans un paquet.
   */
  it("les deux refus portent `EnregistrementSansSon`, sur quoi l'UI s'appuie", () => {
    const vides = [webmDeTest([]), webmDeTest([paquetOpus(0x01)], [])];
    for (const vide of vides) {
      expect(() => remuxWebmOpusVersOgg(vide)).toThrow(EnregistrementSansSon);
    }
  });

  it("un bloc lacé lève au lieu de produire un vocal muet", () => {
    const lace = octets(
      0x18, 0x53, 0x80, 0x67,
      ...TAILLE_INCONNUE,
      ...element([0xa3], [0x81, 0x00, 0x00, 0x06, ...paquetOpus(0x01)]),
    );
    expect(() => lireWebmOpus(lace)).toThrow(/lacé/);
  });
});
