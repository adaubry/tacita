/**
 * Démuxage : d'un conteneur vidéo vers les échantillons encodés qu'il transporte.
 *
 * L'entrée du chemin de transcodage — `mp4.ts` en est la sortie. Rend les
 * échantillons et ce qu'il faut pour les redécrire : codec, dimensions, rotation.
 */
import {
  createFile,
  DataStream,
  Endianness,
  MP4BoxBuffer,
  type ISOFile,
  type Matrix,
  type Sample,
} from "mp4box";

import type { Bytes } from "./attachments";
import type { EchantillonVideo, PisteAudio, Rotation } from "./mp4";

/**
 * / E-17 — **le démuxage d'un fichier entrant, par bibliothèque.**
 *
 * `mp4box@2.4.1`, digest dans le lockfile
 * (`sha512-0HGX7nXoDIX6FKLVl4a3wtYjBlwqsN3xuQC3GXzNtKp98FXUOhDSq623azsz8DG5ptd9ZXcXodDkgbdMZOjWvw==`).
 * Version épinglée sans accent circonflexe, CHANGELOG relu avant tout bump — le régime de
 * `CLAUDE.md` § Prudence outillage, règle 5, celui d'Astryx.
 *
 * **Pourquoi une dépendance ici et nulle part ailleurs.** Ce que nous écrivons — un
 * conteneur, avec nos propres échantillons — est borné et connu. Ce que nous *lisons*
 * vient de toutes les caméras du marché : listes d'édition, pistes multiples, `moov`
 * fragmenté, rotation dans le `tkhd`, `.mov` HEVC d'iPhone. Un démuxeur maison sur cette
 * surface est un puits à défauts d'interop, et aucun test de ce dépôt ne les verrait.
 *
 * **Elle ne touche pas WebCodecs**, et c'est la condition qui la rendait admissible :
 * octets → structures, exécutable dans Node, donc testable sans navigateur. E-10 reste
 * intacte — l'encodage vit toujours dans le shard. *(Mesuré : `mp4-muxer`,
 * l'autre candidat, commence `addVideoChunk` par `sample instanceof EncodedVideoChunk` et
 * lève un `ReferenceError` dans Node. Le faire passer aurait demandé de définir nous-mêmes
 * la classe que le test vérifie — la règle 3, à la lettre.)*
 */

/** Ce qu'on lit d'une source, et rien de plus : de quoi remuxer, réencoder ou refuser. */
export interface SourceVideo {
  /** Chaîne `avc1.xxxxxx` ou autre, telle que la piste la déclare. */
  codec: string;
  /** Dimensions **codées**, avant application de la matrice. */
  largeur: number;
  hauteur: number;
  /** la rotation lue dans la matrice du `tkhd`, jamais devinée. */
  rotation: Rotation;
  dureeMs: number;
  /** Débit moyen réel, calculé sur les échantillons — pas celui que le conteneur annonce. */
  debitBps: number;
  /** `avcC`, tel quel : le muxeur le recopie sans le lire. */
  description: Bytes;
  /** Dans l'ordre de décodage, horodatés en microsecondes de présentation. */
  echantillons: EchantillonVideo[];
  /** Nombre total de pistes de la source, vidéo comprise. */
  pistes: number;
  /**
   * la piste audio **transportable**, quand il y en a une.
   *
   * Absente quand la source n'a pas de son, ou quand son codec n'est pas de l'AAC : ce
   * muxeur recopie une piste, il n'en convertit aucune. Le second cas est signalé par
   * `audioAbandonne`, parce que « pas de son » et « du son qu'on n'a pas su emporter » ne
   * demandent pas la même phrase à l'écran.
   */
  audio?: PisteAudio;
  /** La source avait du son, et il ne part pas : l'UI doit le dire. */
  audioAbandonne: boolean;
}

const signe = (valeur: number): number => (valeur > 0x7fffffff ? valeur - 0x100000000 : valeur);

/**
 * l'angle que dit la matrice, ou `0` si elle ne dit rien de reconnaissable.
 *
 * Seuls `a` et `b` sont lus : les quatre orientations qu'une caméra écrit s'y distinguent
 * déjà, et une matrice arbitraire — mise à l'échelle, cisaillement — n'est pas une
 * rotation. Rendre `0` sur ce qu'on ne reconnaît pas est le bon défaut : l'image sort
 * comme elle est codée, jamais tournée au hasard.
 */
export function rotationDeMatrice(matrice: Matrix | undefined): Rotation {
  if (!matrice || matrice.length < 5) return 0;
  const a = signe(matrice[0] ?? 0);
  const b = signe(matrice[1] ?? 0);
  const unite = 0x10000;
  if (a === unite && b === 0) return 0;
  if (a === 0 && b === unite) return 90;
  if (a === -unite && b === 0) return 180;
  if (a === 0 && b === -unite) return 270;
  return 0;
}

/**
 * La boîte de configuration d'une piste, écrite telle quelle par mp4box — ou `undefined`
 * quand la piste n'en porte aucune des formes demandées.
 *
 * **`undefined` et non une exception, et c'est le correctif.** Une piste
 * audio sans `esds` — du PCM `sowt`, ce qu'écrivent les enregistrements d'écran et les
 * vieux iPhone — faisait lever ici, et l'exception emportait **toute la vidéo** : le
 * fichier ne partait pas, alors que sa piste image était parfaitement lisible. Le manque
 * d'une piste facultative est une information, pas une panne ; c'est l'appelant qui sait
 * laquelle des deux il tient.
 */
/**
 * **Une image IDR dans un échantillon H.264 au format AVCC** : la seule image clé que le
 * flux atteste lui-même, sans croire le conteneur.
 *
 * Le conteneur le dit d'ordinaire (`stss`, ou les drapeaux des fragments). Mais
 * l'enregistrement de Safari est un MP4 **fragmenté**, et la première image d'un film
 * d'iPhone y arrivait non marquée : le décodeur, qui exige une image clé en premier,
 * tombait, et le film partait non réduit (« VideoDecoder is not configured », mesuré sur
 * iPhone). Une NAL de type 5 ne ment pas.
 *
 * Chaque NAL est précédée de sa longueur, sur `tailleLongueur` octets (lue dans `avcC`).
 * Un échantillon qui ne se découpe pas proprement rend `false` : on ne devine rien.
 */
export function contientIdr(donnees: Uint8Array, tailleLongueur: number): boolean {
  let position = 0;
  while (position + tailleLongueur < donnees.length) {
    let longueur = 0;
    for (let rang = 0; rang < tailleLongueur; rang++) longueur = longueur * 256 + donnees[position + rang]!;
    position += tailleLongueur;
    if (longueur === 0 || position + longueur > donnees.length) return false;
    if ((donnees[position]! & 0x1f) === 5) return true;
    position += longueur;
  }
  return false;
}

function boiteDe(
  fichier: ISOFile,
  pisteId: number,
  noms: string[],
  entete: boolean,
): Bytes | undefined {
  const piste = fichier.getTrackById(pisteId);
  /*
   * La boîte de configuration porte un nom par codec — `avcC`, `hvcC`, `vpcC`, `av1C` —
   * et les types de mp4box décrivent l'entrée de description par sa forme commune, sans
   * ces champs. Le cast est **local et nommé**, pas un `any` sur toute la fonction : on
   * cherche exactement une boîte sachant s'écrire dans un flux, et rien d'autre.
   */
  type Configuration = { write(flux: DataStream): void };
  type Entree = Record<string, Configuration | undefined>;
  const entrees = (piste?.mdia?.minf?.stbl?.stsd?.entries ?? []) as unknown as Entree[];

  for (const entree of entrees) {
    /*
     * **QuickTime range `esds` un étage plus bas, dans un atome `wave`.** C'est la forme
     * qu'écrit tout `.mov` — donc toute vidéo d'iPhone —, et ne chercher qu'à la racine
     * de l'entrée `mp4a` ne la trouvait jamais. Le MP4 « pur » (Android, caméras, export
     * ffmpeg) la pose à la racine : les deux endroits existent, on regarde les deux.
     */
    const wave = entree.wave as unknown as Entree | undefined;
    const config = noms.map((nom) => entree[nom] ?? wave?.[nom]).find(Boolean);
    if (!config) continue;
    const flux = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
    config.write(flux);
    // La vidéo veut le **contenu** de `avcC` (le muxeur réécrit la boîte) ; l'audio veut
    // la boîte `esds` **entière**, en-tête compris, parce qu'elle est recopiée telle quelle.
    return new Uint8Array(entete ? flux.buffer : flux.buffer.slice(8)) as Bytes;
  }
  return undefined;
}

/**
 * Les pistes sonores de la source, **lues au `hdlr`** et non au classement de mp4box.
 *
 * mp4box range une piste par le codec qu'il reconnaît : une piste `sowt` — du PCM, ce
 * qu'écrivent les enregistrements d'écran et les vieux `.mov` — atterrit dans
 * `otherTracks`, avec le type « metadata ». Elle disparaissait donc deux fois : le son
 * partait sans que personne ne le dise (interdit n°13), et le chemin rapide la comptait
 * pour une piste de timecode, donc remuxait en la perdant.
 *
 * Le `hdlr` est le seul endroit du format qui dise « ceci est du son », indépendamment du
 * codec. C'est lui qu'on lit.
 */
function pistesSonores(fichier: ISOFile, info: { tracks?: { id: number }[] }): number[] {
  return (info.tracks ?? [])
    .filter((piste) => {
      const hdlr = fichier.getTrackById(piste.id)?.mdia?.hdlr as { handler?: string } | undefined;
      return hdlr?.handler === "soun";
    })
    .map((piste) => piste.id);
}

/**
 * lit la **première piste vidéo** d'un MP4/MOV et rend ce qu'il faut pour
 * décider : remuxer, réencoder, ou refuser.
 *
 * Une seule piste vidéo est lue, et c'est assumé : le pipeline en produit une, et
 * une source multi-angles n'a pas de sens dans une messagerie. `pistes` et `audio`
 * remontent quand même, parce que ce sont eux qui disent au prédicat du chemin rapide que
 * la source n'est pas ordinaire.
 */
export async function lireMp4(octets: Bytes): Promise<SourceVideo> {
  const fichier = createFile();

  const source = await new Promise<SourceVideo>((resolve, reject) => {
    fichier.onError = (erreur: string) => reject(new Error(`démuxage impossible : ${erreur}`));

    fichier.onReady = (info) => {
      const piste = info.videoTracks?.[0];
      if (!piste) {
        reject(new Error("aucune piste vidéo : source illisible"));
        return;
      }

      /*
       * **la description du codec vidéo est la seule qui soit obligatoire.**
       * Sans elle rien ne se décode ni ne se remuxe ; on refuse ici, avec le mot juste.
       */
      const description = boiteDe(fichier, piste.id, ["avcC", "hvcC", "vpcC", "av1C"], false);
      if (!description) {
        reject(new Error("piste vidéo sans description de codec : source illisible"));
        return;
      }

      /*
       * la piste audio n'est reprise que si elle est **de l'AAC** et qu'elle
       * porte son `esds` : le muxeur recopie une piste, il n'en convertit aucune (voir
       * `SourceVideo.audio`). Le PCM d'un `.mov` d'enregistrement d'écran, ou une piste
       * dont la description manque, tombent tous deux du même côté — la vidéo part muette
       * et l'UI le dit, au lieu de ne pas partir du tout.
       */
      const sonores = pistesSonores(fichier, info);
      const pisteAudio = info.audioTracks?.find((candidate) => sonores.includes(candidate.id));
      const esds =
        pisteAudio?.codec.startsWith("mp4a") === true
          ? boiteDe(fichier, pisteAudio.id, ["esds"], true)
          : undefined;
      const audioReprise = esds !== undefined;

      const echantillons: EchantillonVideo[] = [];
      const echantillonsAudio: PisteAudio["echantillons"] = [];
      // H.264 seulement : c'est le seul flux dont on sait lire le type d'image. La taille
      // du préfixe de longueur est dans `avcC` (`lengthSizeMinusOne`, 5ᵉ octet).
      const avc = piste.codec.startsWith("avc1") || piste.codec.startsWith("avc3");
      const tailleLongueur = ((description[4] ?? 3) & 0x03) + 1;
      fichier.onSamples = (id, _user, lot: Sample[]) => {
        for (const brut of lot) {
          if (!brut.data) continue;
          if (id === piste.id) {
            const donnees = new Uint8Array(brut.data) as Bytes;
            echantillons.push({
              donnees,
              // `cts` est la date de **présentation** : c'est ce que le muxeur attend, et
              // ce dont il redérive l'ordre de décodage.
              timestampUs: Math.round((brut.cts / brut.timescale) * 1_000_000),
              // Le conteneur, **ou** le flux quand il atteste une IDR que le conteneur n'a
              // pas marquée. Jamais l'inverse : un drapeau n'est pas retiré sur une lecture.
              cle: brut.is_sync || (avc && contientIdr(donnees, tailleLongueur)),
            });
          } else {
            // La durée **déclarée**, dans l'échelle de la source : la recalculer
            // introduirait la dérive que conserver l'échelle supprime.
            echantillonsAudio.push({ donnees: new Uint8Array(brut.data) as Bytes, duree: brut.duration });
          }
        }
      };

      fichier.setExtractionOptions(piste.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
      if (pisteAudio && audioReprise) {
        fichier.setExtractionOptions(pisteAudio.id, null, { nbSamples: Number.MAX_SAFE_INTEGER });
      }
      fichier.start();
      fichier.flush();

      const dureeMs = Math.round((info.duration / info.timescale) * 1000);
      const octetsUtiles = echantillons.reduce((somme, e) => somme + e.donnees.length, 0);

      resolve({
        codec: piste.codec,
        /*
         * **Les dimensions codées, pas celles du `tkhd`.** C'est l'entrée `stsd` qui dit
         * ce que le flux contient réellement, et c'est cela que `VideoDecoder` exige dans
         * `codedWidth`/`codedHeight` : le `tkhd` porte la taille d'**affichage**, qui en
         * diffère dès qu'un `pasp` décrit des pixels non carrés. Configurer le décodeur
         * sur la seconde, c'est le configurer sur une taille que le flux n'a pas.
         */
        largeur: piste.video?.width || piste.track_width || 0,
        hauteur: piste.video?.height || piste.track_height || 0,
        rotation: rotationDeMatrice(piste.matrix),
        dureeMs,
        // Le débit **mesuré**, pas celui que le conteneur annonce : un champ d'en-tête se
        // recopie d'un transcodage à l'autre et ne décrit plus rien.
        debitBps: dureeMs > 0 ? Math.round((octetsUtiles * 8) / (dureeMs / 1000)) : 0,
        description,
        echantillons,
        /*
         * **Les pistes qui portent du signal, pas toutes les pistes.** Un iPhone écrit
         * systématiquement une piste de métadonnées (`mebx`) à côté de l'image et du son :
         * comptée, elle poussait `pistes` à trois et faisait échouer le prédicat du chemin
         * rapide sur **toutes** les vidéos d'iPhone, qui se réencodaient donc sans raison.
         * Ce que le prédicat veut savoir est « y a-t-il plus d'une image ou plus d'un
         * son ? » — une piste de timecode ne se perd pas, elle ne contient rien à perdre.
         */
        pistes: (info.videoTracks?.length ?? 1) + sonores.length,
        audio:
          pisteAudio && esds && echantillonsAudio.length > 0
            ? {
                esds,
                timescale: pisteAudio.timescale,
                frequence: pisteAudio.audio?.sample_rate ?? pisteAudio.timescale,
                canaux: pisteAudio.audio?.channel_count ?? 2,
                echantillons: echantillonsAudio,
              }
            : undefined,
        // « il y avait du son et il ne part pas », quel qu'ait été son codec :
        // c'est le `hdlr` qui l'atteste, pas le fait que mp4box ait su nommer le codec.
        audioAbandonne: sonores.length > 0 && !audioReprise,
      });
    };

    // `fileStart` situe le tampon dans le fichier : ici tout tient en mémoire, donc un
    // seul tampon à l'offset zéro.
    fichier.appendBuffer(
      MP4BoxBuffer.fromArrayBuffer(
        octets.buffer.slice(octets.byteOffset, octets.byteOffset + octets.byteLength),
        0,
      ),
    );
    fichier.flush();
  });

  if (source.echantillons.length === 0) throw new Error("piste vidéo sans échantillon : source illisible");
  return source;
}
