import { describe, expect, it, vi } from "vitest";

import { imagesParDefaut, poserImagesParDefaut } from "../src/identite";
import { CHAMP_BANNIERE } from "../src/social";
import { fakeSession } from "./session-mock";

/** `getUserId()` du mock : c'est le seed, donc ce qui rend les images reproductibles. */
const MOI = "@bob:tacita.test";

/** Un faux téléversement : rend un `mxc://` distinct par image, et garde les SVG reçus. */
function fauxTeleversement() {
  const recus: string[] = [];
  return {
    recus,
    televerser: vi.fn(async (svg: string) => {
      recus.push(svg);
      return `mxc://tacita.test/${recus.length}`;
    }),
  };
}

describe("images par défaut : deux styles, un seed, aucun réseau", () => {
  it("rend un glyphe et une constellation, déterministes pour un même identifiant", () => {
    const images = imagesParDefaut(MOI);

    // Les deux sont bien du SVG, et **deux dessins différents** : le même style aux deux
    // places donnerait une carte qui se répète.
    expect(images.avatar).toMatch(/^<svg /);
    expect(images.banniere).toMatch(/^<svg /);
    expect(images.avatar).not.toEqual(images.banniere);

    // Déterminisme : c'est ce qui fait qu'un compte garde son visage d'un appareil à
    // l'autre, sans que rien ne soit stocké nulle part.
    expect(imagesParDefaut(MOI)).toEqual(images);
    expect(imagesParDefaut("@mira:tacita.test").avatar).not.toEqual(images.avatar);
  });

  it("pose les deux images sur un profil vierge", async () => {
    const { session, client } = fakeSession({ profile: { displayname: "bob" } });
    const { recus, televerser } = fauxTeleversement();

    await poserImagesParDefaut(session, televerser);

    expect(recus).toEqual([imagesParDefaut(MOI).avatar, imagesParDefaut(MOI).banniere]);
    expect(client.setAvatarUrl).toHaveBeenCalledWith("mxc://tacita.test/1");
    expect(client.setExtendedProfileProperty).toHaveBeenCalledWith(
      CHAMP_BANNIERE,
      "mxc://tacita.test/2",
    );
    // Le nom d'affichage vient du fournisseur d'identité : ces images ne le touchent pas.
    expect(client.setDisplayName).not.toHaveBeenCalled();
  });

  it("ne remplace jamais ce que le compte a déjà choisi", async () => {
    const complet = fakeSession({
      profile: { avatar_url: "mxc://tacita.test/photo", [CHAMP_BANNIERE]: "mxc://tacita.test/b" },
    });
    const rien = fauxTeleversement();

    await poserImagesParDefaut(complet.session, rien.televerser);

    expect(rien.televerser).not.toHaveBeenCalled();
    expect(complet.client.setAvatarUrl).not.toHaveBeenCalled();
    expect(complet.client.setExtendedProfileProperty).not.toHaveBeenCalled();

    // Les deux champs sont regardés séparément : une photo choisie sans bannière ne doit
    // ni bloquer la bannière, ni coûter sa photo à qui l'a posée.
    const moitie = fakeSession({ profile: { avatar_url: "mxc://tacita.test/photo" } });
    const une = fauxTeleversement();

    await poserImagesParDefaut(moitie.session, une.televerser);

    expect(une.recus).toEqual([imagesParDefaut(MOI).banniere]);
    expect(moitie.client.setAvatarUrl).not.toHaveBeenCalled();
    expect(moitie.client.setExtendedProfileProperty).toHaveBeenCalledWith(
      CHAMP_BANNIERE,
      "mxc://tacita.test/1",
    );
  });
});
