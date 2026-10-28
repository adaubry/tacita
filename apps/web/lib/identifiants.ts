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
 * **« 1 membre », pas « 1 membres » — et les invitations qui n'ont pas encore abouti.**
 *
 * Vu à l'écran sur un groupe qui venait d'être créé : l'accord était faux, et surtout le
 * compte n'était pas celui qu'on attendait. Matrix ne compte comme membre que celui qui
 * a **rejoint** ; on venait d'inviter deux personnes et l'écran annonçait « 1 membre ».
 * Exact, et incompréhensible — on croit que l'invitation a échoué.
 *
 * Les deux nombres plutôt qu'un seul total : annoncer « 3 membres » quand deux n'ont
 * rien accepté serait une promesse non tenue affichée (interdit n°13), et c'est la
 * distinction qui porte l'information — qui est là, qui doit encore répondre.
 *
 * Ici et pas dans les écrans : deux les affichent, et deux copies d'une règle de
 * grammaire divergent au premier qui écrit « membre(s) ».
 */
export const compteurMembres = (combien: number, invites = 0) => {
  const membres = `${combien} membre${combien > 1 ? "s" : ""}`;
  if (invites === 0) return membres;
  return `${membres}, ${invites} invitation${invites > 1 ? "s" : ""} en attente`;
};
