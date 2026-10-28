/**
 * L'environnement média : ce que le pipeline reçoit du navigateur.
 *
 * Le pipeline est headless et ne connaît ni `document`, ni `<canvas>`, ni WebCodecs.
 * Ce fichier lui fournit ces capacités, et rend `TranscodageIndisponible` quand la
 * plateforme ne les a pas — un refus nommé, que l'écran sait afficher.
 */
import type { MediaEnvironment, Raster } from "@tacita/media-pipeline";

import type { MotifEchec } from "./transcode-video";
import type { DemandeTranscodage, ReponseTranscodage } from "./transcode-worker";

/**
 * L'implémentation navigateur du `MediaEnvironment` que le pipeline attend
 * injecté. Le paquet reste sans DOM ; c'est ici que les APIs du navigateur entrent.
 */

/**
 * Ce qui manque au shard pour produire les formats de sortie imposés. **Lever avec un type
 * nommé, jamais rendre un blob approximatif** : un vocal qui n'est pas de l'Ogg/Opus est
 * illisible par les clients Matrix standards, et une vidéo non transcodée partirait
 * au format brut de l'appareil, à des dizaines de mégaoctets.
 *
 * Ce qui manque est plus étroit qu'un codec : Firefox enregistre déjà en Ogg/Opus, Chrome
 * produit du flux Opus dans un conteneur WebM (il manque un remuxage), et WebCodecs encode
 * la vidéo (il manque un muxeur MP4). Seul Safari, qui rend du MP4/AAC, demande un vrai
 * encodeur. Le détail est dans ESCALATIONS § E-10 — c'est ce qui rend l'arbitrage ouvert
 * plutôt que joué d'avance.
 *
 * L'UI ne propose pas ces deux chemins tant qu'ils ne sont pas couverts : c'est la seule
 * façon honnête de ne pas afficher une fonction qui échouerait (interdit n°13).
 *
 * **Arbitré : encodage dans le shard, empaquetage dans le paquet.** Le
 * remuxage WebM → Ogg et le muxeur MP4 vivent dans `@tacita/media-pipeline` ; la vidéo et
 * les vocaux Chrome/Edge/Firefox sont couverts.
 *
 * Reste `transcodeAudio`, appelé pour le seul chemin Safari/iOS (MP4/AAC → Opus). Il lève
 * tant que le spike E-10 n'a pas dit si `WebCodecs` encode l'Opus sur les iOS ciblés ;
 * selon sa réponse, l'implémentation sera un `AudioEncoder` ici, ou un encodeur WASM
 * **dans le paquet** — jamais une dépendance d'`apps/web`, restant close.
 */
export class TranscodageIndisponible extends Error {
  /** ce qui a échoué, pour que l'UI dise laquelle des trois phrases. */
  readonly motif: MotifEchec;

  constructor(quoi: "video" | "audio", detail?: string, motif: MotifEchec = "autre") {
    super(detail ?? `transcodage ${quoi} indisponible dans le shard : voir ESCALATIONS E-10`);
    this.name = "TranscodageIndisponible";
    this.motif = motif;
  }
}

/**
 * File System Access API — absente de Firefox et Safari, d'où la lecture conditionnelle.
 * Les types du DOM ne la déclarent pas encore ; c'est le seul cast du fichier.
 */
const choisirFichier = (
  globalThis as unknown as {
    showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
      createWritable(): Promise<{ write(data: Blob | Uint8Array): Promise<void>; close(): Promise<void> }>;
    }>;
  }
).showSaveFilePicker;

/** Redimensionne en respectant le ratio, sans jamais agrandir. */
function cible(largeur: number, hauteur: number, maxEdge: number) {
  const facteur = Math.min(1, maxEdge / Math.max(largeur, hauteur));
  return { width: Math.round(largeur * facteur), height: Math.round(hauteur * facteur) };
}

async function dessiner(source: ImageBitmap, maxEdge: number, mimeType: string, quality: number) {
  const { width, height } = cible(source.width, source.height, maxEdge);
  const canvas = new OffscreenCanvas(width, height);
  const contexte = canvas.getContext("2d");
  if (!contexte) throw new Error("contexte 2d indisponible : compression impossible");

  contexte.drawImage(source, 0, 0, width, height);
  source.close();

  const blob = await canvas.convertToBlob({ type: mimeType, quality });
  /*
   * **Le repli se vérifie, il ne se suppose pas.** Un canvas à qui l'on demande un type
   * qu'il ne sait pas encoder ne lève pas : il rend du **PNG**, silencieusement, et un PNG
   * de photo pèse plusieurs fois le JPEG qu'il devait remplacer. La vignette WebP de
   * `THUMBNAIL` deviendrait donc plus lourde là où elle n'est pas supportée — l'inverse
   * exact de ce qu'on cherchait.
   */
  if (blob.type === mimeType || mimeType === "image/jpeg") return { blob, width, height };
  return { blob: await canvas.convertToBlob({ type: "image/jpeg", quality }), width, height };
}

const fini = (valeur: number): boolean => Number.isFinite(valeur) && valeur > 0;

/**
 * **Aucune attente d'événement média n'est laissée sans issue.** Un `<video>` qui ne peut
 * pas décoder n'émet ni `loadeddata` ni toujours `error` — et un `seeked` qui n'arrive
 * jamais laissait la promesse ouverte pour de bon : l'envoi restait « en cours » sans fin
 * et sans message, ce qui est le pire des états. Dix secondes est large pour une
 * ouverture locale, et fini.
 */
function evenement(cible: HTMLVideoElement, nom: string, delaiMs = 10_000): Promise<void> {
  return new Promise((resoudre, rejeter) => {
    const minuteur = setTimeout(() => {
      fin();
      rejeter(new Error(`vidéo : ${nom} n'est jamais venu`));
    }, delaiMs);
    const fin = () => {
      clearTimeout(minuteur);
      cible.removeEventListener(nom, ok);
      cible.removeEventListener("error", ko);
    };
    const ok = () => {
      fin();
      resoudre();
    };
    const ko = () => {
      fin();
      rejeter(new Error("vidéo illisible par ce navigateur"));
    };
    cible.addEventListener(nom, ok, { once: true });
    cible.addEventListener("error", ko, { once: true });
  });
}

/**
 * Un `<video>` hors document, chargé jusqu'à sa première image, et de quoi le relâcher.
 *
 * `playsInline` et `muted` ne sont pas cosmétiques : sans eux, iOS refuse de décoder un
 * média qui n'est pas dans le document et l'élément reste vide — ce qui se voyait comme
 * une vignette manquante, jamais comme une cause.
 */
async function ouvrirVideo(blob: Blob): Promise<{ video: HTMLVideoElement; liberer: () => void }> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  const url = URL.createObjectURL(blob);
  video.src = url;
  const liberer = () => {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };

  try {
    await evenement(video, "loadeddata");
    return { video, liberer };
  } catch (cause) {
    liberer();
    throw cause;
  }
}

/** Se place sur une image donnée, sans jamais rester suspendu si `seeked` n'arrive pas. */
async function chercher(video: HTMLVideoElement, seconde: number): Promise<void> {
  if (!(seconde > 0)) return;
  video.currentTime = seconde;
  // Un `seeked` qui n'arrive pas n'est pas un échec : l'image déjà chargée fera l'affaire.
  await evenement(video, "seeked", 3_000).catch(() => {});
}

/**
 * **ce que la source mesure, quand on n'a pas pu la transcoder.**
 *
 * Le `<video>` du navigateur lit beaucoup plus large que `VideoDecoder` : il ouvre les
 * conteneurs que le démuxeur ne connaît pas (WebM, Matroska) et les codecs que WebCodecs
 * refuse. Ce qu'il en dit — dimensions affichées, durée — suffit à décrire honnêtement le
 * fichier dans l'événement.
 */
async function mesurerVideo(blob: Blob): Promise<{ width: number; height: number; durationMs: number }> {
  const { video, liberer } = await ouvrirVideo(blob);
  try {
    if (!video.videoWidth || !video.videoHeight) throw new Error("vidéo sans dimensions lisibles");
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: fini(video.duration) ? Math.round(video.duration * 1000) : 0,
    };
  } finally {
    liberer();
  }
}

/**
 * démuxage par le paquet, décodage et réencodage par `WebCodecs`,
 * empaquetage par le muxeur du paquet. Le shard n'écrit aucun format.
 *
 * **Dans un worker**, comme `@tacita/media-pipeline` l'exige depuis l'origine : un transcodage tient le
 * processeur pendant des secondes, et sur le thread de rendu c'est la timeline qui se
 * fige. Un worker par transcodage, terminé aussitôt après — pas de pool à tenir pour une
 * opération que l'utilisateur déclenche une fois de temps en temps.
 */
function viaWorker(
  blob: Blob,
  cibles: Parameters<MediaEnvironment["transcodeVideo"]>[1],
): Promise<Raster & { durationMs: number; sansSon?: boolean; poster?: Blob }> {
  return new Promise((resoudre, rejeter) => {
    const worker = new Worker(new URL("./transcode-worker.ts", import.meta.url));
    worker.onmessage = ({ data }: MessageEvent<ReponseTranscodage>) => {
      worker.terminate();
      if (data.ok)
        resoudre({
          blob: data.blob,
          width: data.width,
          height: data.height,
          durationMs: data.durationMs,
          sansSon: data.sansSon,
          poster: data.poster,
        });
      else rejeter(new TranscodageIndisponible("video", data.message, data.motif));
    };
    worker.onerror = () => {
      worker.terminate();
      rejeter(new TranscodageIndisponible("video"));
    };
    worker.postMessage({ blob, cibles } satisfies DemandeTranscodage);
  });
}

/**
 * La partie du `MediaEnvironment` que le navigateur couvre nativement : compression
 * d'image, poster de vidéo, décodage audio, sauvegarde locale, profil réseau.
 *
 * `OffscreenCanvas` plutôt que `<canvas>` : le redimensionnement d'une photo de 12 Mpx
 * bloque le thread principal une demi-seconde, et cet objet est transférable dans un
 * worker le jour où on l'y déplace (contrainte `@tacita/media-pipeline`).
 */
export function environnementMedia(options: { signaler?: MediaEnvironment["signaler"] } = {}): MediaEnvironment {
  return {
    /** le canal par lequel le pipeline dit ce qu'il a dû abandonner. */
    signaler: options.signaler,
    subtle: globalThis.crypto.subtle,
    getRandomValues: (bytes) => {
      globalThis.crypto.getRandomValues(bytes);
    },

    async resizeImage(blob, targets): Promise<Raster> {
      return dessiner(await createImageBitmap(blob), targets.maxEdge, targets.mimeType, targets.quality);
    },

    /**
     * Une image de la vidéo, prise après le tout début : la première frame d'une vidéo
     * de téléphone est très souvent noire, et une vignette noire n'aide personne.
     */
    async extractPoster(blob) {
      const { video, liberer } = await ouvrirVideo(blob);
      try {
        await chercher(video, Math.min(0.1, (fini(video.duration) ? video.duration : 0) / 2));
        if (!video.videoWidth || !video.videoHeight) throw new Error("vidéo sans image : aucune vignette");

        const canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight);
        canvas.getContext("2d")?.drawImage(video, 0, 0);
        return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
      } finally {
        liberer();
      }
    },

    async decodeAudio(blob) {
      // `AudioContext` et non `OfflineAudioContext` : le second exige de connaître la
      // durée avant de décoder, ce qu'on cherche justement à apprendre.
      const contexte = new AudioContext();
      try {
        const audio = await contexte.decodeAudioData(await blob.arrayBuffer());
        return { samples: audio.getChannelData(0), durationMs: Math.round(audio.duration * 1000) };
      } finally {
        void contexte.close();
      }
    },

    async transcodeVideo(blob, cibles) {
      try {
        return await viaWorker(blob, cibles);
      } catch (cause) {
        /*
         * / interdit n°13 — **le dernier recours : la source telle quelle.**
         *
         * Trois familles de sources échouent au chemin nominal, et aucune n'est
         * marginale : les conteneurs que le démuxeur ne connaît pas (WebM et Matroska,
         * soit tout ce qu'un navigateur enregistre lui-même), les codecs que `VideoDecoder`
         * refuse là où l'appareil sait pourtant les lire (HEVC hors Safari), et les
         * navigateurs sans encodeur H.264 (Firefox, selon la version). Refuser l'envoi
         * dans ces trois cas, c'était refuser une vidéo parfaitement lisible chez le
         * destinataire — le contraire de ce que la compression est censée apporter.
         *
         * La condition tient en une phrase : **si le navigateur sait l'ouvrir, il sait
         * en donner les dimensions**, et le destinataire saura la lire aussi. S'il ne
         * sait pas l'ouvrir, l'échec est réel et l'erreur d'origine remonte, avec son
         * motif et donc sa phrase.
         *
         * Ce qui est perdu est dit, pas masqué : le fichier part **non compressé**, il
         * peut donc être gros, et `refusePourTaille` reste le garde-fou côté serveur.
         */
        const mesure = await mesurerVideo(blob).catch(() => undefined);
        if (!mesure) throw cause;

        // La raison voyage avec l'avis : « ce navigateur ne sait pas » recouvrait trois
        // pannes différentes, et une vidéo d'iPhone partie entière ne disait pas laquelle.
        options.signaler?.("video-non-compressee", cause instanceof Error ? cause.message : undefined);
        return { blob, ...mesure };
      }
    },

    transcodeAudio() {
      return Promise.reject(new TranscodageIndisponible("audio"));
    },

    /**
     * l'original non compressé, sur l'appareil. `showSaveFilePicker` est
     * absent de Firefox et Safari ; `saveOriginal` retombe alors sur le téléchargement.
     */
    saveViaFilePicker: choisirFichier
      ? async (blob, filename) => {
          const flux = await (await choisirFichier({ suggestedName: filename })).createWritable();
          await flux.write(blob);
          await flux.close();
        }
      : undefined,

    /**
     * le **flux** de la même API, pour écrire un gros média tranche par
     * tranche. Même absence que `saveViaFilePicker` sur Firefox et Safari : le pipeline
     * retombe alors sur le chemin tout-ou-rien, borné par `SEUILS.dur`.
     */
    ouvrirEcriture: choisirFichier
      ? async (filename) => {
          const flux = await (await choisirFichier({ suggestedName: filename })).createWritable();
          return {
            // `write` du FileSystemWritableFileStream accepte les deux ; le type du
            // paquet ne promet que ce que les deux appelants passent réellement.
            write: (donnees) => flux.write(donnees as Blob),
            close: () => flux.close(),
          };
        }
      : undefined,

    async saveViaDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const lien = document.createElement("a");
      lien.href = url;
      lien.download = filename;
      lien.click();
      // Révoquer immédiatement annulerait le téléchargement dans Safari : l'URL doit
      // survivre au tour de boucle où le clic est traité.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },

    // D-04 — absente de Safari ; le pipeline retombe alors sur « bon réseau », et ne
    // dégrade pas ce qu'il ne mesure pas.
    connection: (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean } })
      .connection,
  };
}
