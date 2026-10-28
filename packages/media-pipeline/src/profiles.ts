/** D-04 — deux profils, pas de troisième, pas de réglage utilisateur en V1. */
export type NetworkProfile = "good" | "constrained";

export interface ImageTargets {
  maxEdge: number;
  quality: number;
  mimeType: string;
}

export interface VideoTargets {
  height: number;
  bitrate: number;
  mimeType: string;
}

/**
 * JPEG pour les images, MP4/H.264 pour les vidéos : lisible partout, et la vidéo
 * n'a pas la contrainte d'interopérabilité qui impose Opus aux vocaux.
 */
export const PROFILES: Record<NetworkProfile, { image: ImageTargets; video: VideoTargets }> = {
  good: {
    image: { maxEdge: 2048, quality: 0.8, mimeType: "image/jpeg" },
    video: { height: 720, bitrate: 2_500_000, mimeType: "video/mp4" },
  },
  constrained: {
    image: { maxEdge: 1280, quality: 0.7, mimeType: "image/jpeg" },
    video: { height: 480, bitrate: 1_000_000, mimeType: "video/mp4" },
  },
};

/**
 * Vignette : indépendante du profil réseau, elle est déjà minuscule.
 *
 * **512 px et WebP.** 320 px était sous-dimensionné : une vignette
 * qui occupe 220 px CSS sur un écran à trois pixels physiques par point en demande 660 —
 * elle était floue sur tout téléphone récent. Le WebP à 0,75 reprend largement le poids
 * que la résolution ajoute, et reste sous celui du JPEG à 320.
 *
 * Le repli JPEG n'est pas une préférence, c'est une nécessité **vérifiée** : un canvas à
 * qui l'on demande un type qu'il ne sait pas encoder rend du PNG **sans le dire**, et un
 * PNG de photo pèse plusieurs fois le JPEG qu'il remplace. C'est `resizeImage` qui doit
 * relire le type obtenu, pas le supposer.
 */
export const THUMBNAIL: ImageTargets = { maxEdge: 512, quality: 0.75, mimeType: "image/webp" };

export interface NetworkInformation {
  effectiveType?: string;
  saveData?: boolean;
}

const CONSTRAINED = new Set(["slow-2g", "2g", "3g"]);

/**
 * / D-04 — Network Information API. Absente sur Safari : le repli est
 * « bon réseau », choisi pour ne pas dégrader par défaut ce qu'on ne sait pas mesurer.
 */
export function detectProfile(connection?: NetworkInformation): NetworkProfile {
  if (!connection) return "good";
  if (connection.saveData) return "constrained";
  return connection.effectiveType && CONSTRAINED.has(connection.effectiveType)
    ? "constrained"
    : "good";
}

/**
 * / D-04 — **l'échelle de repli du profil H.264**, du meilleur au plus sûr.
 *
 * High 4.0 d'abord : Baseline interdit CABAC et les images B, soit 15 à 25 % de débit
 * perdu à qualité perçue égale. La configuration retenue est la **première supportée**,
 * mesurée par `VideoEncoder.isConfigSupported` et jamais supposée — c'est le shard qui
 * mesure, ces chaînes ne sont que la liste et son ordre.
 */
export const CODECS_H264 = ["avc1.640028", "avc1.4d401f", "avc1.42001f"] as const;

/**
 * Marge au-dessus de la cible en deçà de laquelle un réencodage ne rendrait rien.
 * Réencoder une source à 3,1 Mbit/s pour viser 2,5 coûte une génération de perte et une
 * attente, pour un gain que personne ne voit.
 */
const MARGE_DEBIT = 1.3;

/**
 * Au-delà, même à débit sage, on réduit : 1920 de hauteur codée couvre le 1080p dans les
 * deux sens (paysage 1920 × 1080, portrait 1080 × 1920), et rien au-dessus — une 4K à
 * 2,5 Mbit/s pèserait peu mais coûterait à décoder chez chaque destinataire.
 */
const HAUTEUR_MAX_REMUX = 1920;

/**
 * / E-18 — **le chemin rapide : une source déjà conforme se remuxe, elle ne
 * se réencode pas.**
 *
 * Ce que le prédicat exige, et pourquoi :
 * - **H.264**, parce que c'est ce que notre conteneur sait décrire ;
 * - **débit sous la cible et sa marge** : c'est le poids qui fait la cible. Une source
 *   qui y est déjà ne gagnerait **aucun octet** à être réencodée ; elle y perdrait une
 *   génération, du temps, de la batterie — et, sur iPhone, l'envoi entier, le décodeur
 *   WebCodecs de Safari refusant les films de sa propre caméra (« Decoder failure »,
 *   mesuré sur iPhone) ;
 * - **hauteur sous 1920**, pas sous la cible : le film de la caméra in-app est
 *   enregistré au débit de la cible en 1080p, et le réduire à 720p ne l'allégeait pas ;
 * - **au plus deux pistes** : une vidéo, éventuellement du son. Au-delà — angles
 *   multiples, sous-titres, piste de timecode — la source n'est pas ordinaire, et la
 *   remuxer perdrait sans le dire ce que le conteneur ne sait pas porter.
 *
 * Le son AAC est recopié tel quel par le muxeur, sur ce chemin comme sur celui du
 * réencodage.
 */
export function remuxable(
  source: { codec: string; hauteur: number; debitBps: number; pistes: number },
  cibles: VideoTargets,
): boolean {
  return (
    source.codec.startsWith("avc1") &&
    source.hauteur > 0 &&
    source.hauteur <= HAUTEUR_MAX_REMUX &&
    source.debitBps > 0 &&
    source.debitBps <= cibles.bitrate * MARGE_DEBIT &&
    source.pistes <= 2
  );
}
