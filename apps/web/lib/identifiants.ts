/**
 * **l'identifiant tel qu'on l'affiche.**
 *
 * `@alice:chat.example.org` tient en trois mots dont un seul porte de l'information : le
 * domaine est le même pour tout le monde, puisque la fédération est désactivée
 * (`federation_domain_whitelist: []` dans `infra/synapse/homeserver.yaml.tmpl`).
 * Affiché partout, il pousse le nom hors des cartes sur mobile et se fait recopier à la
 * main dans la recherche d'amis, où il n'est plus exigé non plus.
 *
 * Ce n'est **pas** une troncature cosmétique : `@alice` est une adresse complète sur ce
 * déploiement — `identifiantComplet` du paquet messaging la rétablit sans ambiguïté.
 * Rien de ce qui s'affiche ici ne cesse d'être copiable ni utilisable.
 *
 * ponytail: raccourci inconditionnel. Le jour où la fédération s'ouvre, comparer le
 * domaine à celui de son propre identifiant et ne raccourcir que s'ils coïncident —
 * un `@alice:autre-serveur.org` raccourci désignerait quelqu'un d'autre.
 */
export function identifiantCourt(userId: string): string {
  const separateur = userId.indexOf(":");
  return separateur === -1 ? userId : userId.slice(0, separateur);
}

/**
 * **« 1 membre », pas « 1 membres ».**
 *
 * Vu à l'écran sur un groupe qui venait d'être créé : les invités n'ont pas encore
 * accepté, le compte vaut 1, et l'accord était faux. Deux écrans l'écrivaient — le début
 * de conversation et l'écran d'informations —, et deux copies d'une règle de grammaire
 * divergent au premier qui écrit « membre(s) ».
 */
export const compteurMembres = (combien: number) =>
  `${combien} membre${combien > 1 ? "s" : ""}`;
