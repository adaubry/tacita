/**
 * Le transcodage vidéo dans le navigateur : WebCodecs, démux vers remux.
 *
 *  1. `dimensionsCibles` — la taille de sortie, en gardant le rapport d'origine.
 *  2. `transcoderVideo` — décode, ré-encode aux cibles, ré-empaquette en MP4.
 *
 * `EchecTranscodage` porte le motif (`codec-source`, `encodeur`, `autre`) parce que
 * l'appel suivant en dépend : un codec source non lu ne se réessaie pas, une panne
 * d'encodeur peut-être.
 */
import {
  CODECS_H264,
  ecrireMp4,
  lireMp4,
  remuxable,
  TIMESCALE_US,
  type Bytes,
  type EchantillonVideo,
  type Raster,
  type Rotation,
  type SourceVideo,
  type VideoTargets,
} from "@tacita/media-pipeline";

/**
 * côté shard — **l'encodage vit ici, le conteneur dans le paquet**.
 *
 * Le paquet démuxe et muxe des octets ; `WebCodecs` décode et réencode. Aucun élément
 * `<video>`, aucun canvas dans le chemin nominal — c'est tout l'objet de la refonte.
 *
 * **Ce qui a été retiré, et ce que ça coûtait.** La version précédente *jouait* le fichier
 * dans une balise `<video>` cachée et repeignait chaque image sur un `OffscreenCanvas` :
 * envoyer trois minutes de vidéo prenait trois minutes, à la seconde près, parce que le
 * lecteur cadençait tout. Le détour par canvas coûtait en plus un aller-retour
 * NV12 → RGBA → NV12 par image — plus cher que l'encodage lui-même, et destructeur pour le
 * sous-échantillonnage chroma.
 */

/**
 * pourquoi un échec de transcodage porte un motif et pas seulement un texte.
 *
 * « Ce navigateur ne sait pas encoder » et « ce navigateur ne sait pas **lire** ce
 * format » n'appellent pas la même conduite : le second se règle en changeant d'appareil
 * ou en exportant la vidéo autrement, le premier non. Mesuré : un `.mov`
 * d'iPhone en HEVC échouait sous la phrase « impossible de compresser », qui est fausse —
 * on n'a même pas pu la décoder.
 */
export type MotifEchec = "codec-source" | "encodeur" | "autre";

export class EchecTranscodage extends Error {
  constructor(readonly motif: MotifEchec, message: string) {
    super(message);
    this.name = "EchecTranscodage";
  }
}

/** Une image clé toutes les deux secondes : sans elles, aucun déplacement dans la vidéo. */
const INTERVALLE_CLE_US = 2 * TIMESCALE_US;

/**
 * Plafond des files de `WebCodecs`, en images.
 *
 * **Obligatoire depuis qu'il n'y a plus de lecteur.** Le lecteur cadençait le décodage à
 * la vitesse de lecture ; sans lui, le décodeur produit aussi vite que le fichier se lit
 * et l'encodeur ne suit pas — les `VideoFrame` s'empilent, et une image 1080p pèse environ
 * 3 Mo en mémoire GPU. Huit images, c'est de quoi ne jamais affamer l'encodeur sans jamais
 * laisser la file grossir.
 */
const FILE_MAX = 8;

/**
 * Dimensions cibles : on réduit à la hauteur demandée, jamais on n'agrandit, et les deux
 * côtés sont **pairs** — H.264 encode par macroblocs et refuse une dimension impaire.
 */
export function dimensionsCibles(largeur: number, hauteur: number, hauteurCible: number) {
  const facteur = Math.min(1, hauteurCible / hauteur);
  const pair = (valeur: number) => Math.max(2, Math.round(valeur * facteur / 2) * 2);
  return { largeur: pair(largeur), hauteur: pair(hauteur) };
}

/**
 * / D-04 — la première configuration supportée de l'échelle High → Main →
 * Baseline. Rien n'est supposé : chaque cran est soumis au navigateur.
 */
async function configuration(base: {
  width: number;
  height: number;
  bitrate?: number;
}): Promise<VideoEncoderConfig | undefined> {
  if (typeof VideoEncoder === "undefined") return undefined;
  for (const codec of CODECS_H264) {
    try {
      const { supported, config } = await VideoEncoder.isConfigSupported({
        ...base,
        codec,
        // `avc: { format: "avc" }` produit des NAL préfixées de leur longueur — la forme
        // qu'attend un MP4. Le défaut (`annexb`) donnerait un flux illisible en conteneur.
        avc: { format: "avc" },
        // D-04 — débit **variable** : un débit fixe gaspille sur une source statique et
        // sature sur du mouvement rapide.
        bitrateMode: "variable",
      });
      if (supported && config) return config;
    } catch {
      // Une configuration refusée par une exception plutôt que par `supported: false` est
      // un refus comme un autre : on passe au cran suivant.
    }
  }
  return undefined;
}

/** Le calibre du fichier de sortie, tel que l'événement doit le décrire. */
function calibre(largeur: number, hauteur: number, rotation: Rotation, dureeMs: number) {
  // `info.w`/`info.h` décrivent ce que l'utilisateur **verra**. Une rotation
  // d'un quart de tour échange les deux à l'écran sans toucher aux pixels codés.
  const pivote = rotation === 90 || rotation === 270;
  return { width: pivote ? hauteur : largeur, height: pivote ? largeur : hauteur, durationMs: dureeMs };
}

const enMp4 = (octets: Bytes): Blob => new Blob([octets as BlobPart], { type: "video/mp4" });

/**
 * **l'image de la vignette vient du décodeur, pas d'un lecteur.**
 *
 * Le poster était extrait en rejouant le fichier dans un `<video>` sur le thread
 * principal : le mécanisme le plus faible des trois disponibles, employé y compris sur les
 * deux chemins qui tiennent déjà un décodeur. Quand il échouait — et il échouait —, la
 * vidéo partait sans vignette. Ici, si on a su décoder pour réencoder, on sait donner une
 * image.
 *
 * Après le tout début, jamais la première frame : celle d'une vidéo de téléphone est très
 * souvent noire, et une vignette noire n'aide personne.
 */
const SEUIL_POSTER_US = 100_000;

/** Le poster en cours de constitution : une toile, et le fait qu'on tienne mieux que rien. */
interface Poster {
  toile: OffscreenCanvas;
  pinceau: OffscreenCanvasRenderingContext2D;
  fige: boolean;
  peint: boolean;
}

/**
 * la toile du poster porte l'orientation **affichée**, pas les pixels codés.
 *
 * Le `<video>` appliquait la matrice du `tkhd` pour nous ; un décodeur rend la frame
 * codée, matrice non appliquée. Sans cette rotation, la vignette d'une vidéo filmée en
 * portrait sortait couchée à côté d'une vidéo qui, elle, se lisait droite.
 *
 * Sens vérifié contre ffmpeg : la valeur rendue par `rotationDeMatrice` est
 * l'angle **horaire** à appliquer pour l'affichage — `270` reproduit exactement la frame
 * qu'`ffmpeg` sort avec sa rotation automatique. Le repère du canvas ayant l'axe Y vers le
 * bas, `rotate()` tourne déjà dans ce sens : l'angle passe tel quel.
 */
function ouvrirPoster(largeur: number, hauteur: number, rotation: Rotation): Poster | undefined {
  const pivote = rotation === 90 || rotation === 270;
  const toile = new OffscreenCanvas(pivote ? hauteur : largeur, pivote ? largeur : hauteur);
  const pinceau = toile.getContext("2d", { alpha: false });
  // Une vignette est un confort : son absence ne doit jamais coûter l'envoi.
  return pinceau ? { toile, pinceau, fige: false, peint: false } : undefined;
}

/** Peint une frame dans la toile du poster, redressée. Ne fait rien une fois figé. */
function peindrePoster(poster: Poster | undefined, image: VideoFrame, rotation: Rotation): void {
  if (!poster || poster.fige) return;

  const { toile, pinceau } = poster;
  const largeur = toile.width;
  const hauteur = toile.height;
  pinceau.save();
  pinceau.translate(largeur / 2, hauteur / 2);
  pinceau.rotate((rotation * Math.PI) / 180);
  // Les demi-dimensions sont celles de l'image **codée** : après rotation d'un quart de
  // tour, ce sont les côtés de la toile échangés.
  const pivote = rotation === 90 || rotation === 270;
  const codeeL = pivote ? hauteur : largeur;
  const codeeH = pivote ? largeur : hauteur;
  pinceau.drawImage(image, -codeeL / 2, -codeeH / 2, codeeL, codeeH);
  pinceau.restore();

  poster.peint = true;
  // La première frame sert de repli ; la première passé le seuil arrête tout.
  if (image.timestamp >= SEUIL_POSTER_US) poster.fige = true;
}

const rendrePoster = async (poster: Poster | undefined): Promise<Blob | undefined> =>
  poster?.peint ? poster.toile.convertToBlob({ type: "image/jpeg", quality: 0.7 }) : undefined;

/** Laisse les files se vider avant d'en remettre : le seul garde-fou mémoire du chemin. */
async function attendre(pleine: () => boolean): Promise<void> {
  while (pleine()) await new Promise((suite) => setTimeout(suite, 1));
}

/**
 * **une image clé, décodée seule, pour le chemin rapide.**
 *
 * Le remuxage ne décode rien : c'est tout son intérêt, et c'est pourquoi il n'avait
 * aucune image à offrir à la vignette. Décoder la **première clé** coûte une frame, pas un
 * fichier — sans commune mesure avec le réencodage qu'on vient justement d'éviter.
 *
 * Rend `undefined` sur le moindre accroc : la vignette est un confort, et `remuxer` doit
 * rendre sa vidéo quoi qu'il arrive.
 */
async function posterDUneCle(source: SourceVideo): Promise<Blob | undefined> {
  const premiere = source.echantillons.find((echantillon) => echantillon.cle);
  if (!premiere || typeof VideoDecoder === "undefined") return undefined;

  const poster = ouvrirPoster(source.largeur, source.hauteur, source.rotation);
  if (!poster) return undefined;

  const decodeur = new VideoDecoder({
    output: (image) => {
      // Une seule image attendue ; `fige` garantit qu'une seconde ne l'écraserait pas.
      peindrePoster(poster, image, source.rotation);
      poster.fige = true;
      image.close();
    },
    error: () => {},
  });

  try {
    decodeur.configure({
      codec: source.codec,
      description: source.description as BufferSource,
      codedWidth: source.largeur,
      codedHeight: source.hauteur,
    });
    decodeur.decode(
      new EncodedVideoChunk({
        type: "key",
        timestamp: premiere.timestampUs,
        data: premiere.donnees as BufferSource,
      }),
    );
    await decodeur.flush();
  } catch {
    return undefined;
  } finally {
    if (decodeur.state !== "closed") decodeur.close();
  }

  return rendrePoster(poster);
}

/**
 * / E-18 — **le chemin rapide** : une source déjà conforme change de
 * conteneur, pas de pixels. Zéro attente, zéro génération de perte.
 */
async function remuxer(source: SourceVideo): Promise<Sortie> {
  return {
    // une seule image clé décodée, pour la vignette et rien d'autre. Le
    // chemin rapide ne décode rien par construction ; c'est justement pourquoi il n'avait
    // aucune image à donner, et pourquoi la vignette retombait sur un lecteur.
    poster: await posterDUneCle(source),
    blob: enMp4(
      ecrireMp4({
        largeur: source.largeur,
        hauteur: source.hauteur,
        description: source.description,
        echantillons: source.echantillons,
        rotation: source.rotation,
        // la piste sonore suit **sans être touchée**, ce qui est tout
        // l'intérêt : sur ce chemin, rien n'est réencodé, ni l'image ni le son.
        audio: source.audio,
      }),
    ),
    ...calibre(source.largeur, source.hauteur, source.rotation, source.dureeMs),
    sansSon: source.audioAbandonne,
  };
}

/** Le format des octets encodés que `WebCodecs` rend, recopiés pour le muxeur. */
function echantillonDe(morceau: EncodedVideoChunk): EchantillonVideo {
  const donnees = new Uint8Array(morceau.byteLength) as Bytes;
  morceau.copyTo(donnees);
  return { donnees, timestampUs: morceau.timestamp, cle: morceau.type === "key" };
}

/**
 * démuxeur → décodeur → encodeur → muxeur, sans lecteur et sans canvas.
 *
 * Lève quand ce navigateur ne sait pas encoder : c'est le message d'échec dédié de l'UI
 * qui prend le relais, jamais un fichier approximatif.
 */
type Sortie = Raster & { durationMs: number; sansSon: boolean; poster?: Blob };

export async function transcoderVideo(blob: Blob, cibles: VideoTargets): Promise<Sortie> {
  const source = await lireMp4(new Uint8Array(await blob.arrayBuffer()) as Bytes);

  if (remuxable(source, cibles)) return await remuxer(source);

  const { largeur, hauteur } = dimensionsCibles(source.largeur, source.hauteur, cibles.height);

  /*
   * **Le codec de la source se mesure avant tout le reste**, et c'est ce qui manquait :
   * on ne vérifiait que l'encodeur. L'ancien chemin passait par une balise `<video>`, qui
   * décode ce que la plateforme sait décoder ; `VideoDecoder` est plus étroit — Firefox
   * n'a pas de HEVC du tout, et un `.mov` d'iPhone échouait donc sous une phrase qui
   * parlait de compression alors que rien n'avait pu être lu.
   */
  const configSource: VideoDecoderConfig = {
    codec: source.codec,
    description: source.description as BufferSource,
    codedWidth: source.largeur,
    codedHeight: source.hauteur,
  };
  const lisible =
    typeof VideoDecoder !== "undefined" &&
    (await VideoDecoder.isConfigSupported(configSource).catch(() => ({ supported: false })))
      .supported === true;
  if (!lisible) {
    throw new EchecTranscodage(
      "codec-source",
      `format vidéo non décodable par ce navigateur : ${source.codec}`,
    );
  }

  const config = await configuration({ width: largeur, height: hauteur, bitrate: cibles.bitrate });
  if (!config) {
    throw new EchecTranscodage("encodeur", "cet appareil ne sait pas encoder de vidéo");
  }

  const echantillons: EchantillonVideo[] = [];
  let description: Bytes | undefined;
  let erreur: Error | undefined;

  const encodeur = new VideoEncoder({
    output: (morceau, metadonnees) => {
      // La description n'arrive qu'avec le premier morceau, et une seule fois : sans
      // elle, `ecrireMp4` refuse — un MP4 sans paramètres de codec ne décode pas.
      const brute = metadonnees?.decoderConfig?.description;
      if (brute && !description) {
        const vue = ArrayBuffer.isView(brute)
          ? new Uint8Array(brute.buffer as ArrayBuffer, brute.byteOffset, brute.byteLength)
          : new Uint8Array(brute as ArrayBuffer);
        // Une **copie**, jamais une vue : `WebCodecs` réutilise ses tampons, et garder une
        // vue rendrait la description silencieusement fausse au morceau suivant.
        description = new Uint8Array(vue) as Bytes;
      }
      echantillons.push(echantillonDe(morceau));
    },
    error: (cause) => {
      // L'erreur ne cite jamais le média : seulement qu'il y en a eu une.
      erreur ??= new Error(`encodage vidéo interrompu : ${cause.name}`);
    },
  });
  encodeur.configure(config);

  /**
   * La toile de réduction, **allouée une fois** : une par image ferait autant de contextes
   * GPU que d'images. `alpha: false` évite une passe de composition sur chaque frame, et
   * `willReadFrequently` reste absent — on ne relit jamais les pixels côté CPU.
   *
   * ponytail: aller-retour RGBA par image redimensionnée, plafond connu. À remplacer le
   * jour où WebCodecs expose une vraie mise à l'échelle — aucune n'existe aujourd'hui.
   */
  const toile = new OffscreenCanvas(largeur, hauteur);
  const pinceau = toile.getContext("2d", { alpha: false });
  if (!pinceau) throw new EchecTranscodage("autre", "contexte 2d indisponible : réduction impossible");

  /*
   * **la vignette sort d'ici, et elle ne coûte rien.** Ce chemin décode déjà
   * chaque image ; les jeter toutes puis rouvrir le fichier dans un `<video>` pour en
   * redemander une était le detour qui laissait les vidéos sans vignette quand ce lecteur
   * refusait le fichier. Deux dessins au plus : la première image comme repli, la première
   * passé 0,1 s comme définitive.
   */
  const poster = ouvrirPoster(source.largeur, source.hauteur, source.rotation);

  let derniereCleUs = -INTERVALLE_CLE_US;
  const decodeur = new VideoDecoder({
    output: (image) => {
      const cle = image.timestamp - derniereCleUs >= INTERVALLE_CLE_US;
      if (cle) derniereCleUs = image.timestamp;

      peindrePoster(poster, image, source.rotation);

      if (largeur === source.largeur && hauteur === source.hauteur) {
        encodeur.encode(image, { keyFrame: cle });
        image.close();
        return;
      }

      /*
       * **La réduction se fait ici, explicitement, et c'est le correctif.**
       *
       * La version précédente construisait `new VideoFrame(image, { displayWidth,
       * displayHeight })` en la nommant « scaler natif ». Il n'en existe pas :
       * `displayWidth`/`displayHeight` sont des **métadonnées d'affichage**, elles ne
       * rééchantillonnent rien — la frame sortait toujours en 1920 × 1080 codés. On
       * remettait donc à un encodeur configuré en 1280 × 720 des images d'une autre
       * taille, et ce que la spécification WebCodecs dit de ce cas est : rien. Chrome
       * redimensionne en silence, d'autres moteurs refusent la frame — et l'échec arrive
       * dans le rappel `error`, après le premier `encode`, sous la forme d'une phrase qui
       * parle de compression. C'était exactement le symptôme sur `.mp4` en 1080p.
       *
       * Un canvas coûte un aller-retour par image ; il a le mérite décisif de produire la
       * taille demandée partout, et le chemin sans réduction (juste au-dessus) ne le paie
       * jamais.
       *
       * `close()` sur les deux, et sans faute : les `VideoFrame` tiennent de la mémoire
       * GPU que le ramasse-miettes ne libère pas à temps — une seule oubliée par image
       * suffit à faire tomber l'onglet sur une vidéo un peu longue.
       */
      const horodatage = image.timestamp;
      const duree = image.duration ?? undefined;
      pinceau.drawImage(image, 0, 0, largeur, hauteur);
      image.close();
      const reduite = new VideoFrame(toile, { timestamp: horodatage, duration: duree });
      encodeur.encode(reduite, { keyFrame: cle });
      reduite.close();
    },
    error: (cause) => {
      // Le message de WebCodecs ne cite pas le média : il dit pourquoi le décodeur a lâché.
      erreur ??= new Error(`décodage vidéo interrompu : ${cause.name} (${cause.message})`);
    },
  });
  decodeur.configure(configSource);

  /*
   * **Le décodeur exige une image clé en premier.** Une image qui la précède ne peut de
   * toute façon pas se décoder : elle est laissée, plutôt que de faire tomber le décodeur
   * — qui ne répond plus ensuite que « not configured » à chaque image.
   */
  const premiereCle = source.echantillons.findIndex((echantillon) => echantillon.cle);
  if (premiereCle < 0) {
    throw new EchecTranscodage("codec-source", "aucune image clé dans la vidéo : décodage impossible");
  }

  try {
    for (const echantillon of source.echantillons.slice(premiereCle)) {
      if (erreur) throw erreur;
      // Contrôle de flux : sans lecteur pour cadencer, c'est la seule chose qui empêche
      // le décodeur de prendre toute la mémoire disponible.
      await attendre(() => encodeur.encodeQueueSize > FILE_MAX || decodeur.decodeQueueSize > FILE_MAX);
      try {
        decodeur.decode(
          new EncodedVideoChunk({
            type: echantillon.cle ? "key" : "delta",
            timestamp: echantillon.timestampUs,
            data: echantillon.donnees as BufferSource,
          }),
        );
      } catch (cause) {
        /*
         * La vraie raison arrive par le rappel `error`, une tâche plus tard ; ce qui lève
         * ici n'en est que la conséquence (« VideoDecoder is not configured »). On lui
         * laisse le temps d'arriver, et c'est elle qu'on remonte.
         */
        await new Promise((resoudre) => setTimeout(resoudre, 0));
        throw erreur ?? cause;
      }
    }

    await decodeur.flush();
    await encodeur.flush();
  } finally {
    if (decodeur.state !== "closed") decodeur.close();
    if (encodeur.state !== "closed") encodeur.close();
  }

  if (erreur) throw erreur;
  if (!description) throw new Error("aucun paramètre de codec produit : transcodage abandonné");

  return {
    poster: await rendrePoster(poster),
    blob: enMp4(
      ecrireMp4({
        largeur,
        hauteur,
        description,
        echantillons,
        rotation: source.rotation,
        // Le son n'est **jamais** réencodé, même quand l'image l'est : une piste AAC-LC
        // est déjà au format de sortie, et la repasser dans un encodeur ne ferait que lui
        // coûter une génération.
        audio: source.audio,
      }),
    ),
    ...calibre(largeur, hauteur, source.rotation, source.dureeMs),
    sansSon: source.audioAbandonne,
  };
}
