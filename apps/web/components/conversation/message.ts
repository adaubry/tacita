import { ROOM_MENTION, EVERYONE } from "@tacita/messaging";
import type { OutboxEntry, OutboxStatus } from "@tacita/outbox";

import { memeJour } from "../../lib/dates";
import type { Media } from "../media/media";

/**
 * Un message tel que la timeline le rend — venu du flux `/sync` **ou** de la file
 * d'envoi. Les deux origines se rendent pareil : c'est tout l'intérêt de
 * l'envoi optimiste, l'utilisateur voit son message avant que le serveur le confirme.
 */
export interface MessageAffiche {
  /** `event_id` s'il existe, `txnId` sinon. Jamais les deux. */
  cle: string;
  auteur: string;
  /** Nom d'affichage, ou l'identifiant à défaut. */
  nom: string;
  /**
   * `mxc://` de la photo de l'auteur, telle que son appartenance au salon la porte.
   * Absente = les initiales, qui sont toujours vraies (`ConversationAvatar`).
   */
  avatar?: string;
  texte: string;
  horodatage: number;
  /** Absent = le message est dans la timeline ; présent = encore dans la file. */
  envoi?: OutboxStatus;
  /** `errcode` de la dernière tentative. `NOT_ENCRYPTED` ne se réessaie pas. */
  errcode?: string;
  /** `undefined` tant que le serveur n'a pas attribué d'identifiant. */
  eventId?: string;
  moi: boolean;
  /** droits exposés par le paquet, jamais dérivés ici. */
  modifiable?: boolean;
  supprimable?: boolean;
  /** la pièce jointe, quand le message en porte une (M-E). */
  media?: Media;
  /** le message cité, quand celui-ci est une réponse. */
  repondA?: Citation;
}

/** Ce qu'on montre du message auquel on répond : qui, et quoi en une ligne. */
export interface Citation {
  /** Absent quand le message cité n'est pas dans la fenêtre chargée. */
  nom?: string;
  extrait: string;
}

/** Une entrée de file, rendue comme un message. Le contenu n'est jamais journalisé. */
export function depuisFile(
  entree: OutboxEntry,
  nom: string,
  auteur: string,
  avatar?: string,
): MessageAffiche {
  const body = entree.content.body;
  return {
    cle: entree.txnId,
    auteur,
    nom,
    avatar,
    texte: typeof body === "string" ? body : "",
    horodatage: entree.queuedAt,
    envoi: entree.status,
    errcode: entree.errcode,
    moi: true,
  };
}

/**
 * **une ligne pour dire de quoi on parle.**
 *
 * Une pièce jointe n'a pas de texte : son `body` est un nom de fichier, et citer
 * « IMG_4417.HEIC » ne dit à personne de quelle photo il s'agit. On nomme donc la nature
 * du média, comme toutes les messageries — c'est ce qui manquait à l'écran de réponse,
 * signalé pour la photo, la vidéo et le document à la fois.
 */
export function apercu(message: MessageAffiche): string {
  switch (message.media?.msgtype) {
    case "m.image":
      return "Photo";
    case "m.video":
      return "Vidéo";
    case "m.audio":
      return "Message vocal";
    case "m.file":
      // Le nom de fichier est du contenu, et il est ici sous les yeux de qui y a déjà
      // accès : c'est le seul cas où il aide à reconnaître la pièce citée.
      return message.media.nom || "Document";
    default:
      return texteAffiche(message.texte);
  }
}

/**
 * la citation d'un message, ou le repli quand il n'est pas chargé.
 *
 * Le repli est **explicite** et ne prétend rien (interdit n°13) : remonter chercher
 * l'événement au serveur serait un aller-retour réseau par ligne de timeline, et une
 * citation vide laisserait croire à un message vide.
 */
export const citation = (cible: MessageAffiche | undefined): Citation =>
  cible ? { nom: cible.nom, extrait: apercu(cible) } : { extrait: "Message plus ancien" };

/**
 * dit que le corps porte `@room` — c'est ce littéral que la push rule native
 * cherche. L'utilisateur, lui, a tapé `@everyone` et doit le relire tel quel : le rendu
 * inverse est explicitement à la charge de l'UI.
 */
export const texteAffiche = (texte: string) => texte.replaceAll(ROOM_MENTION, EVERYONE);

/** la fenêtre de regroupement Discord. */
export const FENETRE_GROUPE_MS = 5 * 60 * 1000;

/**
 * un séparateur de date à **chaque changement de jour**, et un avant le
 * premier message : sans lui, le haut de la timeline est le seul endroit où l'on ne sait
 * pas quel jour on lit.
 */
export function nouveauJour(
  precedent: MessageAffiche | undefined,
  message: MessageAffiche,
): boolean {
  return precedent === undefined || !memeJour(precedent.horodatage, message.horodatage);
}

/**
 * l'en-tête (avatar + nom) se rend au premier message, au changement
 * d'auteur, au changement de jour, et après cinq minutes de silence du même auteur.
 *
 * Fonction **pure** de deux messages voisins, comme la spec l'exige. « Sans activité
 * intermédiaire » est gratuit ici : `precedent` est le message immédiatement au-dessus,
 * donc quelqu'un qui a parlé entre les deux est déjà un changement d'auteur.
 */
export function shouldShowHeader(
  precedent: MessageAffiche | undefined,
  message: MessageAffiche,
): boolean {
  if (!precedent) return true;
  if (precedent.auteur !== message.auteur) return true;
  if (nouveauJour(precedent, message)) return true;
  return message.horodatage - precedent.horodatage > FENETRE_GROUPE_MS;
}

/**
 * **Le symétrique de `shouldShowHeader` : ce message ferme-t-il son groupe ?**
 *
 * Il n'existait pas, et la timeline sans bulles n'en avait pas besoin — seul le *début*
 * d'un groupe portait quelque chose (l'avatar, le nom). Une grappe de bulles a deux bouts :
 * le dernier message porte l'heure et l'accusé de réception, et c'est lui qui ferme la
 * forme. Même fenêtre, même règle, lue dans l'autre sens : le groupe s'arrête là où le
 * suivant en ouvrirait un nouveau.
 */
export function finDeGroupe(
  message: MessageAffiche,
  suivant: MessageAffiche | undefined,
): boolean {
  return suivant === undefined || shouldShowHeader(message, suivant);
}
