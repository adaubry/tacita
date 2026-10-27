/**
 * **Le format dans lequel cet appareil-ci enregistrera un message vocal.**
 *
 * Rien n'est codé en dur pour une plateforme : on demande au navigateur ce qu'il sait
 * faire, dans l'ordre de ce qui coûte le moins cher en aval, et on prend le premier qui
 * répond. C'est la seule façon de couvrir un parc qu'on ne connaît pas — et la seule
 * compatible avec un produit qui s'interdit la télémétrie : l'appareil se décrit lui-même,
 * au moment où on en a besoin, et rien n'est rapporté à personne.
 */

/**
 * Les formats demandés, du moins cher au plus coûteux pour le pipeline.
 *
 * 1. **Ogg/Opus** — Firefox. `versFormatVocal` le laisse passer tel quel.
 * 2. **WebM/Opus** — Chrome, Android, et iOS depuis 18.4. Un remuxage d'octets, sans
 *    ré-encodage ni perte.
 * 3. **MP4** — Safari d'avant 18.4, qui y met de l'AAC. Transcodé si un encodeur existe,
 *    envoyé tel quel sinon.
 *
 * **`audio/mp4;codecs=opus` est délibérément absent**, alors que des appareils
 * l'acceptent — un iPhone en 18.7 répond `true`. Le fichier produit s'annoncerait
 * `audio/mp4` tout en contenant de l'Opus, que beaucoup de lecteurs ne décodent pas dans
 * ce conteneur : le repli « lisible partout » reposerait alors sur une étiquette fausse,
 * et le destinataire recevrait un message muet. Le demander serait prendre un format que
 * l'émetteur sait écrire pour un format que le destinataire sait lire, ce qui n'est pas la
 * même question.
 */
export const FORMATS_VOCAUX = [
  "audio/ogg;codecs=opus",
  "audio/webm;codecs=opus",
  "audio/mp4",
] as const;

/**
 * Le premier format de la liste que l'appareil accepte, ou `undefined` s'il n'en accepte
 * aucun — auquel cas **le bouton micro ne doit pas exister**. Un micro inerte est une
 * fonction affichée qui ne marche pas ; l'absence se comprend, un échec au moment d'envoyer
 * ne se pardonne pas.
 *
 * Le prédicat est injecté plutôt que lu globalement : c'est ce qui rend la cascade
 * éprouvable sans navigateur, et il n'y a rien d'autre à tester ici que l'ordre.
 */
export function formatVocal(supporte: (type: string) => boolean): string | undefined {
  return FORMATS_VOCAUX.find((type) => {
    try {
      return supporte(type);
    } catch {
      // Safari a déjà levé sur un type qu'il ne connaît pas au lieu de rendre `false`.
      return false;
    }
  });
}

/**
 * Ce que l'appareil offre réellement, lu au moment du rendu.
 *
 * `MediaRecorder` **et** `getUserMedia` : les deux manquent indépendamment l'un de
 * l'autre — un contexte non sécurisé retire le second en laissant le premier.
 */
export function vocalDisponible(portee: typeof globalThis = globalThis): string | undefined {
  const enregistreur = (portee as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!enregistreur?.isTypeSupported) return undefined;
  if (!portee.navigator?.mediaDevices?.getUserMedia) return undefined;
  return formatVocal((type) => enregistreur.isTypeSupported(type));
}

/**
 * **Le type réellement produit, pas celui qu'on a demandé.**
 *
 * `MediaRecorder` a le droit de rendre autre chose que le `mimeType` demandé, et Safari
 * l'a déjà fait. Tout le pipeline s'aiguille sur le type du fichier : le lui mentir
 * enverrait un AAC dans le chemin du remuxage WebM, qui échouerait sur des octets qu'il ne
 * reconnaît pas. On lit donc le blob, et on ne retombe sur le format demandé que si le
 * navigateur n'a rien déclaré du tout.
 */
export function fichierVocal(morceaux: Blob[], demande: string, horodatage: number): File {
  const type = morceaux[0]?.type || demande;
  // L'extension suit le conteneur réel : c'est ce que verra qui sauvegarde le fichier.
  const extension = type.startsWith("audio/ogg")
    ? "ogg"
    : type.startsWith("audio/webm")
      ? "webm"
      : "m4a";
  return new File(morceaux, `vocal-${horodatage}.${extension}`, { type });
}
