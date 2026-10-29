import { describe, expect, it } from "vitest";

import { ecrireMp4, lireMp4, rotationDeMatrice, type Bytes, type EchantillonVideo } from "../src";

/**
 * **Le muxeur écrit, la bibliothèque relit.** Ce fichier est le seul endroit du dépôt où
 * une implémentation indépendante juge notre conteneur : mp4box n'a pas été écrit ici, ne
 * partage aucune ligne avec `mp4.ts`, et ne peut donc pas confirmer une erreur par
 * construction (règle 3). Le muxeur avait jusqu'ici pour seul juge un lecteur de boîtes
 * écrit dans le même dépôt.
 *
 * Aucune globale navigateur n'est nécessaire : c'est ce qui rendait cette dépendance
 * admissible, et ce test en est la preuve permanente.
 */

const DESCRIPTION = new Uint8Array([
  1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x04, 0x68,
  0xee, 0x3c, 0x80,
]) as Bytes;

const PAS_US = 33_333;

const echantillons = (nombre = 30): EchantillonVideo[] =>
  Array.from({ length: nombre }, (_u, rang) => ({
    donnees: new Uint8Array(Array.from({ length: 24 }, (_v, o) => (rang * 16 + o) & 0xff)) as Bytes,
    timestampUs: rang * PAS_US,
    cle: rang % 15 === 0,
  }));

describe("démuxage : ce qu'une bibliothèque indépendante lit de notre conteneur", () => {
  it("relit les dimensions, le codec, la durée et tous les échantillons", async () => {
    const fichier = ecrireMp4({ largeur: 640, hauteur: 360, description: DESCRIPTION, echantillons: echantillons() });
    const source = await lireMp4(fichier);

    expect(source.largeur).toBe(640);
    expect(source.hauteur).toBe(360);
    expect(source.codec).toBe("avc1.64001f");
    expect(source.echantillons).toHaveLength(30);
    expect(source.dureeMs).toBe(1000);
    expect(source.pistes).toBe(1);
    expect(source.audio).toBeUndefined();
    expect(source.audioAbandonne).toBe(false);
    // Le débit est **mesuré** sur les échantillons, pas lu dans un en-tête : 30 × 24 o
    // sur une seconde.
    expect(source.debitBps).toBe(30 * 24 * 8);
  });

  it("les octets et les horodatages traversent l'aller-retour intacts", async () => {
    const origine = echantillons(10);
    const source = await lireMp4(
      ecrireMp4({ largeur: 320, hauteur: 240, description: DESCRIPTION, echantillons: origine }),
    );

    expect(source.echantillons.map((e) => e.timestampUs)).toEqual(origine.map((e) => e.timestampUs));
    expect(source.echantillons.map((e) => e.cle)).toEqual(origine.map((e) => e.cle));
    expect([...source.echantillons[0]!.donnees]).toEqual([...origine[0]!.donnees]);
    expect([...source.echantillons[9]!.donnees]).toEqual([...origine[9]!.donnees]);
    // `avcC` ressort tel quel : le muxeur ne le lit pas, le démuxeur non plus.
    expect([...source.description]).toEqual([...DESCRIPTION]);
  });

  /** l'aller-retour de la rotation, le seul garde-fou sans navigateur. */
  it.each([0, 90, 180, 270] as const)("la rotation %s survit à l'écriture puis à la relecture", async (rotation) => {
    const fichier = ecrireMp4({
      largeur: 640,
      hauteur: 360,
      description: DESCRIPTION,
      echantillons: echantillons(4),
      rotation,
    });
    expect((await lireMp4(fichier)).rotation).toBe(rotation);
  });

  it("une matrice qui n'est pas une rotation reconnue ne tourne rien", () => {
    // Mise à l'échelle, cisaillement, matrice vide : le défaut est « comme codé », jamais
    // une rotation devinée.
    expect(rotationDeMatrice(undefined)).toBe(0);
    expect(rotationDeMatrice([0x20000, 0, 0, 0, 0x20000, 0, 0, 0, 0x40000000])).toBe(0);
    expect(rotationDeMatrice(new Int32Array([0, 0x8000, 0, -0x8000, 0, 0, 0, 0, 0x40000000]))).toBe(0);
  });

  it("des octets qui ne sont pas un MP4 lèvent, sans rendre une source vide", async () => {
    await expect(lireMp4(new Uint8Array(64) as Bytes)).rejects.toThrow();
  });
});

describe("la durée se lit sur les images quand l'en-tête n'en dit rien", () => {
  it("un `mvhd` à durée nulle — le MP4 fragmenté de Safari — garde sa durée et son débit", async () => {
    const fichier = ecrireMp4({ largeur: 640, hauteur: 360, description: DESCRIPTION, echantillons: echantillons() });
    // `mvhd` v0 : type, version+drapeaux, création, modification, échelle, **durée**.
    const type = [...fichier].findIndex(
      (_octet, rang) => String.fromCharCode(...fichier.slice(rang, rang + 4)) === "mvhd",
    );
    fichier.set([0, 0, 0, 0], type + 20);

    const source = await lireMp4(fichier);
    // 30 images à 33,3 ms : une seconde, et le débit qui en découle — non nul, donc le
    // chemin rapide redevient possible.
    expect(source.dureeMs).toBe(1000);
    expect(source.debitBps).toBe(30 * 24 * 8);
  });
});

describe("l'image clé se lit dans le flux, pas seulement dans le conteneur", () => {
  /** Échantillons AVCC : longueur sur 4 octets, puis la NAL (type dans les 5 bits bas). */
  const nal = (type: number) => [0, 0, 0, 3, type, 0x88, 0x84];
  const IDR = 0x65; // type 5
  const TRANCHE = 0x41; // type 1, image non IDR
  const SEI = 0x06; // type 6

  it("reconnaît une IDR, y compris derrière une autre NAL", async () => {
    const { contientIdr } = await import("../src/demux");
    expect(contientIdr(new Uint8Array(nal(IDR)), 4)).toBe(true);
    expect(contientIdr(new Uint8Array([...nal(SEI), ...nal(IDR)]), 4)).toBe(true);
    expect(contientIdr(new Uint8Array(nal(TRANCHE)), 4)).toBe(false);
  });

  it("un échantillon qui ne se découpe pas n'est jamais pris pour une IDR", async () => {
    const { contientIdr } = await import("../src/demux");
    // Une longueur annoncée qui déborde de l'échantillon : on ne devine rien.
    expect(contientIdr(new Uint8Array([0, 0, 0, 99, IDR, 0x88]), 4)).toBe(false);
    expect(contientIdr(new Uint8Array([0, 0, 0, 0, IDR]), 4)).toBe(false);
  });

  it("une IDR que le conteneur n'a pas marquée devient image clé — le MP4 de Safari", async () => {
    const source = await lireMp4(
      ecrireMp4({
        largeur: 320,
        hauteur: 240,
        description: DESCRIPTION,
        echantillons: [
          { donnees: new Uint8Array(nal(IDR)) as Bytes, timestampUs: 0, cle: false },
          { donnees: new Uint8Array(nal(TRANCHE)) as Bytes, timestampUs: PAS_US, cle: false },
        ],
      }),
    );
    // La première est attestée par le flux ; la seconde reste ce qu'elle est.
    expect(source.echantillons.map((echantillon) => echantillon.cle)).toEqual([true, false]);
  });
});

describe("`ctts` : l'ordre de présentation survit aux images B", () => {
  /**
   * Prérequis bloquant du profil High. Sans la table, un lecteur affiche les images dans
   * l'ordre où elles sont rangées, et la vidéo saute en arrière à chaque groupe.
   *
   * L'ordre de décodage ci-dessous est celui d'un encodeur avec B-frames : I, P, B — la
   * P se décode avant la B qu'elle suit à l'écran.
   */
  it("un flux à images B se relit dans l'ordre de présentation", async () => {
    const ordreDecodage = [0, 66_666, 33_333, 166_666, 133_333, 100_000];
    const source = await lireMp4(
      ecrireMp4({
        largeur: 320,
        hauteur: 240,
        description: DESCRIPTION,
        echantillons: ordreDecodage.map((timestampUs, rang) => ({
          donnees: new Uint8Array([rang, rang, rang, rang]) as Bytes,
          timestampUs,
          cle: rang === 0,
        })),
      }),
    );

    // mp4box rend `cts` — la date de présentation, reconstruite depuis `stts` **et**
    // `ctts`. Qu'elle corresponde prouve que la table est là et qu'elle est juste : sans
    // `ctts`, on relirait les dates de décodage, c'est-à-dire la suite triée.
    expect(source.echantillons.map((e) => e.timestampUs)).toEqual(ordreDecodage);
  });

  it("sans image B, aucune table n'est écrite — et la relecture est la même", async () => {
    const droit = ecrireMp4({ largeur: 320, hauteur: 240, description: DESCRIPTION, echantillons: echantillons(6) });
    expect(new TextDecoder("latin1").decode(droit)).not.toContain("ctts");
    expect((await lireMp4(droit)).echantillons.map((e) => e.timestampUs)).toEqual(
      echantillons(6).map((e) => e.timestampUs),
    );
  });
});

describe("faststart : `moov` avant `mdat`", () => {
  const positionDe = (fichier: Bytes, type: string): number =>
    new TextDecoder("latin1").decode(fichier).indexOf(type);

  it("les boîtes sortent dans l'ordre ftyp, moov, mdat", () => {
    const fichier = ecrireMp4({
      largeur: 640,
      hauteur: 360,
      description: DESCRIPTION,
      echantillons: echantillons(12),
    });

    const ftyp = positionDe(fichier, "ftyp");
    const moov = positionDe(fichier, "moov");
    const mdat = positionDe(fichier, "mdat");
    expect(ftyp).toBeGreaterThanOrEqual(0);
    expect(moov).toBeGreaterThan(ftyp);
    expect(mdat).toBeGreaterThan(moov);
  });

  /**
   * Le vrai risque du faststart n'est pas l'ordre, c'est le **décalage** : `stco` pointe
   * vers `mdat`, qui a bougé. Un décalage faux ne casse pas la lecture des boîtes — il
   * fait lire des octets arbitraires comme des échantillons, et mp4box les rendrait
   * différents de ceux écrits.
   */
  it("les échantillons se relisent au bon endroit après le déplacement de `moov`", async () => {
    const origine = echantillons(12);
    const source = await lireMp4(
      ecrireMp4({ largeur: 640, hauteur: 360, description: DESCRIPTION, echantillons: origine }),
    );

    expect(source.echantillons).toHaveLength(12);
    for (const rang of [0, 5, 11]) {
      expect([...source.echantillons[rang]!.donnees], `échantillon ${rang}`).toEqual([
        ...origine[rang]!.donnees,
      ]);
    }
  });
});

/**
 * **la seconde piste, de bout en bout.**
 *
 * L'`esds` est fabriqué ici à la main parce qu'aucun encodeur n'existe dans Node : ce que
 * le test prouve, c'est que le muxeur écrit une piste sonore qu'une implémentation
 * indépendante retrouve, avec ses échantillons intacts, ses durées exactes et ses deux
 * pistes entrelacées. Ce qu'il ne prouve pas — qu'un lecteur réel rende le son — se mesure
 * au navigateur et se consigne avec sa date.
 */
describe("piste audio : recopiée, entrelacée, relue", () => {
  /** Un `esds` minimal mais conforme : ES → DecoderConfig → AudioSpecificConfig AAC-LC. */
  const ESDS = new Uint8Array([
    0, 0, 0, 0x27, ...[..."esds"].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0, // version + drapeaux
    0x03, 0x19, 0x00, 0x02, 0x00, // ES_Descriptor
    0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00,
    0x05, 0x02, 0x12, 0x10, // DecoderSpecificInfo : AAC-LC, 44,1 kHz, stéréo
    0x06, 0x01, 0x02,
  ]) as Bytes;

  const TRAME = 1024;
  const audio = (nombre: number) => ({
    esds: ESDS,
    timescale: 44_100,
    frequence: 44_100,
    canaux: 2,
    echantillons: Array.from({ length: nombre }, (_u, rang) => ({
      donnees: new Uint8Array([0x21, rang & 0xff, 0x00, 0x00, 0x00, 0x00]) as Bytes,
      duree: TRAME,
    })),
  });

  it("la piste sonore ressort avec ses échantillons, ses durées et son format", async () => {
    // 30 images à 33 ms et 43 trames AAC : environ une seconde de chaque.
    const fichier = ecrireMp4({
      largeur: 640,
      hauteur: 360,
      description: DESCRIPTION,
      echantillons: echantillons(30),
      audio: audio(43),
    });
    const source = await lireMp4(fichier);

    expect(source.pistes).toBe(2);
    expect(source.audio).toBeDefined();
    expect(source.audio!.canaux).toBe(2);
    expect(source.audio!.frequence).toBe(44_100);
    expect(source.audio!.timescale).toBe(44_100);
    expect(source.audio!.echantillons).toHaveLength(43);
    // Les durées sont **recopiées**, pas recalculées : 1024 échantillons par trame, à
    // l'unité près, donc aucune dérive au bout de cinq minutes comme au bout d'une.
    expect(source.audio!.echantillons.every((e) => e.duree === TRAME)).toBe(true);
    expect([...source.audio!.echantillons[7]!.donnees]).toEqual([0x21, 7, 0, 0, 0, 0]);
    // La vidéo n'a pas bougé pour autant.
    expect(source.echantillons).toHaveLength(30);
  });

  it("l'aller-retour complet conserve les deux pistes", async () => {
    const premier = ecrireMp4({
      largeur: 320,
      hauteur: 240,
      description: DESCRIPTION,
      echantillons: echantillons(10),
      audio: audio(14),
    });
    const relu = await lireMp4(premier);
    // On remuxe ce qu'on vient de lire — c'est exactement ce que fait le chemin rapide.
    const second = await lireMp4(
      ecrireMp4({
        largeur: relu.largeur,
        hauteur: relu.hauteur,
        description: relu.description,
        echantillons: relu.echantillons,
        audio: relu.audio,
      }),
    );

    expect(second.audio!.echantillons).toHaveLength(14);
    expect(second.echantillons).toHaveLength(10);
    expect([...second.audio!.echantillons[3]!.donnees]).toEqual([0x21, 3, 0, 0, 0, 0]);
  });

  it("les deux pistes sont entrelacées, pas rangées bout à bout", async () => {
    // Trois secondes de chaque : sans entrelacement, la table de la vidéo aurait un seul
    // morceau, et celle de l'audio un seul aussi.
    const fichier = ecrireMp4({
      largeur: 320,
      hauteur: 240,
      description: DESCRIPTION,
      echantillons: echantillons(90),
      audio: audio(129),
    });

    // `stsc` compresse les séries : plusieurs morceaux par piste s'y voient à ce que la
    // table décrive plus d'un premier morceau, ou à ce que `stco` porte plusieurs adresses.
    const texte = new TextDecoder("latin1").decode(fichier);
    const stco = texte.indexOf("stco");
    const nombreDeMorceaux = new DataView(fichier.buffer, fichier.byteOffset).getUint32(stco + 8);
    expect(nombreDeMorceaux).toBeGreaterThan(1);

    // Et la relecture reste juste, ce qui est le vrai risque d'un `stco` à plusieurs entrées.
    const source = await lireMp4(fichier);
    expect(source.echantillons).toHaveLength(90);
    expect(source.audio!.echantillons).toHaveLength(129);
    expect([...source.echantillons[64]!.donnees]).toEqual([...echantillons(90)[64]!.donnees]);
  });

  it("sans son, le fichier reste mono-piste — jamais une piste vide", () => {
    const fichier = ecrireMp4({
      largeur: 320,
      hauteur: 240,
      description: DESCRIPTION,
      echantillons: echantillons(4),
    });
    expect(new TextDecoder("latin1").decode(fichier)).not.toContain("mp4a");
    expect(new TextDecoder("latin1").decode(fichier)).not.toContain("soun");
  });
});

/**
 * **Le MP4 fragmenté de Safari, tel qu'il range ses fragments** : un `moof` par fragment,
 * et dans la piste image **plusieurs `trun`**, chacun avec son `data_offset`, parce que
 * le son est entrelacé entre eux dans le `mdat`.
 *
 * mp4box 2.4.1 n'honore le `data_offset` que du premier `trun` d'une piste : il lisait le
 * second à la suite du premier, c'est-à-dire **dans le son**. Mesuré sur un film de la
 * caméra d'iPhone : de la 16ᵉ image à la fin, les « images » étaient les trames AAC — le
 * film se figeait après une demi-seconde, et le décodeur de Safari levait « Decoder
 * failure » sur le chemin du réencodage.
 */
describe("MP4 fragmenté à plusieurs `trun` par piste : chaque run se lit à son adresse", () => {
  const boite = (type: string, ...parts: number[][]): number[] => {
    const corps = parts.flat();
    const taille = 8 + corps.length;
    return [taille >>> 24, (taille >>> 16) & 0xff, (taille >>> 8) & 0xff, taille & 0xff, ...[...type].map((c) => c.charCodeAt(0)), ...corps];
  };
  const u32 = (v: number) => [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  const u64 = (v: number) => [...u32(0), ...u32(v)];

  /** Un `trun` avec `data_offset`, durée et taille par échantillon. */
  const trun = (donnees: Bytes[], decalage: number, duree: number) =>
    boite("trun", [0, 0, 0x03, 0x01], u32(donnees.length), u32(decalage), ...donnees.map((d) => [...u32(duree), ...u32(d.length)]));

  /** `tfhd` en `default-base-is-moof`, comme l'écrit AVFoundation. */
  const traf = (piste: number, ...truns: number[][]) =>
    boite("traf", boite("tfhd", [0, 0x02, 0, 0], u32(piste)), boite("tfdt", [1, 0, 0, 0], u64(0)), ...truns);

  it("les images du second run sont des images, pas le son qui les précède", async () => {
    // Un MP4 ordinaire à deux pistes, dont mp4box tire le segment d'initialisation.
    const images = echantillons(20);
    const trames = Array.from({ length: 10 }, (_u, rang) => ({
      donnees: new Uint8Array(12).fill(0xa0 + rang) as Bytes,
      duree: 1024,
    }));
    const ESDS = new Uint8Array([
      0, 0, 0, 0x27, ...[..."esds"].map((c) => c.charCodeAt(0)), 0, 0, 0, 0,
      0x03, 0x19, 0x00, 0x02, 0x00, 0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0xf4,
      0x00, 0x00, 0x01, 0xf4, 0x00, 0x05, 0x02, 0x12, 0x10, 0x06, 0x01, 0x02,
    ]) as Bytes;
    const audio = { esds: ESDS, timescale: 44_100, frequence: 44_100, canaux: 2, echantillons: trames };
    const ordinaire = ecrireMp4({ largeur: 320, hauteur: 240, description: DESCRIPTION, echantillons: images, audio });

    const { createFile, MP4BoxBuffer } = await import("mp4box");
    const init = await new Promise<Uint8Array>((ok) => {
      const fichier = createFile();
      fichier.onReady = (info) => {
        for (const piste of info.tracks) fichier.setSegmentOptions(piste.id, null, { nbSamples: 1000 });
        ok(new Uint8Array(fichier.initializeSegmentation().buffer));
      };
      fichier.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ordinaire.slice().buffer, 0));
      fichier.flush();
    });

    // Le fragment à la Safari : [images 0-9][son][images 10-19] dans le `mdat`.
    const run1 = images.slice(0, 10).map((e) => e.donnees);
    const run2 = images.slice(10).map((e) => e.donnees);
    const son = trames.map((t) => t.donnees);
    const longueur = (l: Bytes[]) => l.reduce((n, d) => n + d.length, 0);
    const construire = (taillMoof: number) => {
      const debut = taillMoof + 8;
      return boite(
        "moof",
        boite("mfhd", [0, 0, 0, 0], u32(1)),
        traf(1, trun(run1, debut, PAS_US), trun(run2, debut + longueur(run1) + longueur(son), PAS_US)),
        traf(2, trun(son, debut + longueur(run1), 1024)),
      );
    };
    const moof = construire(construire(0).length);
    const mdat = boite("mdat", [...run1, ...son, ...run2].flatMap((d) => [...d]));
    const fragmente = new Uint8Array([...init, ...moof, ...mdat]) as Bytes;

    const source = await lireMp4(fragmente);

    expect(source.echantillons).toHaveLength(20);
    source.echantillons.forEach((echantillon, rang) =>
      expect([...echantillon.donnees]).toEqual([...images[rang]!.donnees]),
    );
    expect(source.audio!.echantillons.map((t) => t.donnees[0])).toEqual(trames.map((t) => t.donnees[0]));
  });
});
