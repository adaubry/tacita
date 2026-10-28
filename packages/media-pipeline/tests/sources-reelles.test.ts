import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ecrireMp4, lireMp4, PROFILES, remuxable, type Bytes } from "../src";

/**
 * **des fichiers que nous n'avons pas écrits.**
 *
 * `demux.test.ts` relit notre propre muxeur : c'est un aller-retour, et un aller-retour
 * ne peut pas infirmer une hypothèse sur ce que les autres écrivent (règle 3). Ce qu'une
 * caméra produit est plus large que ce que nous produisons — `.mov` QuickTime, HEVC, piste
 * sonore en PCM, matrice de rotation — et **c'est exactement là qu'étaient les défauts** :
 * une vidéo d'iPhone ne partait pas du tout, parce que son `esds` vit un étage plus bas.
 *
 * Les fixtures sont minuscules (moins de 40 ko à deux), produites par ffmpeg, et
 * committées : sans elles, aucun test de ce dépôt ne voit un conteneur qui ne vient pas
 * de nous. Elles se relisent avec `ffprobe`, jamais avec un navigateur (interdit n°12).
 */
const fixture = (nom: string): Bytes =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${nom}`, import.meta.url)))) as Bytes;

describe("sources réelles : ce qu'une caméra écrit, et pas seulement nous", () => {
  it("un `.mov` d'iPhone (HEVC, AAC sous `wave`, matrice de rotation) se lit entièrement", async () => {
    const source = await lireMp4(fixture("iphone-hevc.mov"));

    expect(source.codec.startsWith("hvc1")).toBe(true);
    expect(source.largeur).toBe(192);
    expect(source.hauteur).toBe(144);
    expect(source.echantillons.length).toBeGreaterThan(0);
    // l'orientation vient de la matrice du `tkhd`, jamais devinée.
    expect(source.rotation).toBe(270);
    /*
     * **Le défaut, tenu par cette ligne.** QuickTime range `esds` dans un
     * atome `wave` ; ne le chercher qu'à la racine de l'entrée `mp4a` faisait lever, et
     * l'exception emportait la vidéo entière — aucune vidéo d'iPhone ne partait.
     */
    expect(source.audio?.esds.length).toBeGreaterThan(0);
    expect(source.audio?.echantillons.length).toBeGreaterThan(0);
    expect(source.audioAbandonne).toBe(false);
    // image et son : deux pistes de signal, la piste de métadonnées ne compte pas.
    expect(source.pistes).toBe(2);
  });

  it("une piste sonore non transportable ne fait pas échouer la vidéo, elle se signale", async () => {
    // Du PCM `sowt`, ce qu'écrivent les enregistrements d'écran et les vieux `.mov`.
    const source = await lireMp4(fixture("mov-pcm.mov"));

    expect(source.echantillons.length).toBeGreaterThan(0);
    expect(source.audio).toBeUndefined();
    // « il y avait du son et il ne part pas » se dit, quel qu'ait été le codec.
    expect(source.audioAbandonne).toBe(true);
    // Deux pistes de signal : le chemin rapide doit savoir qu'un remuxage perdrait le son.
    expect(source.pistes).toBe(2);
  });

  it("un `.mov` d'iPhone en H.264 fait l'aller-retour complet : conteneur, rotation, son", async () => {
    // E-18 — cette source est conforme aux cibles : c'est le **chemin rapide**, celui qui
    // remuxe sans rien réencoder. Le test parcourt donc exactement ce que le shard exécute.
    const source = await lireMp4(fixture("iphone-h264.mov"));
    expect(remuxable(source, PROFILES.good.video)).toBe(true);

    const relu = await lireMp4(
      ecrireMp4({
        largeur: source.largeur,
        hauteur: source.hauteur,
        description: source.description,
        echantillons: source.echantillons,
        rotation: source.rotation,
        audio: source.audio,
      }),
    );

    // l'orientation survit au changement de conteneur, sans toucher un pixel.
    expect(relu.rotation).toBe(source.rotation);
    expect(relu.rotation).not.toBe(0);
    expect(relu.echantillons).toHaveLength(source.echantillons.length);
    // la piste sonore de QuickTime, recopiée octet pour octet jusque dans
    // son `esds` — celui qu'on ne savait pas trouver.
    expect(relu.audio?.echantillons).toHaveLength(source.audio!.echantillons.length);
    expect([...relu.audio!.esds]).toEqual([...source.audio!.esds]);
  });

  it("le HEVC n'emprunte jamais le chemin rapide : notre conteneur ne décrit que du H.264", async () => {
    /*
     * **Le garde-fou, et pourquoi il compte.** `ecrireMp4` écrit une entrée `avc1` et une
     * boîte `avcC` — c'est D-04, et c'est ce qui rend le fichier lisible partout. Lui
     * confier une description `hvcC` produit un conteneur qui ment sur son contenu :
     * mp4box, en le relisant, lève sur une longueur aberrante. Rien n'empêche cela dans le
     * muxeur ; ce qui l'empêche est ce prédicat, et c'est lui qu'il faut tenir.
     *
     * Conséquence assumée : une vidéo HEVC est **toujours réencodée**, même déjà petite.
     * La remuxer telle quelle irait plus vite et ne perdrait rien — mais donnerait un
     * fichier que Firefox ne lit pas, ce qui est l'interdit n°13 pris par l'autre bout.
     */
    const hevc = await lireMp4(fixture("iphone-hevc.mov"));
    expect(hevc.codec.startsWith("avc1")).toBe(false);
    expect(remuxable(hevc, PROFILES.good.video)).toBe(false);
  });

  it("un conteneur que le démuxeur ne connaît pas échoue, il ne rend pas une source vide", async () => {
    // Un EBML (WebM/Matroska) : le repli du shard est l'envoi tel quel, et il a besoin
    // d'un rejet net pour se déclencher.
    await expect(lireMp4(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]) as Bytes)).rejects.toThrow();
  });
});

describe("le chemin rapide : le poids décide, pas la hauteur", () => {
  const cibles = PROFILES.good.video;
  /** Le film de la caméra in-app : 1080p portrait, enregistré au débit de la cible. */
  const filmCamera = { codec: "avc1.640028", hauteur: 1920, debitBps: 2_400_000, pistes: 2 };

  it("le film de la caméra se remuxe : le réencoder n'ôterait aucun octet", () => {
    expect(remuxable(filmCamera, cibles)).toBe(true);
  });

  it("une 4K se réduit toujours, même légère", () => {
    expect(remuxable({ ...filmCamera, hauteur: 2160 }, cibles)).toBe(false);
  });

  it("un débit au-dessus de la cible se réduit", () => {
    expect(remuxable({ ...filmCamera, debitBps: 8_000_000 }, cibles)).toBe(false);
  });

  it("le HEVC ne se remuxe jamais, quel que soit son poids", () => {
    expect(remuxable({ ...filmCamera, codec: "hvc1.1.6.L120.B0" }, cibles)).toBe(false);
  });
});
