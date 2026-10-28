import type { Session } from "@tacita/client-core";
import {
  acceptInvitation,
  conversations,
  ignoredUsers,
  ignoreUser,
  invitations,
  leaveConversation,
  openDirectMessage,
  unignoreUser,
} from "@tacita/messaging";

export interface Contact {
  userId: string;
  nom: string;
}

/** Une demande d'ami en attente. D-09 : c'est une invitation de DM, pas un autre objet. */
export interface Demande {
  roomId: string;
  /** L'auteur de l'invitation, quand le serveur le donne. */
  userId?: string;
  nom: string;
}

/**
 * L'interface contre laquelle l'UI se code. Matrix n'a **aucun graphe social** :
 * un « ami » est un DM existant, et c'est le produit final, pas une étape.
 *
 * Elle existe pour que la substitution reste possible sans réécriture — du découplage
 * ordinaire, pas un pari sur une V2.
 *
 * **La distinction ami / non-ami ne se calcule qu'ici** (contrainte M-G). Un écran qui
 * referait le test « ai-je un DM avec cette personne ? » créerait une seconde définition,
 * et les deux divergeraient au premier cas limite — un DM quitté, une invitation en
 * attente, un blocage.
 */
export interface Contacts {
  lister(): Contact[];
  /** Les demandes reçues, pas encore acceptées. */
  demandes(): Demande[];
  /** `true` si un DM rejoint existe avec cette personne. */
  estAmi(userId: string): boolean;
  bloque(userId: string): boolean;
  /** Accepter rend le salon à ouvrir ; c'est l'appelant qui navigue. */
  accepter(roomId: string): Promise<string>;
  refuser(roomId: string): Promise<void>;
  /** Envoyer une demande : en V1, une invitation de DM. */
  inviter(userId: string): Promise<string>;
  /** Retirer un ami = quitter le DM partagé. Sans DM, il n'y a rien à quitter. */
  retirer(userId: string): Promise<void>;
  bloquer(userId: string): Promise<void>;
  debloquer(userId: string): Promise<void>;
}

/** L'implémentation native : les correspondants des DM rejoints, et rien d'autre. */
export function contactsDeLaSession(session: Session): Contacts {
  /** Le DM rejoint partagé avec cette personne, s'il y en a un. */
  const dmAvec = (userId: string) =>
    conversations(session).find((conversation) => conversation.peerId === userId);

  /**
   * **on n'est pas son propre ami.** La conversation personnelle du parcours
   * d'accueil est inscrite dans `m.direct` sous son propre identifiant, ce qui la fait
   * lire comme une conversation et non comme un groupe d'une personne. Sans cette ligne,
   * elle entrerait aussi dans la liste d'amis et dans la feuille « nouvelle
   * conversation » — on s'y proposerait à soi-même d'ouvrir un DM avec soi-même.
   *
   * Ici et pas dans l'écran : la distinction ami / non-ami ne se calcule qu'à cet endroit
   * (contrainte M-G), et une seconde définition dériverait au premier cas limite.
   */
  const moi = session.client.getUserId();

  return {
    /**
     * **Une personne, une entrée.** La liste parcourait les conversations : deux salons
     * partagés avec quelqu'un donnaient deux fois la même personne, avec le même
     * identifiant — vu à l'écran dans la feuille « nouvelle conversation », deux lignes
     * `maxoumbetatest` identiques. Cocher l'une ou l'autre revient au même, et rien ne
     * dit laquelle.
     *
     * Une `Map` par identifiant plutôt qu'un filtre : `conversations()` rend les salons
     * du plus récent au plus ancien, donc la première rencontrée porte le nom le plus à
     * jour, et c'est elle qu'on garde.
     */
    lister: () => {
      const parPersonne = new Map<string, Contact>();
      for (const conversation of conversations(session)) {
        const userId = conversation.peerId;
        if (userId === undefined || userId === moi || parPersonne.has(userId)) continue;
        parPersonne.set(userId, { userId, nom: conversation.name });
      }
      return [...parPersonne.values()];
    },

    demandes: () =>
      invitations(session).map((invitation) => ({
        roomId: invitation.roomId,
        userId: invitation.from,
        nom: invitation.name,
      })),

    estAmi: (userId) => dmAvec(userId) !== undefined,
    bloque: (userId) => ignoredUsers(session).includes(userId),

    accepter: (roomId) => acceptInvitation(session, roomId),
    refuser: (roomId) => leaveConversation(session, roomId),
    inviter: (userId) => openDirectMessage(session, userId),

    retirer: async (userId) => {
      const dm = dmAvec(userId);
      if (dm) await leaveConversation(session, dm.roomId);
    },

    bloquer: (userId) => ignoreUser(session, userId),
    debloquer: (userId) => unignoreUser(session, userId),
  };
}
