import type { Bytes } from "./attachments";
import { ecrireOggOpus } from "./ogg";
import { lireWebmOpus } from "./webm";

/** Le conteneur que Chrome et Edge produisent pour un vocal. */
export const WEBM_OPUS_MIME = "audio/webm";

/**
 * chemin Chrome/Edge — **remuxage**, pas transcodage.
 *
 * Le flux Opus produit par `MediaRecorder` est déjà celui qu'on veut envoyer : seul son
 * conteneur diffère. On change l'emballage, on ne touche pas à un échantillon — aucune
 * perte de qualité, aucun encodeur, et le coût est celui d'une recopie d'octets.
 *
 * Lève si le WebM ne porte pas d'`OpusHead` : sans lui, le nombre de canaux et le délai de
 * préchargement sont inconnus, et un flux Ogg construit sur des valeurs devinées se lit de
 * travers plutôt que pas du tout — le pire des deux.
 */
/**
 * **Un enregistrement qui ne porte aucun son.** Nommée, et pas une `Error` nue, parce que
 * l'UI doit pouvoir la distinguer d'une panne d'envoi : ce n'est pas le réseau qui a
 * échoué, c'est le micro qui n'a rien donné.
 *
 * Observé en conditions réelles sur iPhone : pendant un appel
 * téléphonique, iOS garde la session audio. `getUserMedia` réussit, `MediaRecorder`
 * démarre, le chronomètre tourne — et le conteneur rendu ne contient pas un paquet.
 * L'utilisateur voyait « L'envoi de cette pièce jointe a échoué », qui l'envoyait
 * chercher un problème de réseau alors que la cause était à vingt centimètres. Mesuré
 * aux journaux du proxy : pendant l'appel, **aucun téléversement ne part** ; après avoir
 * raccroché, le premier essai passe, sans rien recharger.
 */
export class EnregistrementSansSon extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "EnregistrementSansSon";
  }
}

export function remuxWebmOpusVersOgg(webm: Bytes): Bytes {
  const { opusHead, paquets } = lireWebmOpus(webm);

  // `length` et non l'existence : un `CodecPrivate` **vide** est un en-tête absent, et le
  // laisser passer produirait un Ogg dont la première page ne décrit rien — illisible
  // partout, sans que rien n'ait échoué. Le test l'a trouvé.
  //
  // Les deux cas portent la **même** classe : du point de vue de qui vient de parler,
  // « pas d'en-tête » et « pas un paquet » disent la même chose — il n'y a rien à
  // envoyer. Le détail, lui, reste distinct pour qui lit une pile d'appels.
  if (!opusHead?.length) throw new EnregistrementSansSon("WebM sans OpusHead : remuxage impossible");
  if (paquets.length === 0) throw new EnregistrementSansSon("WebM sans paquet audio : rien à remuxer");

  return ecrireOggOpus(paquets, opusHead);
}
