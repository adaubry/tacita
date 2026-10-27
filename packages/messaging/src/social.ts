/**
 * Le lien social : demandes d'ami, contacts, annuaire, profils.
 *
 * Se relier à quelqu'un passe par une invitation à un salon direct — il n'y a pas
 * de liste d'amis côté serveur, et c'est la seule primitive que Matrix offre.
 */
import type { Session } from "@tacita/client-core";

import { registerDirect } from "./conversations";

/**
 * Le modèle social de D-09, et rien de plus.
 *
 * Chaque fonction d'ici est un appel Matrix **natif** : accepter une demande d'ami est un
 * `join`, la refuser un `leave`, bloquer une écriture dans `m.ignored_user_list`. Il n'y
 * a pas de graphe social derrière, et il n'y en aura pas l'a refusé, pas reporté.
 *
 * Ces fonctions vivent dans le paquet et non dans un écran pour la même raison qu'en
 * M-C : « ami », « bloqué » et « demande en attente » sont de la logique métier, et une
 * définition dispersée dans trois composants dérive au premier écran suivant.
 */

/**
 * accepter une demande d'ami. C'est un `join` sur le DM invité, pas une
 * écriture dans un registre : D-09 fait de l'invitation de salon **la** demande d'ami.
 *
 * Rend l'identifiant du salon rejoint, celui que l'UI ouvre ensuite.
 */
export async function acceptInvitation(session: Session, roomId: string): Promise<string> {
  // L'invitant est lu **avant** le join : une fois entré, le salon n'est plus une
  // invitation et `getDMInviter()` ne rend plus rien.
  const invitant = session.client.getRoom(roomId)?.getDMInviter();
  await session.client.joinRoom(roomId);

  // côté invité aussi, `m.direct` est à écrire : le drapeau `is_direct` de
  // l'invitation ne devient jamais de l'account data tout seul. Sans cela, accepter une
  // demande d'ami donne une conversation qui n'est un DM pour aucun des deux.
  if (invitant) await registerDirect(session, invitant, roomId);
  return roomId;
}

/**
 * refuser une demande, ou retirer un ami : dans les deux cas un `leave`.
 *
 * Le geste est le même côté protocole ; ce qui diffère est ce que l'UI en dit, et c'est
 * à elle de le dire. Deux fonctions identiques ici ne feraient qu'inviter à les faire
 * diverger.
 */
export async function leaveConversation(session: Session, roomId: string): Promise<void> {
  await session.client.leave(roomId);
}

/**
 * la liste d'ignorés du compte, telle que le serveur la porte.
 *
 * Le SDK la tient à jour depuis l'account data ; on ne la recopie pas ailleurs, sinon
 * deux sources répondraient « est-ce que je l'ai bloqué ? ».
 */
export const ignoredUsers = (session: Session): string[] => session.client.getIgnoredUsers();

/**
 * bloquer et débloquer, par `m.ignored_user_list` natif.
 *
 * **Ce que le blocage fait réellement**, et que l'UI doit dire sans l'embellir (interdit
 * n°13) : le serveur cesse de nous **envoyer** les événements de cette personne. Elle
 * n'est pas empêchée d'écrire, elle n'est pas prévenue, et elle reste membre des salons
 * partagés. C'est une mise en sourdine côté réception, pas une expulsion.
 *
 * L'écriture remplace la liste entière — c'est la forme de l'account data. On relit
 * donc l'état courant juste avant, plutôt que de tenir un cache qui divergerait.
 */
export async function ignoreUser(session: Session, userId: string): Promise<void> {
  const courants = ignoredUsers(session);
  if (courants.includes(userId)) return;
  await session.client.setIgnoredUsers([...courants, userId]);
}

export async function unignoreUser(session: Session, userId: string): Promise<void> {
  const courants = ignoredUsers(session);
  if (!courants.includes(userId)) return;
  await session.client.setIgnoredUsers(courants.filter((id) => id !== userId));
}

/**
 * la bannière de profil, en champ **étendu** (MSC4133).
 *
 * Matrix ne définit que `displayname` et `avatar_url` ; une bannière n'existe nulle part
 * dans la spec, donc elle vit dans un champ à nous, nommé dans notre espace. Vérifié
 * contre le Synapse déployé (v1.155.0, digest épinglé dans `infra/synapse/Dockerfile`) :
 *
 * - `GET /_matrix/client/v3/profile/{userId}` rend les champs personnalisés **avec** le
 *   reste du profil (`ProfileHandler.get_profile` : `ret.update(extra_fields)`), donc les
 *   lire ne coûte aucune requête de plus — `profileOf` les reçoit déjà ;
 * - la route générique `PUT /_matrix/client/v3/profile/{userId}/{champ}` est enregistrée
 *   **sans condition** dans cette version : `experimental_features.msc4133_enabled`
 *   n'ajoute que le préfixe instable `uk.tcpip.msc4133`, et l'infra n'a donc rien à
 *   changer. `uk.tcpip.msc4133.stable` étant annoncé en dur, matrix-js-sdk part de
 *   lui-même sur le préfixe `v3` ;
 * - le nom doit suivre la *Common Namespaced Identifier Grammar*
 * (`^[a-z][a-z0-9_.-]{0,254}$`, `synapse/util/stringutils.py`) : celui-ci la respecte.
 *
 * À revérifier au prochain bump de Synapse, comme les autres valeurs sensibles aux
 * versions : une route aujourd'hui inconditionnelle peut repasser derrière le drapeau.
 */
export const CHAMP_BANNIERE = "org.tacita.banner_url";

/** Ce qu'un profil Matrix porte. Les champs sont tous facultatifs côté protocole. */
export interface Profile {
  userId: string;
  /** Le nom d'affichage, ou l'identifiant si le compte n'en a pas posé. */
  displayName: string;
  /** URL `mxc://`, à déchiffrer/résoudre par le pipeline média — jamais une URL http. */
  avatarUrl?: string;
  /** `mxc://` de la bannière, même nature que `avatarUrl` : public, non chiffré. */
  bannerUrl?: string;
}

/**
 * le profil public d'un utilisateur.
 *
 * Un profil absent n'est pas une erreur : un compte peut n'avoir jamais posé de nom, et
 * le serveur répond alors `404`. On retombe sur l'identifiant, qui est toujours vrai et
 * toujours affichable — laisser lever ferait échouer l'écran entier pour un champ vide.
 */
export async function profileOf(session: Session, userId: string): Promise<Profile> {
  try {
    const profil = await session.client.getProfileInfo(userId);
    // Le champ étendu voyage dans la même réponse ; le type du SDK ne connaît que les
    // deux champs de la spec, d'où la lecture par index. Une valeur non textuelle est
    // ignorée : le champ est libre côté serveur, n'importe qui peut y poser un objet.
    const banniere = (profil as Record<string, unknown>)[CHAMP_BANNIERE];
    return {
      userId,
      displayName: profil.displayname ?? userId,
      avatarUrl: profil.avatar_url,
      bannerUrl: typeof banniere === "string" ? banniere : undefined,
    };
  } catch {
    return { userId, displayName: userId };
  }
}

/**
 * modifier son propre profil. Deux écritures distinctes côté protocole ;
 * on ne pose que ce qui est fourni, pour qu'un formulaire qui ne change que le nom
 * n'efface pas la photo.
 *
 * `avatarUrl` et `bannerUrl` sont des `mxc://` déjà téléversés — le téléversement
 * appartient au pipeline média, pas à ce paquet.
 */
export async function updateProfile(
  session: Session,
  changements: { displayName?: string; avatarUrl?: string; bannerUrl?: string },
): Promise<void> {
  if (changements.displayName !== undefined) {
    await session.client.setDisplayName(changements.displayName);
  }
  if (changements.avatarUrl !== undefined) {
    await session.client.setAvatarUrl(changements.avatarUrl);
  }
  if (changements.bannerUrl !== undefined) {
    // champ étendu, pas un champ de la spec : voir `CHAMP_BANNIERE`.
    await session.client.setExtendedProfileProperty(CHAMP_BANNIERE, changements.bannerUrl);
  }
}

/**
 * le domaine de son propre identifiant, c'est-à-dire **le seul domaine du
 * déploiement** : la fédération est désactivée (`federation_domain_whitelist:
 * []`), donc tout compte joignable vit ici. C'est ce qui autorise à compléter un
 * identifiant partiel sans jamais se tromper de serveur.
 */
const domaineLocal = (session: Session): string | undefined =>
  session.client.getUserId()?.split(":")[1];

/**
 * la forme complète d'un identifiant Matrix, `@localpart:domaine`.
 *
 * La grammaire du localpart est celle de la spec (`a-z0-9._=/+-`) ; on ne l'élargit pas,
 * une saisie qui n'y entre pas n'est pas un identifiant et part à l'annuaire telle quelle.
 */
const IDENTIFIANT_COMPLET = /^@[a-z0-9._=/+-]+:[^:\s]+$/;
const LOCALPART_SEUL = /^@?[a-z0-9._=/+-]+$/;

/**
 * **la forme canonique de ce que l'utilisateur a tapé**, quand c'en est une.
 *
 * `@alice:chat.example.org`, `@alice` et `alice` désignent la même personne sur un
 * déploiement sans fédération, et l'utilisateur ne devrait pas avoir à écrire les deux
 * tiers d'une adresse qu'il ne choisit pas. Rend `undefined` quand la saisie n'a pas la
 * forme d'un identifiant — un nom d'affichage, un prénom avec une majuscule, une phrase.
 *
 * Exporté pour être éprouvé seul : c'est une fonction pure, et c'est elle qui décide si
 * un aller-retour de profil part.
 */
export function identifiantComplet(terme: string, domaine: string | undefined): string | undefined {
  const saisie = terme.trim();
  if (IDENTIFIANT_COMPLET.test(saisie)) return saisie;
  if (!domaine || !LOCALPART_SEUL.test(saisie)) return undefined;
  return `@${saisie.replace(/^@/, "")}:${domaine}`;
}

/**
 * recherche d'utilisateur dans l'**annuaire** du homeserver.
 *
 * À ne pas confondre avec la recherche de contenu : l'annuaire porte des identifiants et
 * des noms d'affichage, jamais de messages. `/search` de Synapse reste interdit
 * (interdit n°3) et n'a rien à voir avec cet endpoint.
 *
 * Un terme vide ne part pas : l'annuaire rendrait un échantillon arbitraire du serveur,
 * ce qui n'est pas une réponse à « qui cherchez-vous ? ».
 *
 * **L'annuaire couvre tous les comptes du serveur** : une recherche par nom d'affichage ou par fragment
 * d'identifiant aboutit, ce qui n'était pas le cas auparavant. La conséquence — tout
 * compte peut énumérer les autres — est assumée ;
 * l'écran d'ajout la dit aussi, parce qu'elle vaut pour l'utilisateur lui-même.
 */
export async function searchUsers(
  session: Session,
  terme: string,
  limite = 20,
): Promise<Profile[]> {
  const recherche = terme.trim();
  if (recherche.length === 0) return [];

  /**
   * **une adresse exacte se résout par son profil, pas par l'annuaire.**
   *
   * Mesuré contre un vrai Synapse : `/user_directory/search` rendait
   * `results: []` pour un compte qui existe pourtant, tandis que `/profile/@…` rendait
   * son nom d'affichage — le défaut `search_all_users: false` ne montrant que les gens
   * avec qui on partage déjà un salon. E-21 a depuis ouvert l'annuaire, et
   * ce chemin **reste**, pour deux raisons qui n'ont rien d'historique :
   *
   * - l'index de l'annuaire est **construit en fond** et peut retarder — juste après un
   *   changement de configuration, tant que `regenerate_directory` n'a pas tourné, il
   *   ignore les comptes déjà créés. Une adresse exacte, elle, résout toujours ;
   * - l'annuaire **exclut** certaines catégories de comptes (désactivés, support,
   *   application services), là où un profil demandé nommément répond ou n'existe pas.
   *
   * Autrement dit : l'annuaire est le chemin de la découverte, le profil celui de la
   * certitude. Les deux répondent à des questions différentes.
   */
  /*
   * **Le domaine ne se tape plus.** La rédaction précédente n'empruntait le chemin du
   * profil que sur un identifiant *complet* : taper « alice » n'interrogeait que
   * l'annuaire, muet à l'époque (voir ci-dessus), et il fallait donc écrire
   * `@alice:chat.example.org` en entier pour trouver qui que ce soit. Signalé par les
   * utilisateurs, et c'est bien ce que le code faisait.
   *
   * Le domaine étant unique (fédération désactivée), le compléter n'invente
   * rien : `@alice` ne peut désigner personne d'autre que `@alice:<notre serveur>`.
   */
  const complet = identifiantComplet(recherche, domaineLocal(session));

  // Une adresse entière ne doit rien à l'annuaire : le profil répond exactement à la
  // question posée, et l'interroger en plus coûterait une requête par frappe pour rien.
  if (complet === recherche) return rendus(await profileOf(session, complet), []);

  /*
   * Sinon les deux chemins partent **ensemble** : l'annuaire trouve par nom d'affichage
   * les gens avec qui on partage déjà un salon, le profil trouve par identifiant exact
   * ceux avec qui on n'en partage aucun. Aucun des deux ne remplace l'autre, et attendre
   * le premier pour décider s'il faut lancer le second doublerait la latence de frappe.
   *
   * L'annuaire peut être refusé par le serveur : son échec ne doit pas emporter le
   * résultat du profil, d'où le repli sur une liste vide plutôt qu'un rejet.
   */
  const [profil, annuaire] = await Promise.all([
    complet ? profileOf(session, complet) : undefined,
    session.client.searchUserDirectory({ term: recherche, limit: limite }).catch(() => ({
      results: [] as { user_id: string; display_name?: string; avatar_url?: string }[],
    })),
  ]);

  return rendus(
    profil,
    annuaire.results.map((resultat) => ({
      userId: resultat.user_id,
      displayName: resultat.display_name ?? resultat.user_id,
      avatarUrl: resultat.avatar_url,
    })),
  );
}

/**
 * le profil résolu en tête, puis l'annuaire, sans doublon.
 *
 * Un identifiant inexistant rend un profil de repli portant l'identifiant lui-même
 * le proposer ferait « trouver » n'importe quelle saisie, donc on ne
 * garde que ce que le serveur a vraiment reconnu.
 */
function rendus(profil: Profile | undefined, annuaire: Profile[]): Profile[] {
  const reconnu =
    profil !== undefined &&
    profil.displayName !== profil.userId &&
    !annuaire.some((resultat) => resultat.userId === profil.userId);
  return reconnu ? [profil, ...annuaire] : annuaire;
}
