/**
 * Le pipeline média : un seul chemin d'envoi, pour tous les types de fichier.
 *
 *  1. Analyse de la source — type, dimensions, durée, verdict de plafond.
 *  2. Compression, si c'est un média, aux seuils du profil réseau courant.
 *  3. Chiffrement côté client : ce qui part est un blob opaque.
 *  4. Téléversement du blob, puis l'événement Matrix qui porte les clés.
 *
 * Le téléchargement lit la même chaîne à l'envers. Photo, vidéo, vocal, ZIP, PDF,
 * bureautique : la même, sans canal parallèle.
 */
import type { Session } from "@tacita/client-core";

import {
  decryptAttachment,
  decryptAttachmentByChunks,
  encryptAttachment,
  type Bytes,
  type CryptoEnvironment,
  type EncryptedFile,
} from "./attachments";
import { CHAMP_BLOCS, hachesParBloc } from "./blocs";
import type { CacheChiffre } from "./cache";
import {
  detectProfile,
  PROFILES,
  THUMBNAIL,
  type ImageTargets,
  type NetworkInformation,
  type VideoTargets,
} from "./profiles";

import { remuxWebmOpusVersOgg, WEBM_OPUS_MIME } from "./remux";
import { TAILLE_SNIFF, typeSniffe } from "./types-rendus";

export {
  decryptAttachment,
  decryptAttachmentByChunks,
  encryptAttachment,
  MediaIntegrityError,
  TAILLE_TRANCHE,
} from "./attachments";
export { SEUILS, verdictTaille } from "./plafonds";
export type { Seuils, Verdict } from "./plafonds";
export type { Bytes, EncryptedFile, FileKeys } from "./attachments";
export { ecrireMp4, TIMESCALE_US } from "./mp4";
export type { EchantillonVideo, Mp4Options, Rotation } from "./mp4";
export { lireMp4, rotationDeMatrice } from "./demux";
export type { SourceVideo } from "./demux";
export { crc32Ogg, echantillonsOpus, ecrireOggOpus } from "./ogg";
export { remuxWebmOpusVersOgg, WEBM_OPUS_MIME } from "./remux";
export { lireWebmOpus } from "./webm";
export type { WebmOpus } from "./webm";
export { CODECS_H264, detectProfile, PROFILES, remuxable, THUMBNAIL } from "./profiles";
export { BUDGET_DEFAUT, ouvrirCacheChiffre } from "./cache";
export { CHAMP_BLOCS, dechiffrerPlage, hachesParBloc, TAILLE_BLOC } from "./blocs";
export type { SourceChiffree } from "./blocs";
export type { CacheChiffre } from "./cache";
export { estRendable, resoudreType, TAILLE_SNIFF, typeSniffe, TYPES_RENDUS } from "./types-rendus";
export type { Resolution } from "./types-rendus";
export type { ImageTargets, NetworkProfile, VideoTargets } from "./profiles";

/** Forme d'onde MSC1767 : entiers 0–1024. */
export const WAVEFORM_BUCKETS = 60;
const WAVEFORM_SCALE = 1024;

/** D-03 — format de sortie unique des vocaux. Tout le reste passe par le transcodeur. */
export const VOICE_MIME_TYPE = "audio/ogg";

/** Ce qu'un flux d'écriture doit savoir faire, et rien de plus. */
export interface Ecrivain {
  write(donnees: Blob | Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface Raster {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Toutes les APIs navigateur du pipeline, injectées : le package reste sans DOM et
 * testable, et l'app décide où elles tournent — les opérations lourdes
 * (transcodage, compression vidéo) en Web Worker, jamais sur le thread principal.
 */
export interface MediaEnvironment extends CryptoEnvironment {
  /** Canvas/OffscreenCanvas. Sert aussi aux vignettes : même code, cibles différentes. */
  resizeImage(blob: Blob, targets: ImageTargets): Promise<Raster>;
  /**
   * WebCodecs, dans un Worker. `sansSon` remonte le cas de.
   *
   * **`poster` quand le transcodeur a pu peindre une image.** Les deux
   * chemins qui décodent (réencodage, et remuxage via une seule image clé) tiennent déjà
   * une frame : la rendre ici évite de rouvrir le fichier dans un lecteur pour redemander
   * ce qu'on avait sous la main. Absent sur le seul chemin qui ne décode rien — l'envoi
   * de la source telle quelle —, où `extractPoster` reste la réponse.
   */
  transcodeVideo(
    blob: Blob,
    targets: VideoTargets,
  ): Promise<Raster & { durationMs: number; sansSon?: boolean; poster?: Blob }>;
  /**
   * Une image extraite de la vidéo par un lecteur, **en dernier recours**.
   *
   * Le mécanisme le plus faible des trois : il rejoue le fichier dans un `<video>`, donc
   * il dépend de ce que la plateforme sait lire, et il échoue en silence là où un décodeur
   * aurait rendu une image. Il n'est appelé que lorsque `transcodeVideo` n'a pas de poster
   * — c'est-à-dire quand la source part telle quelle, le seul cas où l'on sait déjà que ce
   * lecteur ouvre le fichier, puisqu'il vient d'en donner les dimensions.
   */
  extractPoster(blob: Blob): Promise<Blob>;
  /** encodeur Opus WASM. */
  transcodeAudio(blob: Blob): Promise<Blob>;
  /** AudioContext.decodeAudioData, ramené au mono. */
  decodeAudio(blob: Blob): Promise<{ samples: Float32Array; durationMs: number }>;
  /** File System Access API, absente de Firefox et Safari. */
  saveViaFilePicker?(blob: Blob, filename: string): Promise<void>;
  /**
   * le **flux** d'écriture de la même API, quand elle est là.
   *
   * `saveViaFilePicker` prend un Blob, donc le fichier entier en clair et en mémoire :
   * c'est précisément ce qu'on veut éviter sur 400 Mo. Celui-ci rend de quoi écrire
   * tranche par tranche. Absent ⇒ chemin tout-ou-rien, borné par `SEUILS.dur`.
   */
  ouvrirEcriture?(filename: string): Promise<Ecrivain>;
  /** repli : téléchargement classique. */
  saveViaDownload(blob: Blob, filename: string): Promise<void>;
  /** D-04 — `navigator.connection`, absente sur Safari. */
  connection?: NetworkInformation;
  /**
   * le cache de chiffré, quand le câblage en fournit un.
   *
   * Optionnel, et sans repli à écrire : son absence rend simplement chaque téléchargement
   * au réseau, ce qui était le comportement d'avant.
   */
  cache?: CacheChiffre;
  /**
   * ce que le pipeline a dû abandonner en route, et que l'UI doit dire.
   *
   * Un rappel plutôt qu'une valeur de retour : `uploadAttachment` rend un contenu
   * d'événement, et une vidéo partie sans son n'a rien à y écrire — c'est une information
   * pour **l'expéditeur**, pas pour le destinataire ni pour le serveur.
   *
   * `video-non-compressee` suit la même règle : le fichier part, entier, parce que ce
   * navigateur n'a pas su le recompresser. Le destinataire le lira ; l'expéditeur, lui,
   * doit savoir qu'il vient d'envoyer l'original et non une version allégée.
   */
  signaler?(avis: "video-sans-son" | "video-non-compressee"): void;
}

/**
 * Audit des jonctions — **`type` et non `interface`, délibérément.** `@tacita/media-pipeline` promet
 * que « le pipeline produit un contenu prêt à `enqueue` », or `enqueue` prend
 * un `Record<string, unknown>` : une `interface` n'a pas d'index signature implicite,
 * un alias de type si. En `interface`, la passation déclarée **ne compilait pas**, et
 * personne ne pouvait le voir — aucun paquet ne dépend des deux, il n'existait aucun
 * site de compilation. Le shard de `apps/web` l'aurait découvert au premier envoi de
 * photo. `packages/outbox/tests/jonction-media.test-d.ts` est ce site.
 */
export type AttachmentContent = {
  msgtype: "m.image" | "m.video" | "m.audio" | "m.file";
  body: string;
  info: Record<string, unknown>;
  /** clés du blob principal. */
  file: EncryptedFile;
  /**
   * (b) — les empreintes par bloc du **fichier principal**, dans l'ordre.
   *
   * Extension à nous, namespacée, jamais présentée comme du Matrix natif : un client tiers
   * l'ignore et retombe sur `hashes.sha256`, que nous continuons d'écrire. C'est ce qui
   * rend la lecture progressive possible sans rien céder de et sans régression
   * d'interop.
   */
  [CHAMP_BLOCS]?: string[];
  "org.matrix.msc1767.audio"?: { duration: number; waveform: number[] };
  "org.matrix.msc3245.voice"?: Record<string, never>;
};

/**
 * un blob chiffré qui attend son URL, et l'endroit du contenu où l'écrire.
 *
 * Le chemin plutôt qu'un nom de champ : la vignette vit deux niveaux plus bas que le
 * fichier principal, et une file d'envoi qui ne connaît rien aux médias doit pouvoir
 * poser l'URL sans savoir lequel des deux elle vient de téléverser.
 */
export interface Televersement {
  chemin: string[];
  ciphertext: Bytes;
}

/** Ce que le pipeline produit **sans toucher au réseau** : le contenu, et ce qu'il reste à faire. */
export interface PieceJointePreparee {
  contenu: AttachmentContent;
  televersements: Televersement[];
}

type Kind = "image" | "video" | "audio" | "file";

const kindOf = (mimeType: string): Kind => {
  const [type] = mimeType.split("/");
  return type === "image" || type === "video" || type === "audio" ? type : "file";
};

/**
 * Le type du fichier choisi — **déclaré si l'appareil en donne un, reniflé sinon.**
 *
 * `File.type` est vide plus souvent qu'on ne le croit : glisser-déposer depuis certains
 * gestionnaires de fichiers, `.mkv` sous Windows, partages Android passant par un
 * fournisseur qui ne mappe pas l'extension. Le fichier partait alors en `m.file` — donc
 * ni compressé, ni vignetté, et affiché comme une pièce jointe quelconque au lieu d'une
 * vidéo. Les octets, eux, savent ce qu'ils sont : `typeSniffe` les lit.
 */
async function typeDuFichier(file: File): Promise<string> {
  if (file.type) return file.type;
  const entete = new Uint8Array(await file.slice(0, TAILLE_SNIFF).arrayBuffer());
  return typeSniffe(entete) ?? "";
}

/**
 * **le** chemin d'upload. Photos, vidéos, vocaux, ZIP, PDF, bureautique :
 * tout passe ici, aucun canal parallèle. Le nom du fichier n'est pas envoyé au serveur,
 * il ne vit que dans l'événement chiffré.
 */
/**
 * un blob chiffré, **et rangé en attente de téléversement**.
 *
 * L'URL est vide à ce stade : c'est la file d'envoi qui la posera, au chemin indiqué,
 * quand elle aura réussi le téléversement. Séparer les deux est ce qui rend
 * une reprise possible sans rechiffrer.
 */
async function chiffrerEnAttente(
  env: MediaEnvironment,
  blob: Blob,
  chemin: string[],
  enAttente: Televersement[],
): Promise<EncryptedFile> {
  const { ciphertext, keys } = await encryptAttachment(new Uint8Array(await blob.arrayBuffer()), env);
  enAttente.push({ chemin: [...chemin, "url"], ciphertext });
  return { ...keys, url: "" };
}

/** (b) — les empreintes par bloc du chiffré qui vient d'être rangé en attente. */
async function blocsDe(env: MediaEnvironment, enAttente: Televersement[]): Promise<string[]> {
  return hachesParBloc(enAttente.at(-1)!.ciphertext, env.subtle);
}

/**
 * **l'étape de téléversement, exposée à part, idempotente, sans retry propre.**
 *
 * Rejouée avec le même chiffré, elle ne rechiffre rien et ne régénère rien : ni clé, ni
 * IV, ni empreinte. C'est ce qui permet à la file d'envoi () de
 * reprendre un téléversement interrompu sans repasser par la compression.
 *
 * **Le pipeline ne retente jamais de lui-même** : une erreur remonte telle quelle, et
 * c'est la file qui décide du backoff, parce que c'est elle qui sait ce qui attend
 * derrière.
 *
 * **Limite de l'idempotence, à ne pas surestimer : elle est côté application, pas côté
 * serveur.** L'API media de Matrix n'offre aucune clé d'idempotence ; un téléversement
 * réussi dont la réponse se perd laisse un blob orphelin, et le rejeu en crée un second.
 * Acceptable — un blob opaque de plus, que jamais aucun événement ne référence — mais
 * écrit, sinon « idempotent » se lit comme une propriété de bout en bout.
 */
/**
 * **ce que le serveur accepte, demandé au serveur.**
 *
 * `m.upload.size` de `/_matrix/media/v3/config`. Pas de constante en dur : le plafond
 * appartient au déploiement, et un client qui le devine se trompera le jour
 * où il change. Rend `undefined` quand le serveur ne l'annonce pas — c'est la seule
 * réponse honnête, et l'appelant laisse alors passer.
 */
export async function plafondTeleversement(session: Session): Promise<number | undefined> {
  try {
    const config = await session.client.getMediaConfig();
    const plafond = (config as { "m.upload.size"?: unknown })["m.upload.size"];
    return typeof plafond === "number" && plafond > 0 ? plafond : undefined;
  } catch {
    // Un serveur qui ne répond pas sur sa configuration ne doit pas empêcher un envoi :
    // le refus viendra de lui, au pire, et il sera classé correctement.
    return undefined;
  }
}

/**
 * le refus **avant** le téléversement, avec de quoi le dire.
 *
 * Mesuré : une vidéo de onze minutes sort à environ 206 Mo aux cibles D-04,
 * au-dessus du plafond de 200 Mo du déploiement. Sans ce contrôle, le client téléversait
 * les 206 Mo pour s'entendre refuser à la fin — plusieurs minutes de réseau et de batterie
 * pour un échec connu d'avance, et un message qui ne disait pas pourquoi.
 */
export async function refusePourTaille(
  session: Session,
  televersements: readonly Televersement[],
): Promise<{ taille: number; plafond: number } | undefined> {
  const plafond = await plafondTeleversement(session);
  if (plafond === undefined) return undefined;

  const trop = televersements.find((televersement) => televersement.ciphertext.length > plafond);
  return trop ? { taille: trop.ciphertext.length, plafond } : undefined;
}

export async function uploadCiphertext(session: Session, ciphertext: Bytes): Promise<string> {
  const { content_uri } = await session.client.uploadContent(new Blob([ciphertext as BlobPart]), {
    includeFilename: false,
    type: "application/octet-stream",
  });
  return content_uri;
}

/**
 * vignette chiffrée séparément : deux blobs opaques, deux jeux de clés.
 *
 * Rend `{}` quand la source d'image n'a pas pu être produite. **La vignette est un
 * confort, l'envoi est la fonction** : une vidéo dont le navigateur ne sait pas extraire
 * de poster — ce qui arrive dès qu'un codec n'est pas décodable dans un `<video>` — faisait
 * échouer tout l'envoi sous « L'envoi de cette pièce jointe a échoué ». `thumbnail_file`
 * est facultatif dans l'événement, et un destinataire sans vignette affiche le premier
 * plan du média lui-même.
 */
async function vignetteEventuelle(
  env: MediaEnvironment,
  source: () => Promise<Blob>,
  enAttente: Televersement[],
): Promise<Record<string, unknown>> {
  // Le repère avant tentative : une vignette qui échoue **après** avoir été chiffrée
  // laisserait un téléversement en attente pointant vers un champ que le contenu ne porte
  // pas, et `poserUrl` casserait sur ce chemin au retour du serveur.
  const avant = enAttente.length;
  try {
    return await thumbnailOf(env, await source(), enAttente);
  } catch {
    enAttente.length = avant;
    return {};
  }
}

async function thumbnailOf(
  env: MediaEnvironment,
  source: Blob,
  enAttente: Televersement[],
): Promise<{ thumbnail_file: EncryptedFile; thumbnail_info: Record<string, unknown> }> {
  const raster = await env.resizeImage(source, THUMBNAIL);
  return {
    thumbnail_file: await chiffrerEnAttente(env, raster.blob, ["info", "thumbnail_file"], enAttente),
    thumbnail_info: {
      // **Le type obtenu, pas le type demandé.** Un canvas qui ne sait pas encoder le
      // format demandé rend du PNG en silence ; écrire ici la cible ferait mentir
      // l'événement sur ses propres octets, et le destinataire lirait un type faux.
      mimetype: raster.blob.type || THUMBNAIL.mimeType,
      w: raster.width,
      h: raster.height,
      size: raster.blob.size,
    },
  };
}

/** pics par tranche, normalisés sur l'échelle MSC1767. */
export function waveform(samples: Float32Array, buckets = WAVEFORM_BUCKETS): number[] {
  const width = Math.max(1, Math.ceil(samples.length / buckets));
  return Array.from({ length: buckets }, (_unused, bucket) => {
    let peak = 0;
    const end = Math.min((bucket + 1) * width, samples.length);
    for (let i = bucket * width; i < end; i++) peak = Math.max(peak, Math.abs(samples[i] ?? 0));
    return Math.round(peak * WAVEFORM_SCALE);
  });
}

/**
 * **Les formats qu'on accepte d'envoyer sans les convertir**, quand rien d'autre n'est
 * possible sur l'appareil.
 *
 * `audio/mp4` et `audio/aac` sont, du point de vue du *destinataire*, le choix le plus sûr
 * qui soit : un `<audio>` les joue partout, davantage que l'Ogg/Opus, que Safari n'a su
 * lire que tardivement. `decodeAudioData` les décode aussi, donc la durée et la forme
 * d'onde se calculent comme pour les autres.
 *
 * La liste est **close**, et c'est le point : un conteneur exotique que l'appareil
 * émetteur sait produire mais que personne ne sait lire doit échouer à l'envoi, pas
 * arriver chez quelqu'un sous la forme d'un message qu'il ne pourra pas ouvrir.
 */
const REPLIS_LISIBLES = ["audio/mp4", "audio/aac", "audio/mpeg"] as const;

const lisiblePartout = (type: string) =>
  REPLIS_LISIBLES.some((connu) => type.startsWith(connu));

/**
 * l'aiguillage des chemins d'entrée vers le format de sortie **préféré**.
 *
 * L'ordre compte : le moins cher d'abord. Un vocal Firefox ne coûte rien, un vocal Chrome
 * coûte une recopie d'octets, et un vocal Safari paie un encodage — que `transcodeAudio`
 * porte, dans le `MediaEnvironment` injecté.
 *
 * **Le dernier palier amende la règle « un seul format sort d'ici »** : elle
 * devient « un seul format *préféré*, et un repli lisible partout ». WebKit n'a ajouté
 * l'enregistrement WebM/Opus qu'en 18.4 ; sur un iOS resté en deçà, et sans encodeur
 * disponible, la règle d'origine ne produisait pas un vocal dans le bon format — elle
 * produisait **l'absence de vocal**. Un AAC un peu plus lourd vaut mieux qu'un message
 * qu'on ne peut pas envoyer, et l'Opus reste préféré partout où il existe, parce qu'il est
 * nettement meilleur aux débits de la voix.
 *
 * Le repli ne rattrape que les formats de `REPLIS_LISIBLES` : un échec de transcodage sur
 * autre chose reste un échec, et remonte tel quel pour que l'UI dise laquelle des trois
 * phrases.
 */
async function versFormatVocal(env: MediaEnvironment, file: File, type: string): Promise<Blob> {
  if (type.startsWith(VOICE_MIME_TYPE)) return file;

  if (type.startsWith(WEBM_OPUS_MIME)) {
    const ogg = remuxWebmOpusVersOgg(new Uint8Array(await file.arrayBuffer()));
    return new Blob([ogg as BlobPart], { type: VOICE_MIME_TYPE });
  }

  try {
    return await env.transcodeAudio(file);
  } catch (cause) {
    if (!lisiblePartout(type)) throw cause;
    return file;
  }
}

/**
 * Chiffre, téléverse et rend un contenu d'événement prêt à `enqueue`.
 * le profil réseau est détecté ici, une fois, et fixe les cibles D-04.
 */
export async function prepareAttachment(
  env: MediaEnvironment,
  file: File,
): Promise<PieceJointePreparee> {
  const enAttente: Televersement[] = [];
  const contenu = await construireContenu(env, file, enAttente);
  return { contenu, televersements: enAttente };
}

/**
 * le contenu d'événement, **sans réseau** : tout est compressé, chiffré,
 * et ce qui reste à téléverser est rangé dans `enAttente`.
 */
async function construireContenu(
  env: MediaEnvironment,
  file: File,
  enAttente: Televersement[],
): Promise<AttachmentContent> {
  const targets = PROFILES[detectProfile(env.connection)];
  const body = file.name;
  const type = await typeDuFichier(file);

  switch (kindOf(type)) {
    case "image": {
      // compression avant chiffrement : chiffrer d'abord rendrait le blob
      // incompressible.
      const raster = await env.resizeImage(file, targets.image);
      return {
        msgtype: "m.image",
        body,
        info: {
          mimetype: targets.image.mimeType,
          w: raster.width,
          h: raster.height,
          size: raster.blob.size,
          ...(await thumbnailOf(env, raster.blob, enAttente)),
        },
        file: await chiffrerEnAttente(env, raster.blob, ["file"], enAttente),
        [CHAMP_BLOCS]: await blocsDe(env, enAttente),
      };
    }

    case "video": {
      const video = await env.transcodeVideo(file, targets.video);
      // la vidéo part quand même, et l'UI le dit. Ne pas l'envoyer serait
      // pire ; l'envoyer en silence serait malhonnête (interdit n°13).
      if (video.sansSon) env.signaler?.("video-sans-son");
      return {
        msgtype: "m.video",
        body,
        info: {
          /*
           * **Le type des octets livrés, pas celui de la cible.** `transcodeVideo` peut
           * rendre la source telle quelle quand ce navigateur ne sait pas la recompresser :
           * annoncer `video/mp4` sur un `.mov` ou un `.webm` ferait mentir l'événement sur
           * ses propres octets, et c'est `info.mimetype` qui décide du rendu chez le
           * destinataire. Même règle que la vignette, pour la même raison.
           */
          mimetype: video.blob.type || targets.video.mimeType,
          w: video.width,
          h: video.height,
          duration: video.durationMs,
          size: video.blob.size,
          ...(await vignetteEventuelle(
            env,
            // l'image du décodeur d'abord, le lecteur seulement s'il n'y en a
            // pas : si on a su décoder la vidéo, on n'a aucune raison de la rouvrir.
            async () => video.poster ?? (await env.extractPoster(video.blob)),
            enAttente,
          )),
        },
        file: await chiffrerEnAttente(env, video.blob, ["file"], enAttente),
        [CHAMP_BLOCS]: await blocsDe(env, enAttente),
      };
    }

    case "audio": {
      /*
       * / D-03, amendé — **un format préféré, et un repli lisible
       * partout**. Quatre paliers, du moins cher au plus coûteux : Firefox rend déjà de
       * l'Ogg/Opus, Chrome et iOS 18.4+ rendent le même flux Opus dans un conteneur WebM
       * — un remuxage suffit, sans encodeur ni perte —, un encodeur disponible convertit
       * le MP4/AAC, et à défaut l'AAC part tel quel.
       *
       * Le `mimetype` se lit donc **sur le blob**, et n'est plus écrit d'avance : c'est la
       * sortie qui dit ce qu'elle est. L'écrire en dur annoncerait de l'Ogg sur un fichier
       * AAC, et le destinataire se fierait à l'étiquette plutôt qu'au contenu.
       */
      const audio = await versFormatVocal(env, file, type);
      const { samples, durationMs } = await env.decodeAudio(audio);
      return {
        msgtype: "m.audio",
        body,
        info: { mimetype: audio.type || VOICE_MIME_TYPE, duration: durationMs, size: audio.size },
        file: await chiffrerEnAttente(env, audio, ["file"], enAttente),
        [CHAMP_BLOCS]: await blocsDe(env, enAttente),
        "org.matrix.msc1767.audio": { duration: durationMs, waveform: waveform(samples) },
        "org.matrix.msc3245.voice": {},
      };
    }

    default:
      // ZIP, PDF, bureautique : pas de compression, mais exactement le même
      // chiffrement et le même upload que le reste.
      return {
        msgtype: "m.file",
        body,
        info: { mimetype: type || "application/octet-stream", size: file.size },
        file: await chiffrerEnAttente(env, file, ["file"], enAttente),
        [CHAMP_BLOCS]: await blocsDe(env, enAttente),
      };
  }
}

/**
 * **le** chemin d'upload, version « tout de suite » : prépare puis
 * téléverse dans la foulée.
 *
 * Conservé pour les appelants qui n'ont pas de file derrière eux — et parce que c'est lui
 * qui porte la promesse de l'interdit n°11 : un seul pipeline, quel que soit le type.
 * `Conversation` passe désormais par `prepareAttachment`, la file possédant la reprise
 *
 */
export async function uploadAttachment(
  session: Session,
  env: MediaEnvironment,
  file: File,
): Promise<AttachmentContent> {
  const { contenu, televersements } = await prepareAttachment(env, file);
  for (const televersement of televersements) {
    poserUrl(contenu, televersement.chemin, await uploadCiphertext(session, televersement.ciphertext));
  }
  return contenu;
}

/** Écrit une URL au bout d'un chemin. Le chemin existe : c'est le pipeline qui l'a créé. */
export function poserUrl(contenu: Record<string, unknown>, chemin: string[], url: string): void {
  let noeud: Record<string, unknown> = contenu;
  for (const cle of chemin.slice(0, -1)) noeud = noeud[cle] as Record<string, unknown>;
  noeud[chemin.at(-1)!] = url;
}

/**
 * **le seul chemin de ce paquet qui téléverse en clair, et il le dit dans
 * son nom.**
 *
 * Un avatar Matrix est un `mxc://` nu : tout client doit pouvoir l'afficher sans clé.
 * Chiffré, il n'est un avatar nulle part — un carré cassé chez tous les correspondants.
 * Le chiffrer serait donc une non-feature, pas une garantie (voie A) : le seul
 * choix honnête est de le poser en clair et de le **dire**, comme les réactions et les
 * épingles.
 *
 * Ce qui reste commun avec le reste du pipeline, et pourquoi l'interdit n°11 tient : même
 * compression, mêmes cibles D-04, même module. Ce qui diffère tient en une ligne — pas de
 * `encryptAttachment`, et un `mxc://` rendu au lieu d'un `EncryptedFile`.
 *
 * **Un seul appelant dans tout le dépôt** (le formulaire de profil, M-G). Ce n'est pas
 * une consigne de revue : un test structurel balaie les sources et échoue au second. La
 * phrase « tout ce qui sort du pipeline est chiffré, sauf l'unique chemin nommé public »
 * ne vaut que tant que « unique » est vérifié par une machine.
 */
export async function uploadPublicProfileImage(
  session: Session,
  env: MediaEnvironment,
  file: File,
): Promise<string> {
  // La même compression que les images de message : une photo de profil de 8 Mo est un
  // problème pour tout le monde, chiffrée ou non.
  const { blob } = await env.resizeImage(file, PROFILES[detectProfile(env.connection)].image);
  const { content_uri } = await session.client.uploadContent(blob, {
    // En clair et assumé : aucun `encryptAttachment` sur ce chemin. Le nom du fichier
    // n'est pas joint — il vient de l'appareil et n'apprend rien d'utile au serveur.
    includeFilename: false,
    type: blob.type,
  });
  return content_uri;
}

/**
 * sauvegarde locale de l'original **non compressé**, volontairement séparée
 * de l'envoi : le destinataire ne reçoit jamais que la version compressée.
 */
export async function saveOriginal(
  env: MediaEnvironment,
  original: Blob,
  filename: string,
): Promise<void> {
  // Appel via `env` : détacher la méthode lui ferait perdre son `this` si l'app
  // implémente `MediaEnvironment` avec une classe.
  await (env.saveViaFilePicker
    ? env.saveViaFilePicker(original, filename)
    : env.saveViaDownload(original, filename));
}

/**
 * récupération, vérification du hash, déchiffrement local.
 * Les endpoints média non authentifiés répondent 404 depuis Synapse v1.146
 * (infra/README.md) : aucune URL publique n'est supposée, et aucune vignette
 * n'est demandée au serveur — il ne saurait pas redimensionner un blob opaque.
 */
export async function downloadAttachment(
  session: Session,
  env: MediaEnvironment,
  file: EncryptedFile,
): Promise<Bytes> {
  return decryptAttachment(await downloadCiphertext(session, env, file.url), file, env.subtle);
}

/**
 * le chiffré **tel quel**, du cache s'il y est, du réseau sinon.
 *
 * Public depuis (b) : la lecture progressive a besoin du chiffré, pas du clair
 * — c'est elle qui déchiffre, bloc par bloc, à mesure que le lecteur demande des plages.
 *
 * Le cache est interrogé **avant** le réseau et rempli après, et il ne voit que du
 * chiffré : ce qui en sort repart vers `decryptAttachment` exactement comme ce qui vient
 * du réseau, avec la même vérification d'intégrité. Un cache empoisonné
 * échoue donc au hash, comme un blob corrompu en transit.
 */
export async function downloadCiphertext(session: Session, env: MediaEnvironment, url: string): Promise<Bytes> {
  const enCache = await env.cache?.lire(url).catch(() => undefined);
  if (enCache) return enCache;

  const octets = new Uint8Array(await (await recupererMedia(session, url)).arrayBuffer()) as Bytes;
  // L'écriture n'est pas attendue : un cache indisponible ou plein ne doit pas retarder
  // l'affichage, et encore moins le faire échouer.
  void env.cache?.ecrire(url, octets).catch(() => {});
  return octets;
}

/**
 * **le téléchargement d'un média, sans jamais tenir son clair en entier.**
 *
 * Le chiffré descend et se vérifie d'un bloc (mécanisme (a) : rien n'est
 * déchiffré avant que l'empreinte du tout soit bonne), puis le clair sort par tranches,
 * chacune écrite et relâchée. Le pic passe d'environ trois fois la taille du fichier à
 * « le chiffré, plus une tranche ».
 *
 * **Le clair va directement à la destination choisie par l'utilisateur** : aucun staging
 * OPFS, aucun fichier temporaire dans notre origine. Et rien n'est écrit avant la
 * vérification — un chiffré corrompu lève avant le premier `write`.
 *
 * Lève si l'environnement n'expose pas de flux : c'est à l'appelant de le savoir avant
 * (`verdictTaille` prend `flux` en entrée), pas de le découvrir ici.
 */
export async function downloadAttachmentToFile(
  session: Session,
  env: MediaEnvironment,
  file: EncryptedFile,
  filename: string,
): Promise<void> {
  if (!env.ouvrirEcriture) throw new Error("aucun flux d'écriture : téléchargement par tranches impossible");

  const ciphertext = await downloadCiphertext(session, env, file.url);

  // Le fichier n'est ouvert **qu'après** la première tranche : `decryptAttachmentByChunks`
  // vérifie l'empreinte avant de rendre quoi que ce soit, et un fichier vide créé puis
  // abandonné sur une erreur d'intégrité serait un déchet visible pour l'utilisateur.
  let ecrivain: Ecrivain | undefined;
  try {
    for await (const tranche of decryptAttachmentByChunks(ciphertext, file, env.subtle)) {
      ecrivain ??= await env.ouvrirEcriture(filename);
      await ecrivain.write(tranche);
    }
  } finally {
    await ecrivain?.close();
  }
}

/**
 * **le pendant en lecture du chemin public.** Un `mxc://` non chiffré (photo
 * de profil, bannière) rendu en `Blob`, prêt pour un `URL.createObjectURL`.
 *
 * Pourquoi une fonction et pas un `<img src>` : depuis Synapse v1.146 les endpoints média
 * anonymes répondent 404, et une balise `img` ne sait pas porter d'en-tête
 * `Authorization`. Sans ce chemin, une photo de profil correctement téléversée et
 * correctement posée sur le compte reste invisible — c'était le cas.
 *
 * Aucune vignette n'est demandée au serveur : elle le pourrait ici (le média est en
 * clair), mais ce serait un second chemin de rendu à tenir pour un avatar déjà compressé
 * par `uploadPublicProfileImage`.
 */
export async function downloadPublicImage(session: Session, mxcUrl: string): Promise<Blob> {
  return (await recupererMedia(session, mxcUrl)).blob();
}

/**
 * Les endpoints média non authentifiés répondent 404 depuis Synapse v1.146
 * (infra/README.md) : aucune URL publique n'est supposée, et aucune vignette
 * n'est demandée au serveur — il ne saurait pas redimensionner un blob opaque.
 */
async function recupererMedia(session: Session, mxcUrl: string): Promise<Response> {
  const url = session.client.mxcUrlToHttp(mxcUrl, undefined, undefined, undefined, false, true, true);
  if (!url) throw new Error("URL mxc invalide : média non téléchargeable");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${session.client.getAccessToken() ?? ""}` },
  });
  if (!response.ok) throw new Error(`téléchargement média refusé (HTTP ${response.status})`);

  return response;
}
