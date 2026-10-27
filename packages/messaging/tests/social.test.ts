import { describe, expect, it } from "vitest";

import {
  acceptInvitation,
  CHAMP_BANNIERE,
  identifiantComplet,
  ignoredUsers,
  ignoreUser,
  leaveConversation,
  profileOf,
  searchUsers,
  unignoreUser,
  updateProfile,
} from "../src/social";
import { fakeSession } from "./session-mock";

const MIRA = "@mira:tacita.test";

describe("accepter, refuser, quitter : trois gestes, deux appels natifs", () => {
  it("accepter une demande d'ami est un join, et rend le salon à ouvrir", async () => {
    const { session, client } = fakeSession();

    await expect(acceptInvitation(session, "!dm:tacita.test")).resolves.toBe("!dm:tacita.test");
    expect(client.joinRoom).toHaveBeenCalledWith("!dm:tacita.test");
  });

  it("refuser une demande et retirer un ami sont le même leave", async () => {
    const { session, client } = fakeSession();

    await leaveConversation(session, "!dm:tacita.test");
    expect(client.leave).toHaveBeenCalledWith("!dm:tacita.test");
    // D-09 : il n'existe aucun registre d'amitié à mettre à jour en plus.
    expect(client.sendStateEvent).not.toHaveBeenCalled();
  });
});

describe("blocage par m.ignored_user_list natif", () => {
  it("bloquer ajoute à la liste existante au lieu de l'écraser", async () => {
    const { session, client } = fakeSession({ ignored: ["@sam:tacita.test"] });

    await ignoreUser(session, MIRA);
    expect(client.setIgnoredUsers).toHaveBeenCalledWith(["@sam:tacita.test", MIRA]);
    // La lecture suit l'écriture : une seule source, celle du SDK.
    expect(ignoredUsers(session)).toEqual(["@sam:tacita.test", MIRA]);
  });

  it("bloquer deux fois n'écrit qu'une fois", async () => {
    const { session, client } = fakeSession({ ignored: [MIRA] });

    await ignoreUser(session, MIRA);
    expect(client.setIgnoredUsers).not.toHaveBeenCalled();
  });

  it("débloquer retire, et ne touche pas aux autres", async () => {
    const { session, client } = fakeSession({ ignored: ["@sam:tacita.test", MIRA] });

    await unignoreUser(session, MIRA);
    expect(client.setIgnoredUsers).toHaveBeenCalledWith(["@sam:tacita.test"]);

    client.setIgnoredUsers.mockClear();
    await unignoreUser(session, "@inconnu:tacita.test");
    expect(client.setIgnoredUsers).not.toHaveBeenCalled();
  });
});

/**
 * Le seul test de la bannière, et il porte sur ce qui pouvait silencieusement ne rien
 * faire : le champ **étendu**. Le reste de (le rendu) n'est pas prouvable en
 * jsdom — c'est un `fetch` authentifié et une URL d'objet.
 */
describe("bannière : champ étendu, lu sans requête de plus", () => {
  it("la bannière voyage dans la réponse de profil, et une valeur non textuelle est ignorée", async () => {
    const { session, client } = fakeSession({
      profile: { displayname: "mira", [CHAMP_BANNIERE]: "mxc://tacita.test/banniere" },
    });

    await expect(profileOf(session, MIRA)).resolves.toMatchObject({
      bannerUrl: "mxc://tacita.test/banniere",
    });
    // Aucun appel de plus : c'est tout l'intérêt du champ étendu contre un `GET` dédié.
    expect(client.getProfileInfo).toHaveBeenCalledTimes(1);

    const autre = fakeSession({ profile: { [CHAMP_BANNIERE]: { url: "objet" } } });
    expect((await profileOf(autre.session, MIRA)).bannerUrl).toBeUndefined();
  });

  it("ne changer que le nom n'écrit aucun champ étendu", async () => {
    const { session, client } = fakeSession();

    await updateProfile(session, { displayName: "alice" });
    expect(client.setExtendedProfileProperty).not.toHaveBeenCalled();

    await updateProfile(session, { bannerUrl: "mxc://tacita.test/b" });
    expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
      CHAMP_BANNIERE,
      "mxc://tacita.test/b",
    );
  });
});

describe("profil : lecture tolérante, écriture sélective", () => {
  it("un profil complet est rendu tel quel", async () => {
    const { session } = fakeSession({
      profile: { displayname: "mira", avatar_url: "mxc://tacita.test/abc" },
    });

    await expect(profileOf(session, MIRA)).resolves.toEqual({
      userId: MIRA,
      displayName: "mira",
      avatarUrl: "mxc://tacita.test/abc",
    });
  });

  it("un compte sans nom retombe sur son identifiant, pas sur du vide", async () => {
    const { session } = fakeSession({ profile: {} });

    const profil = await profileOf(session, MIRA);
    expect(profil.displayName).toBe(MIRA);
    expect(profil.avatarUrl).toBeUndefined();
  });

  it("un profil introuvable ne fait pas échouer l'écran", async () => {
    const { session, client } = fakeSession();
    client.getProfileInfo.mockRejectedValue(new Error("404"));

    await expect(profileOf(session, MIRA)).resolves.toEqual({
      userId: MIRA,
      displayName: MIRA,
    });
  });

  it("ne changer que le nom n'efface pas la photo", async () => {
    const { session, client } = fakeSession();

    await updateProfile(session, { displayName: "alice" });
    expect(client.setDisplayName).toHaveBeenCalledWith("alice");
    expect(client.setAvatarUrl).not.toHaveBeenCalled();

    await updateProfile(session, { avatarUrl: "mxc://tacita.test/nouveau" });
    expect(client.setAvatarUrl).toHaveBeenCalledWith("mxc://tacita.test/nouveau");
    expect(client.setDisplayName).toHaveBeenCalledTimes(1);
  });

  it("un nom vidé est une valeur, pas une absence — il part", async () => {
    const { session, client } = fakeSession();

    await updateProfile(session, { displayName: "" });
    expect(client.setDisplayName).toHaveBeenCalledWith("");
  });
});

describe("annuaire du homeserver, jamais /search", () => {
  it("les résultats sont normalisés en Profile", async () => {
    const { session, client } = fakeSession({
      annuaire: [
        { user_id: MIRA, display_name: "mira", avatar_url: "mxc://tacita.test/m" },
        { user_id: "@sam:tacita.test" },
      ],
    });
    // Aucun compte ne s'appelle littéralement « @mi » : seul l'annuaire répond ici.
    client.getProfileInfo.mockRejectedValueOnce(new Error("M_NOT_FOUND"));

    await expect(searchUsers(session, "mi")).resolves.toEqual([
      { userId: MIRA, displayName: "mira", avatarUrl: "mxc://tacita.test/m" },
      { userId: "@sam:tacita.test", displayName: "@sam:tacita.test", avatarUrl: undefined },
    ]);
    expect(client.searchUserDirectory).toHaveBeenCalledWith({ term: "mi", limit: 20 });
  });

  it("un terme vide ne part pas — l'annuaire rendrait un échantillon arbitraire", async () => {
    const { session, client } = fakeSession();

    await expect(searchUsers(session, "   ")).resolves.toEqual([]);
    expect(client.searchUserDirectory).not.toHaveBeenCalled();
  });
});

describe("un identifiant complet se résout par son profil", () => {
  /**
   * Mesuré contre un vrai Synapse : l'annuaire rend `results: []` pour un
   * compte qui existe, parce que `search_all_users` est faux par défaut. « Ajouter par
   * identifiant » ne trouvait donc jamais personne — le parcours d'entrée du produit.
   */
  it("ne consulte pas l'annuaire quand on lui donne une adresse", async () => {
    const { session, client } = fakeSession();
    const trouves = await searchUsers(session, MIRA);

    expect(client.searchUserDirectory).not.toHaveBeenCalled();
    expect(client.getProfileInfo).toHaveBeenCalledWith(MIRA);
    expect(trouves).toEqual([{ userId: MIRA, displayName: "bob", avatarUrl: undefined }]);
  });

  it("un identifiant que le serveur ne connaît pas ne rend rien", async () => {
    // `profileOf` retombe sur l'identifiant lui-même quand le profil est introuvable
    // proposer ce repli ferait « trouver » n'importe quelle saisie.
    const { session, client } = fakeSession();
    client.getProfileInfo.mockRejectedValueOnce(new Error("M_NOT_FOUND"));
    await expect(searchUsers(session, "@inconnu:tacita.test")).resolves.toEqual([]);
  });

  it("un terme qui n'est pas une adresse passe toujours par l'annuaire", async () => {
    const { session, client } = fakeSession();
    await searchUsers(session, "mira");
    expect(client.searchUserDirectory).toHaveBeenCalledWith({ term: "mira", limit: 20 });
  });
});

describe("le domaine ne se saisit pas", () => {
  /**
   * Retour utilisateur : « rechercher un utilisateur pour l'ajouter en ami requiert son
   * identifiant complet ». C'était exact — seule une adresse entière empruntait le
   * chemin du profil, et l'annuaire, seul chemin restant, ne rend rien sur ce
   * déploiement (`search_all_users: false`).
   */
  it("complète un localpart avec le domaine du compte courant", async () => {
    const { session, client } = fakeSession();
    // Le compte courant du mock est `@bob:tacita.test` : c'est de lui que vient le
    // domaine, jamais d'une constante recopiée.
    await searchUsers(session, "mira");
    expect(client.getProfileInfo).toHaveBeenCalledWith(MIRA);
  });

  it("accepte aussi bien `mira` que `@mira`", async () => {
    const { session, client } = fakeSession();
    await searchUsers(session, "@mira");
    expect(client.getProfileInfo).toHaveBeenCalledWith(MIRA);
  });

  it("ne rend qu'une fois une personne que l'annuaire et le profil trouvent tous deux", async () => {
    const { session } = fakeSession({ annuaire: [{ user_id: MIRA, display_name: "mira" }] });

    await expect(searchUsers(session, "mira")).resolves.toEqual([
      { userId: MIRA, displayName: "mira", avatarUrl: undefined },
    ]);
  });

  it("rend le profil trouvé même quand l'annuaire est refusé par le serveur", async () => {
    // L'annuaire peut être désactivé côté déploiement : son échec ne doit pas emporter
    // le seul chemin qui fonctionne.
    const { session, client } = fakeSession();
    client.searchUserDirectory.mockRejectedValueOnce(new Error("M_FORBIDDEN"));

    await expect(searchUsers(session, "mira")).resolves.toEqual([
      { userId: MIRA, displayName: "bob", avatarUrl: undefined },
    ]);
  });

  it("un nom d'affichage partiel remonte par l'annuaire", async () => {
    // : l'annuaire couvre tous les comptes du serveur, donc
    // un fragment de nom aboutit. Avant, ce chemin était muet et seul l'identifiant exact
    // trouvait quelqu'un — c'est le « uniquement de l'exact match » signalé.
    const { session, client } = fakeSession({
      annuaire: [{ user_id: MIRA, display_name: "Mira Dupont" }],
    });
    client.getProfileInfo.mockRejectedValueOnce(new Error("M_NOT_FOUND"));

    await expect(searchUsers(session, "Mira D")).resolves.toEqual([
      { userId: MIRA, displayName: "Mira Dupont", avatarUrl: undefined },
    ]);
  });

  it("une saisie qui n'est pas un identifiant n'interroge aucun profil", async () => {
    // Un nom d'affichage avec majuscule ou espace n'est pas un localpart : lui inventer
    // un domaine ferait un aller-retour par frappe pour une adresse impossible.
    const { session, client } = fakeSession();
    await searchUsers(session, "Mira Dupont");
    expect(client.getProfileInfo).not.toHaveBeenCalled();
    expect(client.searchUserDirectory).toHaveBeenCalledWith({ term: "Mira Dupont", limit: 20 });
  });

  it("identifiantComplet est pur et rend la forme canonique, ou rien", () => {
    expect(identifiantComplet("alice", "tacita.test")).toBe("@alice:tacita.test");
    expect(identifiantComplet(" @alice ", "tacita.test")).toBe("@alice:tacita.test");
    expect(identifiantComplet("@alice:autre.test", "tacita.test")).toBe("@alice:autre.test");
    expect(identifiantComplet("Alice Dupont", "tacita.test")).toBeUndefined();
    // Sans domaine connu — session sans identifiant —, on n'invente rien.
    expect(identifiantComplet("alice", undefined)).toBeUndefined();
  });
});
