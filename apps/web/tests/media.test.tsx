import type { EncryptedFile } from "@tacita/media-pipeline";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lire, sansCommentaires } from "./sources";
import { ConversationCollections } from "../components/media/ConversationCollections";
import { EnregistreurVocal } from "../components/media/EnregistreurVocal";
import { MediaMessage } from "../components/media/MediaMessage";
import { MediaPicker } from "../components/media/MediaPicker";
import { MediaViewer } from "../components/media/MediaViewer";
import { PhotoCapture } from "../components/media/PhotoCapture";
import { VoicePlayer } from "../components/media/VoicePlayer";
import { dimensionsCibles } from "../lib/transcode-video";
import {
  dureeLisible,
  liensDe,
  mediaDe,
  repartir,
  tailleLisible,
  type EvenementLu,
  type Media,
} from "../components/media/media";

vi.mock("next/navigation", () => ({
  usePathname: () => "/c/!salon",
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const FICHIER: EncryptedFile = {
  url: "mxc://tacita.test/abc",
  key: { alg: "A256CTR", ext: true, k: "cle", key_ops: ["encrypt", "decrypt"], kty: "oct" },
  iv: "iv",
  hashes: { sha256: "hash" },
  v: "v2",
} as unknown as EncryptedFile;

const VIGNETTE = { ...FICHIER, url: "mxc://tacita.test/vignette" };

/** Un événement réduit à ce que le shard en lit — la forme structurelle de `EvenementLu`. */
function evenement(contenu: Record<string, unknown>, id = "$e"): EvenementLu {
  return { getId: () => id, getContent: () => contenu };
}

const image = (id = "$img") =>
  evenement(
    {
      msgtype: "m.image",
      body: "plage.jpg",
      file: FICHIER,
      // `info.mimetype` est ce que le pipeline écrit, et ce dont la
      // résolution de type part. Une fixture qui l'omettait décrivait un
      // événement que ce dépôt ne produit pas.
      info: { size: 2048, mimetype: "image/jpeg", thumbnail_file: VIGNETTE },
    },
    id,
  );

/** Le pipeline est mocké à son interface : aucun octet n'est déchiffré ici. */
const telecharger = vi.fn(async () => new Blob(["binaire"], { type: "image/jpeg" }));

beforeEach(() => {
  // jsdom n'implémente ni l'un ni l'autre : ce sont des lacunes d'environnement, pas
  // des dépendances du composant.
  globalThis.URL.createObjectURL ??= vi.fn(() => "blob:tacita/1");
  globalThis.URL.revokeObjectURL ??= vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("pièces jointes : vignettes déchiffrées, tuiles, vocaux", () => {
  it("la vignette est rendue depuis le blob déchiffré, et aucune URL serveur n'est construite", async () => {
    const reseau = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("réseau interdit"));

    render(<MediaMessage media={mediaDe(image())!} telecharger={telecharger} />);
    await waitFor(() => expect(screen.getByAltText("plage.jpg")).toBeTruthy());

    // Le blob vient de `downloadAttachment` (mocké), et rien d'autre n'a été demandé au
    // réseau : surtout pas l'endpoint `thumbnail`, inopérant sur média chiffré.
    expect(telecharger).toHaveBeenCalledWith(VIGNETTE, "image/jpeg");
    expect(reseau).not.toHaveBeenCalled();
    expect(screen.getByAltText("plage.jpg").getAttribute("src")).toMatch(/^blob:/);
  });

  it("la vignette est déchiffrée sous le type que l'événement lui donne", async () => {
    // Elle est en WebP depuis qu'elle a doublé de côté, et en JPEG là où l'expéditeur ne
    // savait pas l'encoder : le type se lit dans `thumbnail_info`, il ne se devine pas.
    const webp = mediaDe(
      evenement({
        msgtype: "m.image",
        body: "plage.jpg",
        file: FICHIER,
        info: {
          mimetype: "image/jpeg",
          thumbnail_file: VIGNETTE,
          thumbnail_info: { mimetype: "image/webp", w: 512, h: 288 },
        },
      }),
    )!;
    expect(webp.vignetteMime).toBe("image/webp");

    render(<MediaMessage media={webp} telecharger={telecharger} />);
    await waitFor(() => expect(telecharger).toHaveBeenCalledWith(VIGNETTE, "image/webp"));
  });

  /**
   * Le repli de format ne se suppose pas : un canvas à qui l'on demande un type qu'il ne
   * sait pas encoder rend du **PNG** en silence, et un PNG de photo pèse plusieurs fois le
   * JPEG qu'il remplace — la vignette deviendrait plus lourde là où elle devait s'alléger.
   * jsdom n'a pas d'`OffscreenCanvas` : c'est la source qui est lue (règle 7).
   */
  it("le repli de format de la vignette relit le type obtenu", () => {
    const source = sansCommentaires(lire("lib/media-env.ts"));
    expect(source).toContain("blob.type === mimeType");
    expect(source).toContain('convertToBlob({ type: "image/jpeg", quality })');
  });

  it("une vidéo sans vignette rend une tuile terminale, jamais un skeleton sans fin", async () => {
    /*
     * **Le défaut, et c'est une jonction (règle 1).** `thumbnail_file` est
     * devenu facultatif côté pipeline pour qu'un poster impossible n'emporte plus l'envoi
     * — ce qui était le bon arbitrage. Ce rendu, lui, supposait toujours la vignette
     * présente : `useBlob` appelé sans fichier sort de son effet sans rien faire, donc ni
     * `url` ni `erreur`, et le squelette scintillait indéfiniment. La vidéo était bien
     * arrivée, entièrement lisible, derrière une animation qui promettait une suite.
     *
     * Les deux specs étaient respectées ; c'est l'espace entre elles qui ne l'était pas.
     */
    const sansVignette = mediaDe(
      evenement({
        msgtype: "m.video",
        body: "clip.mp4",
        file: FICHIER,
        info: { size: 4096, mimetype: "video/mp4", duration: 8000, w: 1280, h: 720 },
      }),
    )!;

    // Une promesse qui ne se résout jamais : si le rendu attendait quoi que ce soit, il
    // attendrait pour toujours — et c'est précisément ce qu'on interdit.
    render(<MediaMessage media={sansVignette} telecharger={() => new Promise<Blob>(() => {})} />);

    // La tuile existe, elle est terminale, et elle garde son ouverture.
    const tuile = await screen.findByRole("button", { name: /Vidéo clip\.mp4/ });
    expect(tuile).toBeTruthy();
    // Aucun déchiffrement n'a même été tenté : il n'y a pas de vignette à demander.
    expect(tuile.querySelector("svg")).toBeTruthy();
    expect(tuile.querySelector("img")).toBeNull();
  });

  it("en attente du déchiffrement, un skeleton — pas un trou qui déplace la timeline", () => {
    // Une promesse qui ne se résout jamais : le déchiffrement est « en cours », et c'est
    // exactement l'état que le skeleton doit rendre.
    render(<MediaMessage media={mediaDe(image())!} telecharger={() => new Promise<Blob>(() => {})} />);
    expect(screen.queryByAltText("plage.jpg")).toBeNull();
  });

  /**
   * La tuile n'est **pas** un `Button` d'Astryx.
   *
   * Celui-ci est un contrôle de formulaire à hauteur fixe — `--size-element-md`, 32 px —
   * avec son rembourrage horizontal, et la vignette de 240 px y était passée en enfant.
   * L'image débordait d'un cadre huit fois trop court, se posait par-dessus les messages
   * voisins, et l'alignement de la colonne partait avec elle : c'était le défaut visible
   * de l'envoi de photo.
   *
   * Ce que le test tient, c'est la **boîte**. jsdom ne calcule aucune géométrie, mais il
   * lit les styles déclarés, et ce sont eux qui étaient absents : une hauteur déclarée sur
   * la tuile est ce qui manquait pour que la photo cesse de déborder.
   */
  it("la tuile réserve la boîte de la vignette, au ratio de l'original", async () => {
    const portrait = mediaDe(
      evenement({
        msgtype: "m.image",
        body: "plage.jpg",
        file: FICHIER,
        info: { size: 2048, thumbnail_file: VIGNETTE, w: 1200, h: 1600 },
      }),
    )!;
    expect(portrait.largeur).toBe(1200);
    expect(portrait.hauteur).toBe(1600);

    // 240 × 1600 / 1200 = 320, qui est aussi le plafond : une photo en mode portrait ne
    // prend pas toute la hauteur de l'écran.
    const { container, unmount } = render(
      <MediaMessage media={portrait} telecharger={() => new Promise<Blob>(() => {})} />,
    );
    // StyleX passe ses valeurs dynamiques par des variables CSS en attribut `style` :
    // c'est l'attribut brut qu'on lit, `element.style.height` y est vide.
    expect(container.firstElementChild?.getAttribute("style")).toContain("320px");
    unmount();

    render(<MediaMessage media={portrait} telecharger={telecharger} />);
    await waitFor(() => expect(screen.getByAltText("plage.jpg")).toBeTruthy());

    // La même boîte une fois l'image arrivée : c'est ce partage qui fait que la timeline
    // ne saute pas au déchiffrement (DESIGN.md, « Skeleton de même géométrie »).
    const tuile = screen.getByRole("button", { name: "Image plage.jpg" });
    expect(tuile.style.width).toBe("240px");
    expect(tuile.style.height).toBe("320px");
    expect(tuile.style.overflow).toBe("hidden");
    // Et aucune hauteur de contrôle de formulaire n'est imposée à la photo.
    expect(tuile.style.padding).toBe("0px");
  });

  it("un média indéchiffrable le dit, sans repli inventé", async () => {
    render(
      <MediaMessage
        media={mediaDe(image())!}
        telecharger={vi.fn(async () => {
          throw new Error("hash refusé");
        })}
      />,
    );
    await waitFor(() => expect(screen.getByText(/n'a pas pu être déchiffré/)).toBeTruthy());
  });

  /**
   * **Le déchiffrement suit le blob, pas l'objet qui le décrit.**
   *
   * `mediaDe()` reconstruit un `Media` à chaque appel, et ses appelants l'appellent à
   * chaque rendu — le mémo de `Conversation` se recalcule à chaque tour de `/sync`, la
   * galerie appelle `mediaDe` dans son rendu. Tant que l'effet dépendait de l'objet, un
   * simple accusé de lecture relançait le téléchargement et le déchiffrement de chaque
   * vignette de la timeline.
   */
  it("un rendu de plus sur un média équivalent ne re-déchiffre rien", async () => {
    const { rerender } = render(<MediaMessage media={mediaDe(image())!} telecharger={telecharger} />);
    await waitFor(() => expect(screen.getByAltText("plage.jpg")).toBeTruthy());
    expect(telecharger).toHaveBeenCalledTimes(1);

    // Le même événement, relu : même contenu, même URL `mxc://`, objet différent.
    rerender(<MediaMessage media={mediaDe(image())!} telecharger={telecharger} />);
    rerender(<MediaMessage media={mediaDe(image())!} telecharger={telecharger} />);
    expect(telecharger).toHaveBeenCalledTimes(1);

    // Un autre blob, lui, se déchiffre : la mémoïsation ne fige pas le composant.
    const autre = mediaDe(
      evenement({
        msgtype: "m.image",
        body: "montagne.jpg",
        file: FICHIER,
        info: { thumbnail_file: { ...VIGNETTE, url: "mxc://tacita.test/vignette-2" } },
      }),
    )!;
    rerender(<MediaMessage media={autre} telecharger={telecharger} />);
    await waitFor(() => expect(telecharger).toHaveBeenCalledTimes(2));
  });

  /**
   * un fichier qui n'est ni photo ni vidéo n'ouvre aucun viewer : sans ce
   * bouton, ses octets étaient déchiffrables et pourtant inatteignables. Signalé tel quel
   * par les utilisateurs.
   */
  it("un fichier porte une sortie : le téléchargement sur l'appareil", () => {
    const fichier = mediaDe(
      evenement({ msgtype: "m.file", body: "contrat.pdf", file: FICHIER, info: { size: 1536 } }),
    )!;
    const onSauvegarder = vi.fn();
    render(<MediaMessage media={fichier} telecharger={telecharger} onSauvegarder={onSauvegarder} />);

    fireEvent.click(screen.getByRole("button", { name: "Télécharger" }));
    expect(onSauvegarder).toHaveBeenCalledTimes(1);
    // Le clic ne déchiffre pas ici : c'est le câblage qui possède le pipeline (M-E).
    expect(telecharger).not.toHaveBeenCalled();
  });

  it("un fichier rend son nom et sa taille, jamais une vignette", () => {
    const fichier = mediaDe(
      evenement({ msgtype: "m.file", body: "contrat.pdf", file: FICHIER, info: { size: 1536 } }),
    )!;
    render(<MediaMessage media={fichier} telecharger={telecharger} />);

    expect(screen.getByText("contrat.pdf")).toBeTruthy();
    expect(screen.getByText(tailleLisible(1536))).toBeTruthy();
    expect(telecharger).not.toHaveBeenCalled();
  });

  it("le vocal rend sa forme d'onde et sa durée", () => {
    render(<VoicePlayer dureeMs={9000} ondes={[0, 512, 1024, 256]} />);
    expect(screen.getByText(dureeLisible(9000))).toBeTruthy();
    expect(screen.getByRole("button", { name: "Lire le message vocal" })).toBeTruthy();
  });

  describe("le lecteur vocal, comme sur Instagram", () => {
    /** jsdom ne joue rien : `play` et `pause` sont des espions. */
    const lecteur = () => {
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      const { container } = render(
        <VoicePlayer source="blob:vocal" dureeMs={10_000} ondes={[0, 512, 1024, 256]} />,
      );
      const forme = container.querySelector<HTMLElement>("[data-forme-onde]")!;
      // jsdom ne met rien en page : la forme mesure 200 px à partir de x = 100.
      forme.getBoundingClientRect = () => ({ left: 100, width: 200 }) as DOMRect;
      const audio = container.querySelector("audio")!;
      return { play, pause, forme, audio };
    };
    const pointeur = (cible: HTMLElement, type: string, clientX: number) =>
      fireEvent(cible, new MouseEvent(type, { bubbles: true, clientX }));

    it("toucher le vocal n'importe où le lance, puis le met en pause", () => {
      const { play, pause } = lecteur();
      fireEvent.click(screen.getByText(dureeLisible(10_000)));
      expect(play).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByText(dureeLisible(10_000)));
      expect(pause).toHaveBeenCalledOnce();
    });

    it("le bouton bascule une seule fois, pas deux", () => {
      const { play, pause } = lecteur();
      fireEvent.click(screen.getByRole("button", { name: "Lire le message vocal" }));
      expect(play).toHaveBeenCalledOnce();
      expect(pause).not.toHaveBeenCalled();
    });

    it("glisser sur la forme d'onde choisit l'endroit, et la lecture reprend de là", () => {
      const { play, forme, audio } = lecteur();
      pointeur(forme, "pointerdown", 120);
      pointeur(forme, "pointermove", 250);
      pointeur(forme, "pointerup", 250);
      // Le clic qui suit le relâcher ne doit pas remettre en pause.
      fireEvent.click(forme);

      // 150 px sur 200 : les trois quarts de 10 s.
      expect(audio.currentTime).toBeCloseTo(7.5);
      expect(play).toHaveBeenCalledOnce();
    });

    it("la recherche ne déclenche pas les gestes de la bulle", () => {
      // La bulle tient ses gestes en props React (`useGlissement`) : c'est la
      // propagation React que la forme d'onde arrête.
      const surBulle = vi.fn();
      const { container } = render(
        <div onPointerDown={surBulle} onPointerUp={surBulle}>
          <VoicePlayer source="blob:vocal" dureeMs={10_000} ondes={[0, 512]} />
        </div>,
      );
      const forme = container.querySelector<HTMLElement>("[data-forme-onde]")!;
      pointeur(forme, "pointerdown", 120);
      pointeur(forme, "pointerup", 120);
      expect(surBulle).not.toHaveBeenCalled();
    });

    it("la vitesse fait défiler 1×, 1,5×, 2×, et s'applique à l'audio", () => {
      const { audio } = lecteur();
      // Avant lecture, pas de pastille : la question ne se pose pas encore.
      expect(screen.queryByRole("button", { name: /Vitesse/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Lire le message vocal" }));
      const vitesse = () => screen.getByRole("button", { name: /Vitesse/ });
      expect(vitesse().textContent).toBe("1×");

      fireEvent.click(vitesse());
      expect(vitesse().textContent).toBe("1,5×");
      expect(audio.playbackRate).toBe(1.5);

      fireEvent.click(vitesse());
      expect(vitesse().textContent).toBe("2×");
      fireEvent.click(vitesse());
      expect(vitesse().textContent).toBe("1×");
      // Changer de vitesse ne met pas en pause.
      expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    });
  });

  it("les tailles se lisent en unités binaires, comme dans l'OS", () => {
    expect(tailleLisible(512)).toBe("512 o");
    expect(tailleLisible(1536)).toBe("1.5 Ko");
    expect(tailleLisible(5 * 1024 * 1024)).toBe("5.0 Mo");
  });

  /**
   * **la vidéo est proposée partout**, depuis que le chemin rapide existe : une
   * source déjà conforme aux cibles se remuxe, ce qui ne demande aucun encodeur.
   *
   * Ce que ça déplace : l'échec devient un résultat, plus un prédicat. Le test qui vivait
   * ici vérifiait qu'une vidéo était **refusée d'avance** là où le navigateur n'encode
   * pas — ce refus était le contournement de l'absence de message d'échec, et c'est lui
   * qui disparaît, pas la garantie.
   */
  it("la vidéo est acceptée comme le reste, sans mesure préalable", () => {
    const onFichiers = vi.fn();
    render(<MediaPicker onFichiers={onFichiers} />);

    const champ = screen.getByLabelText("Joindre des fichiers") as HTMLInputElement;
    expect(champ.getAttribute("accept")).toContain("video/*");

    const video = new File(["x"], "clip.mp4", { type: "video/mp4" });
    const photo = new File(["y"], "photo.jpg", { type: "image/jpeg" });
    fireEvent.change(champ, { target: { files: [video, photo] } });

    expect(onFichiers).toHaveBeenCalledWith([video, photo]);
  });

  it("un échec de compression se dit, à sa place et avec sa phrase", () => {
    render(<MediaPicker onFichiers={vi.fn()} erreur="Impossible de compresser cette vidéo sur cet appareil." />);
    expect(screen.getByText(/Impossible de compresser cette vidéo/)).toBeTruthy();
  });

  it("pendant l'envoi, l'échec précédent ne reste pas affiché sous le nouveau", () => {
    render(<MediaPicker onFichiers={vi.fn()} enCours erreur="Impossible de compresser cette vidéo sur cet appareil." />);
    expect(screen.getByText("Envoi en cours…")).toBeTruthy();
    expect(screen.queryByText(/Impossible de compresser/)).toBeNull();
  });

  it("les dimensions cibles réduisent sans agrandir, et restent paires", () => {
    // H.264 encode par macroblocs : une dimension impaire est refusée par l'encodeur.
    expect(dimensionsCibles(1920, 1080, 720)).toEqual({ largeur: 1280, hauteur: 720 });
    expect(dimensionsCibles(1080, 1920, 720)).toEqual({ largeur: 406, hauteur: 720 });
    // Déjà plus petite que la cible : on ne remonte pas une vidéo, on la laisse.
    expect(dimensionsCibles(640, 480, 720)).toEqual({ largeur: 640, hauteur: 480 });
  });

  it("pendant l'envoi, un état et une annulation — pas une barre inventée", () => {
    const onAnnuler = vi.fn();
    render(<MediaPicker onFichiers={vi.fn()} enCours onAnnuler={onAnnuler} />);

    expect(screen.getByText("Envoi en cours…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Annuler l'envoi" }));
    expect(onAnnuler).toHaveBeenCalledTimes(1);
  });
});

describe("capture : « sur votre appareil » et « envoyé » ne se confondent pas", () => {
  const flux = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;

  beforeEach(() => {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => flux) },
    });
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
    HTMLCanvasElement.prototype.toBlob = function toBlob(rappel: BlobCallback) {
      rappel(new Blob(["photo"], { type: "image/jpeg" }));
    };
  });

  const prendre = async () => {
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Prendre la photo" }).hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Prendre la photo" }));
    await waitFor(() => expect(screen.getByAltText("Photo prise")).toBeTruthy());
  };

  it("les deux libellés sont distincts et explicites", async () => {
    render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
    await prendre();

    // l'original reste sur l'appareil, le correspondant reçoit une version
    // compressée. Les deux libellés le disent, chacun le sien.
    expect(screen.getByRole("button", { name: /Enregistrer sur votre appareil \(original\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Envoyer \(version compressée\)/ })).toBeTruthy();
  });

  it("enregistrer ne déclenche pas l'envoi, et inversement", async () => {
    const onEnregistrer = vi.fn();
    const onEnvoyer = vi.fn();
    render(
      <PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={onEnregistrer} onEnvoyer={onEnvoyer} />,
    );
    await prendre();

    fireEvent.click(screen.getByRole("button", { name: /Enregistrer sur votre appareil/ }));
    await waitFor(() => expect(onEnregistrer).toHaveBeenCalledTimes(1));
    expect(onEnvoyer).not.toHaveBeenCalled();
  });

  /**
   * La prise ne survit pas à la fermeture.
   *
   * `<dialog>` garde son contenu dans le DOM même fermé, et rien ne remettait `prise` à
   * zéro : la feuille rouverte affichait la photo précédente à la place de la caméra. Une
   * photo au premier plan d'un écran censé en prendre une nouvelle, dont le seul moyen de
   * sortir était de recharger la page.
   */
  it("un écran rouvert montre la caméra, jamais la photo d'avant", async () => {
    const { rerender } = render(
      <PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />,
    );
    await prendre();

    rerender(
      <PhotoCapture
        ouvert={false}
        onFermer={vi.fn()}
        onEnregistrer={vi.fn()}
        onEnvoyer={vi.fn()}
      />,
    );
    rerender(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);

    expect(screen.queryByAltText("Photo prise")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Aperçu de la caméra")).toBeTruthy());
  });

  it("la même prise part sous le même nom qu'elle est enregistrée", async () => {
    const onEnregistrer = vi.fn();
    const onEnvoyer = vi.fn();
    render(
      <PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={onEnregistrer} onEnvoyer={onEnvoyer} />,
    );
    await prendre();

    fireEvent.click(screen.getByRole("button", { name: /Enregistrer sur votre appareil/ }));
    fireEvent.click(screen.getByRole("button", { name: /Envoyer \(version compressée\)/ }));

    // Le nom était recalculé à chaque rendu depuis l'horloge : une seconde entre les deux
    // clics suffisait à donner deux noms à une seule photo.
    await waitFor(() => expect(onEnvoyer).toHaveBeenCalled());
    expect(onEnregistrer.mock.calls[0]![1]).toBe(onEnvoyer.mock.calls[0]![0].name);
  });

  it("demande une vraie définition, et retourne la caméra en éteignant l'autre", async () => {
    const pistes = [{ stop: vi.fn() }, { stop: vi.fn() }];
    let appel = 0;
    const getUserMedia = vi.fn(
      async (_contraintes: MediaStreamConstraints) =>
        ({ getTracks: () => [pistes[appel++]!] }) as unknown as MediaStream,
    );
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    // Sans contrainte de taille, Safari rend 640 × 480.
    expect(getUserMedia.mock.calls[0]![0]).toMatchObject({
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Passer à la caméra avant" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(getUserMedia.mock.calls[1]![0]).toMatchObject({ video: { facingMode: "user" } });
    // La caméra arrière s'est éteinte avant que l'avant ne s'allume.
    expect(pistes[0]!.stop).toHaveBeenCalled();
    expect(screen.getByLabelText("Aperçu de la caméra").style.transform).toBe("scaleX(-1)");
  });

  it("après « Reprendre », l'aperçu retrouve le flux de la caméra", async () => {
    render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
    await prendre();
    fireEvent.click(screen.getByRole("button", { name: "Reprendre" }));

    const apercu = (await screen.findByLabelText("Aperçu de la caméra")) as HTMLVideoElement;
    expect(apercu.srcObject).toBe(flux);
  });

  it("Échap rend la main au parent, qui tient l'ouverture", async () => {
    const onFermer = vi.fn();
    render(<PhotoCapture ouvert onFermer={onFermer} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
    fireEvent(screen.getByRole("dialog", { name: "Prendre une photo", hidden: true }), new Event("cancel", { cancelable: true }));
    expect(onFermer).toHaveBeenCalledOnce();
  });

  describe("maintenir le déclencheur filme", () => {
    /** Un enregistreur qui rend un film d'un morceau quand on l'arrête. */
    class FauxEnregistreur {
      static isTypeSupported = (format: string) => format.startsWith("video/mp4");
      static instances: FauxEnregistreur[] = [];
      state = "inactive";
      mimeType: string;
      ondataavailable: ((evenement: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(
        public flux: unknown,
        options: { mimeType: string },
      ) {
        this.mimeType = options.mimeType;
        FauxEnregistreur.instances.push(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["film"], { type: "video/mp4" }) });
        this.onstop?.();
      }
    }

    let pisteVideo: {
      stop: ReturnType<typeof vi.fn>;
      getCapabilities: () => unknown;
      applyConstraints: ReturnType<typeof vi.fn>;
    };
    const pisteAudio = { stop: vi.fn() };
    let getUserMedia: ReturnType<typeof vi.fn>;
    /** Le flux rendu par le dernier appel réussi : c'est lui que l'enregistreur doit recevoir. */
    let dernierFlux: unknown;

    const fluxDe = (contraintes: MediaStreamConstraints) => {
      const pistes = contraintes.audio ? [pisteVideo, pisteAudio] : [pisteVideo];
      dernierFlux = {
        getTracks: () => pistes,
        getVideoTracks: () => [pisteVideo],
        getAudioTracks: () => (contraintes.audio ? [pisteAudio] : []),
      };
      return dernierFlux;
    };

    beforeEach(() => {
      FauxEnregistreur.instances = [];
      FauxEnregistreur.isTypeSupported = (format: string) => format.startsWith("video/mp4");
      vi.stubGlobal("MediaRecorder", FauxEnregistreur);
      vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
      pisteVideo = { stop: vi.fn(), getCapabilities: () => ({}), applyConstraints: vi.fn(async () => {}) };
      getUserMedia = vi.fn(async (contraintes: MediaStreamConstraints) => fluxDe(contraintes));
      Object.defineProperty(globalThis.navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia },
      });
    });

    afterEach(() => vi.unstubAllGlobals());

    const declencheur = () => screen.getByRole("button", { name: "Prendre la photo" });
    const pointeur = (type: string, clientY = 500) =>
      fireEvent(declencheur(), new MouseEvent(type, { bubbles: true, clientY }));
    const attendreFlux = () =>
      waitFor(() => expect(declencheur().hasAttribute("disabled")).toBe(false));

    it("caméra et micro sont demandés ensemble, dès l'ouverture", async () => {
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await attendreFlux();
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(getUserMedia.mock.calls[0]![0]).toMatchObject({ video: { facingMode: "environment" }, audio: true });
    });

    it("micro refusé, la caméra s'ouvre seule — et le film sera muet", async () => {
      getUserMedia.mockImplementation(async (contraintes: MediaStreamConstraints) =>
        contraintes.audio ? Promise.reject(new Error("micro refusé")) : fluxDe(contraintes),
      );
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await attendreFlux();

      expect(getUserMedia).toHaveBeenCalledTimes(2);
      expect(getUserMedia.mock.calls[1]![0]).not.toHaveProperty("audio");
      expect(screen.queryByText(/accès à la caméra a été refusé/)).toBeNull();
    });

    it("maintenu, il filme le flux de la caméra ; relâché, la vidéo part en MP4", async () => {
      const onEnvoyer = vi.fn();
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={onEnvoyer} />);
      await attendreFlux();

      pointeur("pointerdown");
      // Le temps écoulé s'affiche : le film tourne.
      expect(await screen.findByText("0:00", undefined, { timeout: 1000 })).toBeTruthy();
      const enregistreur = FauxEnregistreur.instances[0]!;
      expect(enregistreur.mimeType).toMatch(/^video\/mp4/);
      // Image et son, du même flux : celui ouvert avec la caméra.
      expect(enregistreur.flux).toBe(dernierFlux);

      pointeur("pointerup");
      expect(await screen.findByLabelText("Vidéo filmée")).toBeTruthy();
      // Pas de texte sur une vidéo.
      expect(screen.queryByRole("button", { name: "Ajouter du texte" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Envoyer \(version compressée\)/ }));
      await waitFor(() => expect(onEnvoyer).toHaveBeenCalled());
      const fichier = onEnvoyer.mock.calls[0]![0] as File;
      expect(fichier.type).toBe("video/mp4");
      expect(fichier.name).toMatch(/^video-.*\.mp4$/);
    });

    it("glisser vers le haut zoome, et le relâcher revient au plan large", async () => {
      pisteVideo.getCapabilities = () => ({ zoom: { min: 1, max: 5 } });
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await attendreFlux();

      pointeur("pointerdown", 500);
      await screen.findByText("0:00", undefined, { timeout: 1000 });
      // 150 px sur une course de 300 : la moitié du chemin de 1× à 5×.
      pointeur("pointermove", 350);
      await waitFor(() =>
        expect(pisteVideo.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 3 }] }),
      );
      expect(screen.getByText("0:00 · 3,0×")).toBeTruthy();

      pointeur("pointerup", 350);
      await waitFor(() =>
        expect(pisteVideo.applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 1 }] }),
      );
    });

    it("sans zoom exposé par la caméra, glisser ne fait rien", async () => {
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await attendreFlux();
      pointeur("pointerdown", 500);
      await screen.findByText("0:00", undefined, { timeout: 1000 });
      pointeur("pointermove", 200);
      expect(pisteVideo.applyConstraints).not.toHaveBeenCalled();
      pointeur("pointerup", 200);
    });

    it("touché sans maintien, il photographie et ne filme pas", async () => {
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await attendreFlux();

      pointeur("pointerdown");
      pointeur("pointerup");
      fireEvent.click(declencheur());

      expect(await screen.findByAltText("Photo prise")).toBeTruthy();
      await new Promise((attendre) => setTimeout(attendre, 300));
      expect(FauxEnregistreur.instances).toHaveLength(0);
    });

    it("sans enregistrement MP4 possible, le maintien ne filme pas", async () => {
      FauxEnregistreur.isTypeSupported = () => false;
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await attendreFlux();

      pointeur("pointerdown");
      await new Promise((attendre) => setTimeout(attendre, 300));
      expect(FauxEnregistreur.instances).toHaveLength(0);
      pointeur("pointerup");
    });
  });

  describe("texte sur la photo", () => {
    /** Le dialogue mesure 500 × 1000 à l'écran : jsdom ne met rien en page. */
    const mesurer = () => {
      const boite = screen.getByRole("dialog", { name: "Prendre une photo", hidden: true });
      Object.defineProperty(boite, "clientWidth", { configurable: true, value: 500 });
      Object.defineProperty(boite, "clientHeight", { configurable: true, value: 1000 });
    };
    const ecrire = async (valeur: string) => {
      fireEvent.change(await screen.findByLabelText("Texte à poser sur la photo"), {
        target: { value: valeur },
      });
      fireEvent.click(screen.getByRole("button", { name: "Terminé" }));
    };
    const pointeur = (cible: HTMLElement, type: string, clientX: number, clientY: number) =>
      fireEvent(cible, new MouseEvent(type, { bubbles: true, clientX, clientY }));

    it("le texte saisi se pose sur la photo, et se rouvre d'un toucher", async () => {
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await prendre();

      fireEvent.click(screen.getByRole("button", { name: "Ajouter du texte" }));
      await ecrire("on est là");
      const texte = screen.getByLabelText("Texte sur la photo : on est là");
      expect(screen.getByRole("button", { name: "Modifier le texte" })).toBeTruthy();

      pointeur(texte, "pointerdown", 100, 100);
      pointeur(texte, "pointerup", 100, 100);
      expect((await screen.findByLabelText("Texte à poser sur la photo")) as HTMLTextAreaElement).toHaveProperty(
        "value",
        "on est là",
      );
    });

    it("un texte vide ne pose rien", async () => {
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await prendre();
      fireEvent.click(screen.getByRole("button", { name: "Ajouter du texte" }));
      await ecrire("   ");
      expect(screen.queryByLabelText(/Texte sur la photo/)).toBeNull();
    });

    it("le texte se déplace au doigt, en fractions de l'écran", async () => {
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
      await prendre();
      mesurer();
      fireEvent.click(screen.getByRole("button", { name: "Ajouter du texte" }));
      await ecrire("salut");

      const texte = screen.getByLabelText("Texte sur la photo : salut");
      pointeur(texte, "pointerdown", 100, 100);
      pointeur(texte, "pointermove", 200, 100);
      pointeur(texte, "pointerup", 200, 100);
      // 100 px sur 500 : du centre (50 %) à 70 %.
      expect(screen.getByLabelText("Texte sur la photo : salut").style.left).toBe("70%");
      // Un glissement n'est pas un toucher : la saisie ne s'est pas rouverte.
      expect(screen.queryByLabelText("Texte à poser sur la photo")).toBeNull();
    });

    it("le texte entre dans l'image envoyée, là et à la taille où on l'a vu", async () => {
      const fillText = vi.fn();
      HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
        drawImage: vi.fn(),
        fillText,
        measureText: (valeur: string) => ({ width: valeur.length * 10 }),
      })) as never;
      // L'image prise fait 1000 × 2000 : deux fois l'écran, dans les deux sens.
      vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1000, height: 2000 })));
      const onEnvoyer = vi.fn();
      render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={onEnvoyer} />);
      await prendre();
      mesurer();
      fireEvent.click(screen.getByRole("button", { name: "Ajouter du texte" }));
      await ecrire("salut");

      fireEvent.click(screen.getByRole("button", { name: /Envoyer \(version compressée\)/ }));
      await waitFor(() => expect(onEnvoyer).toHaveBeenCalled());
      // Centre à (50 %, 40 %) de l'écran 500 × 1000, soit (500, 800) dans l'image.
      expect(fillText).toHaveBeenCalledWith("salut", 500, 800);
      const contexte = vi.mocked(HTMLCanvasElement.prototype.getContext).mock.results.at(-1)!.value as {
        font: string;
      };
      // 28 px à l'écran, une échelle de 2 : 56 px dans l'image.
      expect(contexte.font).toMatch(/^700 56px /);
      vi.unstubAllGlobals();
    });
  });

  it("sans API caméra, l'écran le dit — et ne renvoie pas vers un réglage inexistant", async () => {
    // Hors contexte sécurisé, `mediaDevices` est absent. L'optionnel court-circuitait
    // toute la chaîne : ni flux, ni erreur, un bouton désactivé et pas un mot.
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/ne donne pas accès à la caméra/)).toBeTruthy());
    // Deux causes, deux phrases : celle-ci ne se rattrape pas dans les réglages.
    expect(screen.queryByText(/réglages de votre navigateur/)).toBeNull();
  });

  it("un refus de caméra s'explique et se rattrape", async () => {
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => Promise.reject(new Error("refus"))) },
    });

    render(<PhotoCapture ouvert onFermer={vi.fn()} onEnregistrer={vi.fn()} onEnvoyer={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/accès à la caméra a été refusé/)).toBeTruthy());
    expect(screen.getByText(/réglages de votre navigateur/)).toBeTruthy();
  });
});

describe("viewer plein écran : navigation, sauvegarde, fermeture", () => {
  const medias: Media[] = [
    mediaDe(image("$a"))!,
    { ...mediaDe(image("$b"))!, nom: "montagne.jpg" },
  ];

  const rendre = (props: Partial<Parameters<typeof MediaViewer>[0]> = {}) => {
    const actions = {
      medias,
      depart: 0,
      telecharger,
      onFermer: vi.fn(),
      onSauvegarder: vi.fn(),
      ...props,
    };
    render(<MediaViewer {...actions} />);
    return actions;
  };

  it("`Escape` ferme, comme toute modale — le geste n'est pas le seul chemin", () => {
    // Une modale plein écran qu'aucune touche ne referme est un piège au clavier.
    // Mesuré au navigateur : le viewer ne se fermait qu'au glissement
    // vers le bas et au bouton — `Escape` ne faisait rien.
    const { onFermer } = rendre();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onFermer).toHaveBeenCalled();
  });

  it("navigue entre les médias du salon", async () => {
    rendre();
    expect(screen.getByText("1 / 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Suivant" }));
    await waitFor(() => expect(screen.getByText("2 / 2")).toBeTruthy());
  });

  it("le média entier n'est déchiffré qu'ici, pas dans la timeline", async () => {
    rendre();
    await waitFor(() => expect(telecharger).toHaveBeenCalledWith(medias[0]!.fichier, "image/jpeg"));
  });

  it("sauvegarde le média affiché", () => {
    const { onSauvegarder } = rendre();
    fireEvent.click(screen.getByRole("button", { name: "Sauvegarder" }));
    expect(onSauvegarder).toHaveBeenCalledWith(medias[0]);
  });

  /**
   * **Les commandes du viewer n'étaient pas absentes : elles étaient invisibles.**
   *
   * Le fond venait de `--color-background-inverted` d'Astryx, qui vaut exactement `text` —
   * la couleur d'encre que ses boutons ghost posent dessus. « Fermer » répondait au clic
   * et ne se voyait pas ; les retours d'usage disaient « on ne peut pas fermer une photo ».
   *
   * jsdom ne calcule aucune couleur : ce test lit la **déclaration**, pas le rendu. Il ne
   * prouve pas le contraste (c'est `theme.test.ts` qui tient la paire de DESIGN.md) ; il
   * empêche la ligne qui le porte de disparaître sans que personne ne le voie.
   */
  it("le viewer pose son fond et son encre, au lieu d'hériter de ceux du thème", () => {
    rendre();
    const style = screen.getByRole("dialog").getAttribute("style") ?? "";

    expect(style).toContain("var(--tacita-viewer)");
    // Le fond inversé d'Astryx suit le thème *et* vaut l'encre : les deux raisons pour
    // lesquelles il n'a rien à faire ici.
    expect(style).not.toContain("--color-background-inverted");
    // L'encre est remappée dans la portée du viewer, ce qui couvre tous ses enfants
    // Astryx — y compris ceux qu'on y ajoutera.
    for (const token of ["--color-text-primary", "--color-icon-primary", "--color-text-disabled"]) {
      expect(style, token).toContain(`${token}: var(--tacita-sur-viewer`);
    }
  });

  /**
   * Le pendant de « un rendu de plus ne re-déchiffre rien », là où il coûtait
   * le plus cher : `Conversation` reconstruit ses `Media` à chaque tour de `/sync`, et la
   * vidéo ouverte était re-téléchargée et re-déchiffrée **pendant sa lecture**, qui
   * repartait de zéro à chaque fois. C'est le « on déchiffre 2 secondes par 2 secondes »
   * des retours d'usage.
   */
  it("un rafraîchissement de la conversation ne re-déchiffre pas le média ouvert", async () => {
    const { rerender } = render(
      <MediaViewer
        medias={medias}
        depart={0}
        telecharger={telecharger}
        onFermer={vi.fn()}
        onSauvegarder={vi.fn()}
      />,
    );
    await waitFor(() => expect(telecharger).toHaveBeenCalledTimes(1));

    // Les mêmes médias, relus de leurs événements : même contenu, autres objets.
    rerender(
      <MediaViewer
        medias={[mediaDe(image("$a"))!, { ...mediaDe(image("$b"))!, nom: "montagne.jpg" }]}
        depart={0}
        telecharger={telecharger}
        onFermer={vi.fn()}
        onSauvegarder={vi.fn()}
      />,
    );
    expect(telecharger).toHaveBeenCalledTimes(1);
  });

  /**
   * Un blob `application/octet-stream` ne dit pas au lecteur quel conteneur il ouvre :
   * `downloadAttachment` rend des octets nus, et le type du blob est le seul indice qui
   * reste. Le pipeline écrit `info.mimetype` — il suffisait de le lire.
   */
  it("le blob de la vidéo part avec le type déclaré dans l'événement", async () => {
    const video = mediaDe(
      evenement({
        msgtype: "m.video",
        body: "sortie.mp4",
        file: FICHIER,
        info: { mimetype: "video/mp4", thumbnail_file: VIGNETTE, duration: 4000 },
      }),
    )!;
    expect(video.mime).toBe("video/mp4");

    render(
      <MediaViewer
        medias={[video]}
        depart={0}
        telecharger={telecharger}
        onFermer={vi.fn()}
        onSauvegarder={vi.fn()}
      />,
    );
    await waitFor(() => expect(telecharger).toHaveBeenCalledWith(video.fichier, "video/mp4"));
  });

  it("un glissement vers le bas ferme", () => {
    const { onFermer } = rendre();
    const vue = screen.getByRole("dialog");
    fireEvent(vue, new MouseEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100 }));
    fireEvent(vue, new MouseEvent("pointerup", { bubbles: true, clientX: 100, clientY: 300 }));
    expect(onFermer).toHaveBeenCalledTimes(1);
  });
});

describe("galeries partagées : quatre onglets, périmètre honnête", () => {
  const evenements: EvenementLu[] = [
    image("$img"),
    evenement({ msgtype: "m.file", body: "contrat.pdf", file: FICHIER, info: { size: 10 } }, "$fic"),
    evenement({ msgtype: "m.audio", body: "vocal.ogg", file: FICHIER, info: { duration: 3000 } }, "$voc"),
    evenement({ msgtype: "m.text", body: "regarde https://tacita.test/doc" }, "$lien"),
    evenement({ msgtype: "m.text", body: "juste du texte" }, "$txt"),
  ];

  it("répartit un jeu d'événements mixtes dans les quatre onglets", () => {
    const reparti = repartir(evenements, ["$txt"]);

    expect(reparti.medias.map((e) => e.getId())).toEqual(["$img"]);
    // Un vocal est un fichier : il n'a pas de vignette et n'a rien à faire dans une grille.
    expect(reparti.fichiers.map((e) => e.getId())).toEqual(["$fic", "$voc"]);
    expect(reparti.liens.map((e) => e.getId())).toEqual(["$lien"]);
    expect(reparti.epingles.map((e) => e.getId())).toEqual(["$txt"]);
  });

  it("une URL dans un texte va dans Liens ; une phrase sans URL n'y va pas", () => {
    expect(liensDe(evenements[3]!)).toEqual(["https://tacita.test/doc"]);
    expect(liensDe(evenements[4]!)).toEqual([]);
    // `www.` n'est pas deviné : un faux positif transformerait une phrase en lien.
    expect(liensDe(evenement({ msgtype: "m.text", body: "va sur www.tacita.test" }))).toEqual([]);
  });

  it("le périmètre est affiché, pas sous-entendu", () => {
    render(
      <ConversationCollections evenements={evenements} epingles={[]} telecharger={telecharger} />,
    );
    expect(screen.getByText(/historique téléchargé sur cet appareil/)).toBeTruthy();
  });

  it("l'onglet Épinglés porte la mention de non-chiffrement", () => {
    render(
      <ConversationCollections evenements={evenements} epingles={["$txt"]} telecharger={telecharger} />,
    );
    fireEvent.click(screen.getByText("Épinglés"));
    expect(screen.getByText(/n'est pas chiffrée : le serveur la voit/)).toBeTruthy();
  });

  it("un onglet vide rend un Placeholder, jamais un écran nu", () => {
    render(<ConversationCollections evenements={[]} epingles={[]} telecharger={telecharger} />);
    expect(screen.getByText(/Aucune photo ni vidéo/)).toBeTruthy();
  });

  /**
   * la planche contact : trois carrés par ligne, comme Instagram.
   *
   * Les médias sortaient en **liste verticale de tuiles au ratio de leur original** — la
   * géométrie de la timeline, où une photo est un message et garde le cadrage de son
   * auteur. Dans une galerie elle devient une planche contact, et trois cadrages
   * différents par ligne donnent une grille en dents de scie qu'on ne balaie plus.
   *
   * jsdom ne calcule aucune grille ; ce sont les styles **déclarés** qu'on lit, et c'est
   * bien eux qui manquaient.
   */
  it("les médias se pavent en trois carrés par ligne ; le texte reste en liste", async () => {
    const { container } = render(
      <ConversationCollections evenements={evenements} epingles={["$txt"]} telecharger={telecharger} />,
    );

    const grille = container.querySelector("ul") as HTMLElement;
    expect(grille.style.gridTemplateColumns).toBe("repeat(3, 1fr)");

    // La cellule commande, et elle est carrée : ni largeur de 240 px, ni ratio d'origine.
    await waitFor(() => expect(screen.getByAltText("plage.jpg")).toBeTruthy());
    const tuile = screen.getByRole("button", { name: "Image plage.jpg" });
    expect(tuile.style.aspectRatio).toBe("1 / 1");
    expect(tuile.style.width).toBe("100%");
    expect(tuile.style.overflow).toBe("hidden");
    // Le pavage fait la planche contact : douze coins ronds par écran la dissolvent.
    expect(tuile.style.borderRadius).toBe("0");

    // Les onglets de texte gardent la liste : une ligne de lien n'est pas une vignette.
    fireEvent.click(screen.getByText("Épinglés"));
    expect((container.querySelector("ul") as HTMLElement).style.gridTemplateColumns).toBe("");
  });

  it("les quatre onglets sont ceux du wireframe, dans l'ordre", () => {
    render(<ConversationCollections evenements={[]} epingles={[]} telecharger={telecharger} />);
    const section = within(screen.getByLabelText("Contenus partagés"));
    for (const libelle of ["Médias", "Épinglés", "Liens", "Fichiers"]) {
      expect(section.getByText(libelle)).toBeTruthy();
    }
  });
});

/**
 * **la liste close, côté écran.**
 *
 * La résolution elle-même est prouvée dans le paquet (`types-rendus.test.ts`, entrées
 * hostiles comprises). Ce qui se prouve ici, c'est ce que le viewer en fait : rien de
 * hors liste ne descend, rien de non identifié ne s'affiche, et aucun lecteur vide.
 */
describe("le viewer refuse de rendre ce qui n'est pas dans la liste close", () => {
  const mediaDeType = (mimetype: string | undefined, msgtype = "m.image") =>
    mediaDe(
      evenement({
        msgtype,
        body: "piece-jointe",
        file: FICHIER,
        info: { ...(mimetype === undefined ? {} : { mimetype }), thumbnail_file: VIGNETTE },
      }),
    )!;

  const ouvrir = (media: Media, telechargement = telecharger) => {
    const onSauvegarder = vi.fn();
    render(
      <MediaViewer
        medias={[media]}
        depart={0}
        telecharger={telechargement}
        onFermer={vi.fn()}
        onSauvegarder={onSauvegarder}
      />,
    );
    return onSauvegarder;
  };

  it("un type déclaré hostile n'est ni rendu ni même téléchargé", async () => {
    const onSauvegarder = ouvrir(mediaDeType("image/svg+xml"));

    await waitFor(() => expect(screen.getByText(/n'affiche pas ce format/)).toBeTruthy());
    expect(screen.queryByAltText("piece-jointe")).toBeNull();
    // Le refus tombe **avant** le réseau : rien n'est descendu, rien n'a été déchiffré.
    expect(telecharger).not.toHaveBeenCalled();

    // Le fichier reste récupérable — ce qui est refusé, c'est de le rendre.
    fireEvent.click(screen.getByRole("button", { name: "Télécharger" }));
    expect(onSauvegarder).toHaveBeenCalledTimes(1);
  });

  it("sans type déclaré, les octets du clair tranchent", async () => {
    // Un JPEG véritable : la signature est dans les octets, pas dans l'événement.
    const jpeg = vi.fn(async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...Array<number>(16).fill(0)])]));
    ouvrir(mediaDeType(undefined), jpeg);

    await waitFor(() => expect(screen.getByAltText("piece-jointe")).toBeTruthy());
    // Descendu sans type — c'est le reniflement qui le lui donne ensuite.
    expect(jpeg).toHaveBeenCalledWith(FICHIER, undefined);
  });

  it("des octets qu'on ne sait pas identifier donnent un état explicite, jamais un lecteur muet", async () => {
    const bruit = vi.fn(async () => new Blob([new Uint8Array(Array<number>(32).fill(7))]));
    ouvrir(mediaDeType(undefined), bruit);

    await waitFor(() => expect(screen.getByText(/n'a pas pu être identifié/)).toBeTruthy());
    expect(screen.queryByAltText("piece-jointe")).toBeNull();
  });

  it("un codec que ce navigateur ne lit pas se dit, au lieu d'un rectangle noir", async () => {
    // jsdom rend `""` pour tout : c'est exactement le « non » de `canPlayType`, et c'est
    // le cas du HEVC d'iOS sur Chrome de bureau.
    ouvrir(mediaDeType("video/mp4", "m.video"));

    await waitFor(() => expect(screen.getByText(/ne sait pas lire cette vidéo/)).toBeTruthy());
    expect(document.querySelector("video")).toBeNull();
  });

  it("un codec lisible rend le lecteur", async () => {
    const canPlayType = vi
      .spyOn(HTMLMediaElement.prototype, "canPlayType")
      .mockReturnValue("maybe");
    ouvrir(mediaDeType("video/mp4", "m.video"));

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(canPlayType).toHaveBeenCalledWith("video/mp4");
    canPlayType.mockRestore();
  });

  /**
   * Le verrou de dernier recours, celui qui tient les appelants qu'on n'a pas encore
   * écrits : le Blob se fabrique à un seul endroit, et ce type-là ne s'y invente pas.
   * jsdom ne fait pas descendre de session — c'est la source qui est lue, comme partout
   * ailleurs où la valeur compte plus que le rendu (règle 7).
   */
  it("le type d'un Blob ne peut pas sortir de la liste close, quel que soit l'appelant", () => {
    const source = lire("components/media/useMediaActions.ts");
    expect(source).toContain("estRendable(mimeType) ? mimeType : \"application/octet-stream\"");
  });
});

/**
 * **les plafonds, côté écran.**
 *
 * La décision est prouvée pure dans le paquet (table de vérité, et le déchiffrement par
 * tranches avec elle). Ce qui se prouve ici, c'est qu'aucun octet ne descend quand la
 * taille l'interdit — la garde ne sert à rien si l'écran la contourne.
 */
describe("au-delà du plafond, pas de lecteur", () => {
  const lourd = (octets: number) =>
    mediaDe(
      evenement({
        msgtype: "m.video",
        body: "vacances.mp4",
        file: FICHIER,
        info: { mimetype: "video/mp4", size: octets, thumbnail_file: VIGNETTE },
      }),
    )!;

  const ouvrir = (media: Media) => {
    const onSauvegarder = vi.fn();
    render(
      <MediaViewer
        medias={[media]}
        depart={0}
        telecharger={telecharger}
        onFermer={vi.fn()}
        onSauvegarder={onSauvegarder}
      />,
    );
    return onSauvegarder;
  };

  // jsdom n'expose ni `deviceMemory` ni `showSaveFilePicker` : c'est le profil de bureau
  // sans flux d'écriture, donc les deux plafonds s'appliquent — le cas le plus strict.
  it("au-delà du premier plafond : pas de lecteur, un poids affiché, et rien n'est descendu", async () => {
    const onSauvegarder = ouvrir(lourd(120 * 1024 * 1024));

    await waitFor(() => expect(screen.getByText(/trop lourd pour être lu/)).toBeTruthy());
    expect(telecharger).not.toHaveBeenCalled();
    expect(document.querySelector("video")).toBeNull();

    // Le poids est dans le libellé : « télécharger 120 Mo » et « télécharger » ne
    // demandent pas la même décision, surtout en mobilité.
    fireEvent.click(screen.getByRole("button", { name: `Télécharger (${tailleLisible(120 * 1024 * 1024)})` }));
    expect(onSauvegarder).toHaveBeenCalledTimes(1);
  });

  it("« ouvrir quand même » existe sous le plafond dur, et lance le déchiffrement", async () => {
    ouvrir(lourd(120 * 1024 * 1024));
    await waitFor(() => expect(screen.getByText(/trop lourd pour être lu/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Ouvrir quand même" }));
    await waitFor(() => expect(telecharger).toHaveBeenCalledWith(FICHIER, "video/mp4"));
  });

  it("au-delà du plafond dur sans flux, plus rien n'est proposé — et on dit pourquoi", async () => {
    ouvrir(lourd(500 * 1024 * 1024));

    await waitFor(() => expect(screen.getByText(/trop lourd pour cet appareil/)).toBeTruthy());
    expect(screen.getByText(/plus de mémoire/)).toBeTruthy();
    // Ni lecteur, ni téléchargement : le clair ne tiendrait pas en mémoire, et le
    // proposer serait promettre ce que l'appareil ne peut pas tenir.
    expect(screen.queryByRole("button", { name: /Télécharger/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ouvrir quand même" })).toBeNull();
    expect(telecharger).not.toHaveBeenCalled();
  });

  it("sous le plafond, rien ne change : le média s'ouvre comme avant", async () => {
    const canPlayType = vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
    ouvrir(lourd(2 * 1024 * 1024));

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    canPlayType.mockRestore();
  });

  /**
   * Le chemin d'écriture, qui ne se rend pas : `sauvegarder` doit passer par le
   * téléchargement **par tranches** quand la plateforme l'expose, sinon le plafond dur ne
   * protège rien — c'est le repli d'un seul bloc qu'il borne (règle 7).
   */
  it("la sauvegarde emprunte le flux quand il existe, le bloc unique sinon", () => {
    const source = lire("components/media/useMediaActions.ts");
    expect(source).toContain("env.ouvrirEcriture");
    expect(source).toContain("downloadAttachmentToFile(session, env, media.fichier, media.nom)");
    expect(source).toContain("saveOriginal(env, blob, media.nom)");
  });
});

/**
 * **la refonte du transcodage, par ce que jsdom peut en dire.**
 *
 * Le chemin nominal demande `WebCodecs`, que jsdom n'a pas : ce qui se mesure vraiment —
 * 1080p de 3 min sous 30 s, aucun long task, mémoire stable — se mesure au navigateur et
 * se consigne avec sa date. Ce que ces tests tiennent, c'est que les lignes qui portent
 * ces propriétés ne disparaissent pas en silence (règle 7).
 */
describe("le transcodage ne rejoue plus la vidéo pour la lire", () => {
  // Commentaires retirés, comme partout ailleurs : « les interdits portent sur ce que le
  // shard exécute, pas sur ce qu'il explique » — et ce fichier explique longuement ce
  // qu'il ne fait plus.
  const source = sansCommentaires(lire("lib/transcode-video.ts"));

  it("plus de lecteur pour cadencer la lecture", () => {
    // Les deux lignes qui coûtaient « trois minutes pour trois minutes » : c'est le
    // **lecteur** qui les coûtait, en imposant la vitesse de lecture au décodage.
    expect(source).not.toContain("createElement(\"video\")");
    expect(source).not.toContain("requestVideoFrameCallback");
    // Les deux images sont refermées : une `VideoFrame` oubliée par image fait tomber
    // l'onglet sur une vidéo un peu longue.
    expect(source).toContain("image.close()");
    expect(source).toContain("reduite.close()");
  });

  it("la réduction produit vraiment la taille demandée, elle ne se contente pas de la déclarer", () => {
    /*
     * **Le défaut, tenu par ce test.** La version précédente écrivait
     * `new VideoFrame(image, { displayWidth: largeur, displayHeight: hauteur })` et
     * l'appelait « scaler natif ». Il n'en existe pas : ces deux champs sont des
     * métadonnées d'affichage, ils ne rééchantillonnent rien. On remettait donc des images
     * 1080p à un encodeur configuré en 720p, et ce que WebCodecs dit de ce cas est : rien.
     * Chrome redimensionnait en silence, d'autres moteurs refusaient la frame — et l'échec
     * remontait sous une phrase parlant de compression.
     *
     * Ce que la ligne doit dire, et que jsdom ne peut pas exécuter (règle 7) : les pixels
     * passent par une mise à l'échelle explicite avant l'encodeur.
     */
    expect(source).not.toContain("displayWidth: largeur");
    expect(source).toContain("pinceau.drawImage(image, 0, 0, largeur, hauteur)");
    expect(source).toContain("new VideoFrame(toile, { timestamp: horodatage");
    // Et le chemin sans réduction ne paie pas la toile : il encode la frame telle quelle.
    expect(source).toContain("if (largeur === source.largeur && hauteur === source.hauteur)");
  });

  it("la vignette sort du décodeur, sur les deux chemins qui décodent", () => {
    /*
     * le poster était pris en rejouant le fichier dans un `<video>` sur le
     * thread principal : le plus faible des trois mécanismes, employé y compris là où un
     * décodeur était déjà ouvert. Quand ce lecteur refusait le fichier — et il le refusait
     * —, la vidéo partait sans vignette, et la timeline n'avait rien à montrer.
     *
     * Ce que ces lignes tiennent (règle 7, jsdom n'ayant pas WebCodecs) : le chemin de
     * réencodage peint depuis les frames qu'il décode déjà, et le chemin rapide — qui ne
     * décode rien par construction — décode **une** image clé, pas un fichier.
     */
    expect(source).toContain("peindrePoster(poster, image, source.rotation)");
    expect(source).toContain("poster: await rendrePoster(poster)");
    expect(source).toContain("poster: await posterDUneCle(source)");
    expect(source).toContain('source.echantillons.find((echantillon) => echantillon.cle)');
  });

  it("la vignette porte l'orientation affichée, pas les pixels codés", () => {
    /*
     * le `<video>` appliquait la matrice du `tkhd` pour nous ; un décodeur
     * rend la frame codée. Sans redressement, la vignette d'une vidéo filmée en portrait
     * sortait couchée à côté d'une vidéo qui, elle, se lisait droite.
     *
     * Le sens a été vérifié contre ffmpeg — la valeur est l'angle horaire
     * d'affichage, et le repère du canvas tourne déjà dans ce sens.
     */
    expect(source).toContain("pinceau.rotate((rotation * Math.PI) / 180)");
    expect(source).toContain("new OffscreenCanvas(pivote ? hauteur : largeur, pivote ? largeur : hauteur)");
  });

  it("le contrôle de flux borne les deux files, pas une", () => {
    // Sans lecteur pour cadencer, c'est la seule chose entre le décodeur et la mémoire.
    expect(source).toContain("encodeur.encodeQueueSize > FILE_MAX");
    expect(source).toContain("decodeur.decodeQueueSize > FILE_MAX");
  });

  it("l'échelle de repli est parcourue dans l'ordre, et mesurée", () => {
    expect(source).toContain("for (const codec of CODECS_H264)");
    expect(source).toContain("VideoEncoder.isConfigSupported");
    expect(source).toContain('bitrateMode: "variable"');
  });

  it("le transcodage tourne dans un worker, jamais sur le thread de rendu", () => {
    // `@tacita/media-pipeline` § Méthode l'exigeait depuis l'origine ; rien ne le portait.
    const env = sansCommentaires(lire("lib/media-env.ts"));
    expect(env).toContain('new Worker(new URL("./transcode-worker.ts", import.meta.url))');
    expect(env).toContain("worker.terminate()");
  });

  it("un transcodage impossible envoie la source telle quelle plutôt que rien", () => {
    /*
     * / interdit n°13 — trois familles de sources échouent au chemin nominal et
     * aucune n'est marginale : les conteneurs que le démuxeur ne connaît pas (WebM,
     * Matroska — tout ce qu'un navigateur enregistre lui-même), les codecs que
     * `VideoDecoder` refuse là où l'appareil sait pourtant les lire (HEVC hors Safari), et
     * les navigateurs sans encodeur H.264. Refuser l'envoi, c'était refuser une vidéo que
     * le destinataire aurait parfaitement lue.
     *
     * La condition du repli est mesurée, pas supposée : si le navigateur sait ouvrir le
     * fichier, il en donne les dimensions. Sinon, l'échec d'origine remonte avec son motif.
     */
    const env = sansCommentaires(lire("lib/media-env.ts"));
    expect(env).toContain("const mesure = await mesurerVideo(blob).catch(() => undefined);");
    expect(env).toContain("if (!mesure) throw cause;");
    // Et l'expéditeur l'apprend : le fichier part entier, donc plus lourd.
    expect(env).toContain('options.signaler?.("video-non-compressee")');
    expect(sansCommentaires(lire("components/conversation/Conversation.tsx"))).toContain(
      'avis.current === "video-non-compressee"',
    );
  });

  it("aucune attente d'événement média n'est laissée sans issue", () => {
    /*
     * Un `<video>` qui ne sait pas décoder n'émet ni `loadeddata` ni toujours `error`, et
     * un `seeked` peut ne jamais venir. La promesse restait alors ouverte pour de bon :
     * l'envoi affichait « en cours » sans fin et sans message — le pire des états, parce
     * qu'il n'a pas de sortie utilisateur.
     */
    const env = sansCommentaires(lire("lib/media-env.ts"));
    expect(env).toContain("const minuteur = setTimeout(");
    expect(env).toContain("clearTimeout(minuteur)");
    // iOS refuse de décoder un média hors document sans ces deux-là, et l'élément reste vide.
    expect(env).toContain("video.playsInline = true");
    expect(env).toContain("video.muted = true");
  });

  it("la rotation de la source traverse jusqu'au conteneur et jusqu'aux dimensions", () => {
    expect(source).toContain("rotation: source.rotation");
    // `info.w`/`info.h` décrivent ce qui sera vu, pas ce qui est codé.
    expect(source).toContain('const pivote = rotation === 90 || rotation === 270;');
  });
});

/**
 * (b) — **la lecture progressive, côté écran.**
 *
 * Ce qui se prouve ici : le chemin ne se prend que lorsque ses trois conditions sont
 * réunies, et le chemin d'un seul bloc reste dessous, intact. La vérification par bloc
 * elle-même est prouvée dans le paquet (`blocs.test.ts`, bloc corrompu compris).
 */
describe(" (b) — le viewer ne lit par plages que quand les trois conditions sont là", () => {
  const video = (blocs?: string[]) =>
    mediaDe(
      evenement({
        msgtype: "m.video",
        body: "vacances.mp4",
        file: FICHIER,
        info: { mimetype: "video/mp4", size: 1024, thumbnail_file: VIGNETTE },
        ...(blocs ? { "org.tacita.media.block_sha256": blocs } : {}),
      }),
    )!;

  const rendre = (media: Media, chiffre?: (url: string) => Promise<Uint8Array>) =>
    render(
      <MediaViewer
        medias={[media]}
        depart={0}
        telecharger={telecharger}
        telechargerChiffre={chiffre}
        onFermer={vi.fn()}
        onSauvegarder={vi.fn()}
      />,
    );

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
  });

  it("les empreintes par bloc se lisent dans l'événement, sous leur nom à nous", () => {
    expect(video(["abc", "def"]).blocs).toEqual(["abc", "def"]);
    // Un média d'un client tiers n'a pas le champ : le chemin legacy s'applique.
    expect(video().blocs).toBeUndefined();
  });

  it("sans worker qui contrôle la page, le chemin d'un seul bloc s'applique", async () => {
    // jsdom n'a pas de `serviceWorker.controller` : c'est exactement le premier
    // chargement, avant que le worker ne prenne la main.
    const chiffre = vi.fn(async () => new Uint8Array(8));
    rendre(video(["abc"]), chiffre);

    await waitFor(() => expect(telecharger).toHaveBeenCalledWith(FICHIER, "video/mp4"));
    expect(chiffre).not.toHaveBeenCalled();
  });

  it("sans empreintes, le chiffré n'est même pas demandé", async () => {
    const chiffre = vi.fn(async () => new Uint8Array(8));
    rendre(video(), chiffre);

    await waitFor(() => expect(telecharger).toHaveBeenCalled());
    expect(chiffre).not.toHaveBeenCalled();
  });

  it("le câblage relie les trois pièces : chiffré, empreintes, worker", () => {
    // Trois valeurs posées à trois endroits différents, qu'aucun rendu de jsdom ne peut
    // relier (règle 7). Le viewer les lit toutes les trois, ou le chemin est mort.
    const viewer = sansCommentaires(lire("components/media/MediaViewer.tsx"));
    expect(viewer).toContain("media.blocs");
    expect(viewer).toContain("lectureProgressiveDisponible()");
    expect(viewer).toContain("inscrireMedia(chiffre as Bytes, media.fichier, media.blocs, declare.type)");
    expect(viewer).toContain("retirerMedia(progressif)");

    const cablage = sansCommentaires(lire("components/conversation/Conversation.tsx"));
    expect(cablage).toContain("telechargerChiffre={telechargerChiffre}");
  });
});

/**
 * **les trois échecs d'envoi, relus à la source.**
 *
 * `Conversation` ne se rend pas en jsdom sans une session complète, et ces trois phrases
 * dépendent d'un worker que jsdom n'a pas. Ce que ces tests tiennent, c'est que chaque
 * situation garde sa phrase, et que le contrôle de taille reste **avant** la mise en file
 * — mesuré, où les trois se confondaient en une seule.
 */
describe("un échec d'envoi dit lequel", () => {
  const ecran = sansCommentaires(lire("components/conversation/Conversation.tsx"));

  it("un format illisible ne se confond plus avec un échec de compression", () => {
    // Un `.mov` d'iPhone en HEVC échouait sous le mot « compresser » alors que rien
    // n'avait pu être décodé : la phrase envoyait chercher une solution qui n'existe pas.
    expect(ecran).toContain('cause.motif === "codec-source"');
    expect(ecran).toMatch(/ne sait pas lire ce format de vidéo/);
    expect(ecran).toMatch(/Impossible de compresser cette vidéo sur cet appareil/);
  });

  it("le refus de taille tombe avant `enqueue`, jamais après", () => {
    const refus = ecran.indexOf("refusePourTaille");
    const miseEnFile = ecran.indexOf("outbox.enqueue");
    expect(refus).toBeGreaterThan(0);
    expect(refus).toBeLessThan(miseEnFile);
    // Et la phrase porte les deux nombres : sans eux, « trop volumineuse » n'apprend rien.
    expect(ecran).toContain("tailleLisible(refus.taille)");
    expect(ecran).toContain("tailleLisible(refus.plafond)");
  });

  it("le codec de la source est mesuré avant d'être décodé", () => {
    // Le décodeur est plus étroit que la balise `<video>` d'avant : Firefox n'a pas de
    // HEVC du tout. On mesure, on ne suppose pas (règle 3).
    const transcode = sansCommentaires(lire("lib/transcode-video.ts"));
    expect(transcode).toContain("VideoDecoder.isConfigSupported(configSource)");
    expect(transcode).toContain('new EchecTranscodage(\n      "codec-source"');
  });
});

/**
 * **L'enregistreur vocal.** Logique à états — permission, démarrage, arrêt, extinction du
 * micro — dont aucune panne ne se voit : un micro resté allumé, un flux non relâché ou un
 * fichier étiqueté du format demandé plutôt que du format rendu passent tous silencieusement.
 *
 * `MediaRecorder` n'existe pas dans jsdom : la portée est injectée, ce qui est précisément
 * la raison d'être du paramètre.
 */
describe("enregistreur vocal", () => {
  class FauxEnregistreur {
    static formats: string[] = ["audio/webm;codecs=opus"];
    static isTypeSupported = (type: string) => FauxEnregistreur.formats.includes(type);

    state = "inactive";
    ondataavailable: ((evenement: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(readonly flux: unknown, readonly options: { mimeType: string }) {}

    start() {
      this.state = "recording";
    }

    stop() {
      this.state = "inactive";
      // Le navigateur rend un blob **de son conteneur à lui**, pas du type demandé.
      this.ondataavailable?.({ data: new Blob(["opus"], { type: "audio/webm" }) });
      this.onstop?.();
    }
  }

  const pistes = () => [{ stop: vi.fn() }];

  const portee = (getUserMedia: () => Promise<unknown>) =>
    ({
      MediaRecorder: FauxEnregistreur,
      navigator: { mediaDevices: { getUserMedia } },
    }) as unknown as typeof globalThis;

  const micro = (arretees = pistes()) =>
    portee(async () => ({ getTracks: () => arretees }));

  /**
   * Une horloge qui avance d'un pas fixe à chaque lecture. Le composant mesure la tenue
   * de l'appui avec `Date.now()` : un pas nul la fige à zéro — l'appui maladroit —, un pas
   * d'une seconde la place au-dessus du plancher.
   */
  let horloge: ReturnType<typeof vi.spyOn> | undefined;
  const avance = (pas: number) => {
    let instant = 0;
    horloge = vi.spyOn(Date, "now").mockImplementation(() => (instant += pas));
  };

  beforeEach(() => {
    FauxEnregistreur.formats = ["audio/webm;codecs=opus"];
  });

  afterEach(() => {
    horloge?.mockRestore();
    horloge = undefined;
  });

  it("ne rend rien du tout quand l'appareil n'enregistre aucun format", () => {
    FauxEnregistreur.formats = [];
    const { container } = render(<EnregistreurVocal onEnvoyer={vi.fn()} portee={micro()} />);
    // Pas un bouton désactivé : rien. Un micro inerte est une fonction affichée qui ne
    // marche pas, et l'absence se comprend mieux qu'un échec au moment d'envoyer.
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("propose le micro quand un format existe", () => {
    render(<EnregistreurVocal onEnvoyer={vi.fn()} portee={micro()} />);
    expect(screen.getByRole("button", { name: "Enregistrer un message vocal" })).toBeTruthy();
  });

  it("enregistre puis envoie un fichier au type réellement produit", async () => {
    avance(1000);
    const envoye = vi.fn();
    render(<EnregistreurVocal onEnvoyer={envoye} portee={micro()} />);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
    await screen.findByRole("group", { name: "Enregistrement en cours" });

    fireEvent.click(screen.getByRole("button", { name: "Envoyer le message vocal" }));
    await waitFor(() => expect(envoye).toHaveBeenCalledTimes(1));

    const fichier = envoye.mock.calls[0]![0] as File;
    // `audio/webm` et non `audio/webm;codecs=opus` : le pipeline s'aiguille sur le type du
    // fichier, et lui mentir enverrait ces octets dans le mauvais chemin.
    expect(fichier.type).toBe("audio/webm");
    expect(fichier.name).toMatch(/^vocal-\d+\.webm$/);
  });

  /**
   * Le plancher de 800 ms. Deux touchers maladroits expédiaient un vocal de 200 ms, que
   * le destinataire ouvre pour n'entendre rien — et le garde d'alors ne vérifiait que
   * « des octets existent », ce qui est vrai d'un silence.
   */
  it("jette un appui trop court au lieu d'envoyer un vocal muet", async () => {
    avance(0);
    const envoye = vi.fn();
    const arretees = pistes();
    render(<EnregistreurVocal onEnvoyer={envoye} portee={micro(arretees)} />);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
    await screen.findByRole("group", { name: "Enregistrement en cours" });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le message vocal" }));

    // Le micro s'éteint quand même, et rien n'est dit : un appui trop court n'est pas une
    // faute à expliquer.
    await waitFor(() => expect(arretees[0]!.stop).toHaveBeenCalled());
    expect(envoye).not.toHaveBeenCalled();
    expect(screen.queryByText(/micro/i)).toBeNull();
  });

  it("éteint le micro à l'envoi : une pastille qui reste allumée est une trahison", async () => {
    avance(1000);
    const arretees = pistes();
    render(<EnregistreurVocal onEnvoyer={vi.fn()} portee={micro(arretees)} />);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
    await screen.findByRole("group", { name: "Enregistrement en cours" });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le message vocal" }));

    await waitFor(() => expect(arretees[0]!.stop).toHaveBeenCalled());
  });

  it("annule sans rien envoyer, et éteint le micro aussi", async () => {
    const envoye = vi.fn();
    const arretees = pistes();
    render(<EnregistreurVocal onEnvoyer={envoye} portee={micro(arretees)} />);

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
    await screen.findByRole("group", { name: "Enregistrement en cours" });
    fireEvent.click(screen.getByRole("button", { name: "Annuler l'enregistrement" }));

    await waitFor(() => expect(arretees[0]!.stop).toHaveBeenCalled());
    expect(envoye).not.toHaveBeenCalled();
  });

  /**
   * **Le maintien.** jsdom n'a ni `PointerEvent` ni `setPointerCapture` : on dispatche
   * des `MouseEvent` sous le nom des événements pointeur — ils portent `clientX`, qui est
   * tout ce que le composant lit — et la capture est appelée en facultatif.
   */
  const doigt = (cible: HTMLElement, type: string, clientX: number) =>
    fireEvent(cible, new MouseEvent(type, { bubbles: true, clientX, clientY: 0 }));

  const micBouton = () => screen.getByRole("button", { name: "Enregistrer un message vocal" });
  /**
   * Le micro, une fois l'enregistrement ouvert — c'est le même nœud, qui a changé de
   * libellé. **Les mouvements se dispatchent dessus et non sur la barre** : au navigateur,
   * la capture de pointeur les y ramène où que soit le doigt ; jsdom n'a pas la capture,
   * et la barre est une sœur du bouton, pas son parent.
   */
  const micTenu = () => screen.getByRole("button", { name: "Envoyer le message vocal" });

  it("appuyer ouvre le micro, relâcher envoie — sans second appui", async () => {
    avance(1000);
    const envoye = vi.fn();
    render(<EnregistreurVocal onEnvoyer={envoye} portee={micro()} />);

    doigt(micBouton(), "pointerdown", 300);
    // La poubelle n'existe qu'à partir de là : un composer n'en porte pas en permanence.
    await screen.findByRole("group", { name: "Enregistrement en cours" });
    expect(screen.getByRole("button", { name: "Annuler l'enregistrement" })).toBeTruthy();

    doigt(micTenu(), "pointerup", 300);
    await waitFor(() => expect(envoye).toHaveBeenCalledTimes(1));
  });

  it("glisser jusqu'à la poubelle annule, et rien ne part", async () => {
    avance(1000);
    const envoye = vi.fn();
    const arretees = pistes();
    render(<EnregistreurVocal onEnvoyer={envoye} portee={micro(arretees)} />);

    doigt(micBouton(), "pointerdown", 300);
    await screen.findByRole("group", { name: "Enregistrement en cours" });

    // 300 → 200 : au-delà des 72 px de course, le geste bascule et le dit.
    doigt(micTenu(), "pointermove", 200);
    expect(screen.getByText("Relâchez pour annuler")).toBeTruthy();

    doigt(micTenu(), "pointerup", 200);
    await waitFor(() => expect(arretees[0]!.stop).toHaveBeenCalled());
    expect(envoye).not.toHaveBeenCalled();
  });

  it("le pouce peut rouler sans annuler : la zone morte tient", async () => {
    avance(1000);
    const envoye = vi.fn();
    render(<EnregistreurVocal onEnvoyer={envoye} portee={micro()} />);

    doigt(micBouton(), "pointerdown", 300);
    await screen.findByRole("group", { name: "Enregistrement en cours" });

    // 40 px vers la gauche — un pouce qui tient un bouton ne reste pas immobile.
    doigt(micTenu(), "pointermove", 260);
    expect(screen.getByText(/Glissez vers la poubelle/)).toBeTruthy();

    doigt(micTenu(), "pointerup", 260);
    await waitFor(() => expect(envoye).toHaveBeenCalledTimes(1));
  });

  it("un doigt levé avant l'ouverture du micro n'allume rien pour rien", async () => {
    avance(0);
    const envoye = vi.fn();
    const arretees = pistes();
    let ouvrir: (flux: unknown) => void = () => {};
    const attente = new Promise((resoudre) => {
      ouvrir = resoudre;
    });

    render(<EnregistreurVocal onEnvoyer={envoye} portee={portee(() => attente)} />);

    // `getUserMedia` attend encore — la toute première fois, c'est la demande de
    // permission. Le doigt, lui, est déjà reparti.
    doigt(micBouton(), "pointerdown", 300);
    doigt(micBouton(), "pointerup", 300);
    ouvrir({ getTracks: () => arretees });

    // L'enregistrement s'ouvre puis se referme aussitôt : micro éteint, rien d'envoyé,
    // et surtout pas une pastille d'enregistrement qui reste allumée sans rien à l'écran.
    await waitFor(() => expect(arretees[0]!.stop).toHaveBeenCalled());
    expect(envoye).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Enregistrement en cours" })).toBeNull();
  });

  it("dit en toutes lettres qu'on a refusé le micro, et laisse réessayer", async () => {
    const refus = Object.assign(new Error("refus"), { name: "NotAllowedError" });
    render(
      <EnregistreurVocal
        onEnvoyer={vi.fn()}
        portee={portee(() => Promise.reject(refus))}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Enregistrer un message vocal" }));
    await screen.findByText(/L'accès au micro a été refusé/);
    // Le bouton reste : le refus se répare dans les réglages, puis on retente.
    expect(screen.getByRole("button", { name: "Enregistrer un message vocal" })).toBeTruthy();
  });
});
