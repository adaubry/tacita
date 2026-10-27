import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";

import {
  decryptAttachment,
  detectProfile,
  downloadAttachment,
  encryptAttachment,
  MediaIntegrityError,
  PROFILES,
  refusePourTaille,
  saveOriginal,
  THUMBNAIL,
  uploadAttachment,
  uploadPublicProfileImage,
  waveform,
  type AttachmentContent,
  type EncryptedFile,
  type MediaEnvironment,
} from "../src/index";

const MXC = "mxc://tacita.test/blob";
const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * Ce que le package **exécute**, commentaires retirés : un interdit qui se déclenche sur
 * une prose explicative n'apprend rien. Le dossier est lu, jamais une liste de fichiers —
 * une liste laisserait un fichier neuf hors de portée de l'invariant.
 */
function packageCode(): string {
  const src = new URL("../src/", import.meta.url);
  return readdirSync(src)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(new URL(name, src), "utf-8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function fakeEnv(overrides: Partial<MediaEnvironment> = {}) {
  return {
    subtle: globalThis.crypto.subtle,
    getRandomValues: (target: Uint8Array) => void globalThis.crypto.getRandomValues(target),
    resizeImage: vi.fn(async (_blob: Blob, targets: { maxEdge: number; quality: number }) => ({
      blob: new Blob([`image ${targets.maxEdge}@${targets.quality}`]),
      width: targets.maxEdge,
      height: Math.round(targets.maxEdge / 2),
    })),
    transcodeVideo: vi.fn(async (_blob: Blob, targets: { height: number; bitrate: number }) => ({
      blob: new Blob([`video ${targets.height}@${targets.bitrate}`]),
      width: targets.height * 2,
      height: targets.height,
      durationMs: 4200,
    })),
    extractPoster: vi.fn(async () => new Blob(["poster"])),
    transcodeAudio: vi.fn(async () => new Blob(["ogg opus"], { type: "audio/ogg" })),
    decodeAudio: vi.fn(async () => ({
      samples: Float32Array.from({ length: 600 }, (_u, i) => Math.sin(i) / 2),
      durationMs: 3000,
    })),
    saveViaDownload: vi.fn(async () => {}),
    ...overrides,
  } satisfies MediaEnvironment;
}

function fakeSession() {
  return {
    client: {
      uploadContent: vi.fn(async (_blob: Blob, _opts: unknown) => ({ content_uri: MXC })),
      mxcUrlToHttp: vi.fn(
        (
          _mxc: string,
          _w?: number,
          _h?: number,
          _method?: string,
          _direct?: boolean,
          _redirects?: boolean,
          _authenticated?: boolean,
        ): string | null => "https://tacita.test/_matrix/client/v1/media/download/tacita.test/blob",
      ),
      getAccessToken: () => "syt_token",
      /** le plafond que le serveur annonce ; 200 Mo, comme le déploiement. */
      getMediaConfig: vi.fn(
        async (): Promise<Record<string, unknown>> => ({ "m.upload.size": 200 * 1024 * 1024 }),
      ),
    },
  };
}

let env: ReturnType<typeof fakeEnv>;
let fake: ReturnType<typeof fakeSession>;
let session: Session;

beforeEach(() => {
  vi.unstubAllGlobals();
  env = fakeEnv();
  fake = fakeSession();
  // Ce paquet ne lit que `client`. `asSession` fournit le reste du contrat en
  // levées nommées : un membre ajouté à `Session` ne manque plus en silence.
  session = asSession({ client: fake.client });
});

/** L'erreur d'une promesse qui doit échouer. */
const rejection = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(
    () => {
      throw new Error("la promesse aurait dû échouer");
    },
    (caught: unknown) => caught as Error,
  );

/** Les octets réellement remis au serveur lors du n-ième upload. */
async function uploadedBytes(index: number): Promise<Uint8Array> {
  const [blob] = fake.client.uploadContent.mock.calls[index]!;
  return new Uint8Array(await blob.arrayBuffer());
}

describe("chiffrement client AES-CTR, schéma EncryptedFile", () => {
  it("produit un blob opaque et des clés au format v2", async () => {
    const clear = bytes("photo de vacances");
    const { ciphertext, keys } = await encryptAttachment(clear, env);

    expect(ciphertext).not.toEqual(clear);
    expect(keys.v).toBe("v2");
    expect(keys.key.alg).toBe("A256CTR");
    expect(keys.key.kty).toBe("oct");
    expect(keys.hashes.sha256).toBeTruthy();

    // Le compteur AES-CTR occupe les 8 octets de poids faible : ils démarrent à zéro.
    const iv = Uint8Array.from(atob(keys.iv), (char) => char.charCodeAt(0));
    expect(iv).toHaveLength(16);
    expect([...iv.subarray(8)]).toEqual(Array<number>(8).fill(0));
  });

  it("ne remet au serveur que du chiffré, jamais le clair", async () => {
    const file = new File([bytes("contrat.pdf en clair")], "contrat.pdf", {
      type: "application/pdf",
    });
    await uploadAttachment(session, env, file);

    const sent = await uploadedBytes(0);
    expect(new TextDecoder().decode(sent)).not.toContain("en clair");
    const [, opts] = fake.client.uploadContent.mock.calls[0]!;
    // Le nom du fichier fuiterait le contenu : il reste dans l'événement chiffré.
    expect(opts).toMatchObject({ includeFilename: false, type: "application/octet-stream" });
  });
});

describe("un seul pipeline pour tous les types de fichiers", () => {
  it("fait passer un PDF et une image par la même fonction d'upload", async () => {
    const pdf = new File([bytes("%PDF-1.7")], "notice.pdf", { type: "application/pdf" });
    const image = new File([bytes("\xFF\xD8\xFF")], "chat.jpg", { type: "image/jpeg" });

    const pdfContent = await uploadAttachment(session, env, pdf);
    const uploadsAfterPdf = fake.client.uploadContent.mock.calls.length;
    const imageContent = await uploadAttachment(session, env, image);

    expect(pdfContent.msgtype).toBe("m.file");
    expect(imageContent.msgtype).toBe("m.image");
    // Aucun canal parallèle : les deux ont emprunté le même `uploadContent`.
    expect(uploadsAfterPdf).toBe(1);
    expect(fake.client.uploadContent.mock.calls.length).toBeGreaterThan(uploadsAfterPdf);
    for (const [, opts] of fake.client.uploadContent.mock.calls) {
      expect(opts).toMatchObject({ includeFilename: false, type: "application/octet-stream" });
    }
    // Le PDF n'est pas compressé, mais il est chiffré comme le reste.
    expect(env.resizeImage).toHaveBeenCalledTimes(2); // image + sa vignette
    expect(pdfContent.file.hashes.sha256).toBeTruthy();
  });
});

describe("vignettes générées côté client, chiffrées séparément", () => {
  it("téléverse deux blobs aux clés distinctes et n'interroge jamais le serveur", async () => {
    const image = new File([bytes("jpeg")], "chat.jpg", { type: "image/jpeg" });
    const content = await uploadAttachment(session, env, image);

    expect(fake.client.uploadContent).toHaveBeenCalledTimes(2);
    const thumbnail = content.info.thumbnail_file as EncryptedFile;
    expect(thumbnail.key.k).not.toBe(content.file.key.k);
    expect(thumbnail.iv).not.toBe(content.file.iv);
    // `/thumbnail` côté serveur est exclu : il ne sait pas déchiffrer le blob.
    expect(fake.client.mxcUrlToHttp).not.toHaveBeenCalled();
  });

  /**
   * **Le type déclaré est celui qu'on a obtenu, pas celui qu'on visait.**
   *
   * Un canvas à qui l'on demande un format qu'il ne sait pas encoder rend du PNG sans
   * lever : la cible est WebP depuis que la vignette a doublé de côté, et là où elle
   * n'est pas supportée le shard retombe sur du JPEG. Écrire `THUMBNAIL.mimeType` dans
   * l'événement ferait mentir celui-ci sur ses propres octets, et le destinataire
   * construirait un Blob d'un type qui n'est pas le sien.
   */
  it("`thumbnail_info` déclare le type réellement produit", async () => {
    const repli = fakeEnv({
      resizeImage: vi.fn(async () => ({
        blob: new Blob(["vignette"], { type: "image/jpeg" }),
        width: 512,
        height: 256,
      })),
    }) as unknown as MediaEnvironment;

    const content = await uploadAttachment(
      session,
      repli,
      new File([bytes("jpeg")], "chat.jpg", { type: "image/jpeg" }),
    );
    expect(THUMBNAIL.mimeType).toBe("image/webp");
    expect((content.info.thumbnail_info as Record<string, unknown>).mimetype).toBe("image/jpeg");
  });

  it("la vignette vise 512 px de côté long — 320 était flou sur tout écran dense", () => {
    expect(THUMBNAIL.maxEdge).toBe(512);
  });

  it("dérive la vignette d'une image extraite de la vidéo", async () => {
    const video = new File([bytes("mp4")], "clip.mp4", { type: "video/mp4" });
    await uploadAttachment(session, env, video);

    expect(env.extractPoster).toHaveBeenCalledTimes(1);
    expect(env.resizeImage).toHaveBeenCalledTimes(1);
  });
});

describe("compression adaptative, seuils D-04", () => {
  it("applique les cibles du profil contraint quand le réseau l'est", async () => {
    env = fakeEnv({ connection: { effectiveType: "3g" } });
    await uploadAttachment(session, env, new File([bytes("x")], "a.jpg", { type: "image/jpeg" }));
    expect(env.resizeImage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ maxEdge: 1280, quality: 0.7 }),
    );

    env = fakeEnv({ connection: { effectiveType: "3g" } });
    await uploadAttachment(session, env, new File([bytes("x")], "a.mp4", { type: "video/mp4" }));
    expect(env.transcodeVideo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ height: 480, bitrate: 1_000_000, mimeType: "video/mp4" }),
    );
  });

  it("applique les cibles « bon réseau » sinon", async () => {
    await uploadAttachment(session, env, new File([bytes("x")], "a.jpg", { type: "image/jpeg" }));
    expect(env.resizeImage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ maxEdge: 2048, quality: 0.8 }),
    );

    env = fakeEnv();
    await uploadAttachment(session, env, new File([bytes("x")], "a.mp4", { type: "video/mp4" }));
    expect(env.transcodeVideo).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ height: 720, bitrate: 2_500_000 }),
    );
  });

  it("décrit les octets livrés, pas la cible visée : un envoi non compressé le dit", async () => {
    /*
     * **le repli du shard, vu du pipeline.** Là où ce navigateur
     * ne sait ni démuxer ni encoder — WebM, HEVC hors Safari, Firefox sans encodeur —,
     * `transcodeVideo` rend la source telle quelle plutôt que de refuser l'envoi. Écrire
     * alors `video/mp4` dans l'événement ferait mentir le contenu sur ses propres octets,
     * et c'est `info.mimetype` qui décide du rendu chez le destinataire.
     */
    const source = new Blob([bytes("webm brut")], { type: "video/webm" });
    env = fakeEnv({
      transcodeVideo: vi.fn(async () => ({ blob: source, width: 1920, height: 1080, durationMs: 8000 })),
    });

    const contenu = await uploadAttachment(session, env, new File([bytes("x")], "a.webm", { type: "video/webm" }));
    expect(contenu.info.mimetype).toBe("video/webm");
    expect(contenu.info.size).toBe(source.size);
  });

  it("la vignette vient du décodeur quand il en a une, du lecteur seulement sinon", async () => {
    /*
     * **le poster suit le décodeur, pas le lecteur.** Les deux chemins qui
     * décodent tiennent déjà une frame ; rouvrir le fichier dans un `<video>` pour
     * redemander ce qu'on avait sous la main était le detour qui laissait les vidéos sans
     * vignette dès que ce lecteur refusait le fichier. `extractPoster` n'est plus qu'un
     * dernier recours — celui du seul chemin qui ne décode rien.
     */
    const duDecodeur = new Blob([bytes("image du decodeur")], { type: "image/jpeg" });
    env = fakeEnv({
      transcodeVideo: vi.fn(async () => ({
        blob: new Blob([bytes("mp4")]),
        width: 1280,
        height: 720,
        durationMs: 4200,
        poster: duDecodeur,
      })),
    });

    await uploadAttachment(session, env, new File([bytes("x")], "a.mp4", { type: "video/mp4" }));
    expect(env.extractPoster).not.toHaveBeenCalled();
    expect(env.resizeImage).toHaveBeenCalledWith(duDecodeur, THUMBNAIL);

    // Sans poster — la source part telle quelle, rien n'a été décodé — le lecteur reprend.
    env = fakeEnv();
    await uploadAttachment(session, env, new File([bytes("x")], "a.webm", { type: "video/webm" }));
    expect(env.extractPoster).toHaveBeenCalledTimes(1);
  });

  it("une vignette impossible ne fait pas échouer l'envoi de la vidéo", async () => {
    /*
     * la vignette est un confort, l'envoi est la fonction. Un poster que le
     * navigateur ne sait pas extraire — codec illisible dans un `<video>` — faisait échouer
     * tout l'envoi. `thumbnail_file` est facultatif dans l'événement ; l'absence d'un
     * confort ne doit pas coûter le message.
     */
    env = fakeEnv({ extractPoster: vi.fn(async () => { throw new Error("vidéo illisible"); }) });
    const contenu = await uploadAttachment(session, env, new File([bytes("x")], "a.mp4", { type: "video/mp4" }));

    expect(contenu.msgtype).toBe("m.video");
    expect(contenu.file.url).toBe(MXC);
    expect(contenu.info.thumbnail_file).toBeUndefined();
    // Et surtout : aucun téléversement orphelin. Un chiffré rangé pour un champ que le
    // contenu ne porte pas casserait `poserUrl` au retour du serveur.
    expect(session.client.uploadContent).toHaveBeenCalledTimes(1);
  });

  it("un fichier sans type déclaré est reconnu à ses octets, pas rangé en « fichier »", async () => {
    /*
     * `File.type` est vide plus souvent qu'on ne le croit : glisser-déposer,
     * `.mkv` sous Windows, partages Android via un fournisseur qui ne mappe pas
     * l'extension. Le fichier partait alors en `m.file`, ni compressé ni vignetté.
     */
    const ftyp = new Uint8Array(32);
    ftyp.set(bytes("ftypisom"), 4);
    const contenu = await uploadAttachment(session, env, new File([ftyp], "clip", { type: "" }));

    expect(contenu.msgtype).toBe("m.video");
    expect(env.transcodeVideo).toHaveBeenCalled();
  });

  it("retombe sur « bon réseau » quand l'API est absente, et suit saveData", () => {
    expect(detectProfile(undefined)).toBe("good");
    expect(detectProfile({ effectiveType: "4g" })).toBe("good");
    expect(detectProfile({ effectiveType: "2g" })).toBe("constrained");
    expect(detectProfile({ effectiveType: "4g", saveData: true })).toBe("constrained");
  });
});

describe("original non compressé conservé sur l'appareil de l'auteur", () => {
  it("préfère le sélecteur de fichiers, retombe sur le téléchargement", async () => {
    const original = new Blob([bytes("raw sensor data")]);

    await saveOriginal(env, original, "IMG_0001.heic");
    expect(env.saveViaDownload).toHaveBeenCalledWith(original, "IMG_0001.heic");

    const withPicker = fakeEnv({ saveViaFilePicker: vi.fn(async () => {}) });
    await saveOriginal(withPicker, original, "IMG_0001.heic");
    expect(withPicker.saveViaFilePicker).toHaveBeenCalledWith(original, "IMG_0001.heic");
    expect(withPicker.saveViaDownload).not.toHaveBeenCalled();

    // L'adaptateur a le droit de s'appuyer sur son `this` : la méthode ne doit pas être
    // détachée de `env` avant d'être appelée.
    const stateful = {
      ...fakeEnv(),
      saved: [] as string[],
      async saveViaFilePicker(_blob: Blob, filename: string) {
        this.saved.push(filename);
      },
    };
    await saveOriginal(stateful, original, "IMG_0002.heic");
    expect(stateful.saved).toEqual(["IMG_0002.heic"]);
  });

  it("reste hors du chemin d'envoi : le destinataire n'a que la version compressée", async () => {
    const image = new File([bytes("original 48 Mpx")], "chat.jpg", { type: "image/jpeg" });
    await uploadAttachment(session, env, image);

    expect(env.saveViaDownload).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await uploadedBytes(0))).not.toContain("original");
  });
});

describe("vocaux m.audio avec forme d'onde et durée", () => {
  it("porte la durée et une forme d'onde MSC1767 dans le contenu", async () => {
    const voice = new File([bytes("ogg")], "vocal.ogg", { type: "audio/ogg" });
    const content = await uploadAttachment(session, env, voice);

    expect(content.msgtype).toBe("m.audio");
    expect(content.info.mimetype).toBe("audio/ogg");
    expect(content.info.duration).toBe(3000);
    const audio = content["org.matrix.msc1767.audio"]!;
    expect(audio.duration).toBe(3000);
    expect(audio.waveform).toHaveLength(60);
    expect(Math.max(...audio.waveform)).toBeLessThanOrEqual(1024);
    expect(Math.min(...audio.waveform)).toBeGreaterThanOrEqual(0);
  });

  it("ramène chaque tranche à son pic sur l'échelle 0–1024", () => {
    expect(waveform(Float32Array.from([0, 0, 1, 0.5]), 2)).toEqual([0, 1024]);
  });
});

describe("transcodage vers Ogg/Opus quand l'entrée n'en est pas", () => {
  it("transcode une capture Safari iOS en MP4/AAC", async () => {
    const aac = new File([bytes("mp4 aac")], "vocal.m4a", { type: "audio/mp4" });
    const content = await uploadAttachment(session, env, aac);

    expect(env.transcodeAudio).toHaveBeenCalledTimes(1);
    // D-03 — format de sortie unique, sans quoi les vocaux iPhone sont illisibles ailleurs.
    expect(content.info.mimetype).toBe("audio/ogg");
  });

  it("laisse passer un Ogg/Opus sans le retranscoder", async () => {
    await uploadAttachment(
      session,
      env,
      new File([bytes("ogg")], "vocal.ogg", { type: "audio/ogg" }),
    );
    expect(env.transcodeAudio).not.toHaveBeenCalled();
  });
});

/**
 * **Le quatrième palier**. WebKit n'a ajouté l'enregistrement WebM/Opus
 * qu'en 18.4 : sur un iOS resté en deçà, et sans encodeur, la règle « un seul format sort
 * d'ici » ne produisait pas un vocal au bon format — elle ne produisait aucun vocal.
 *
 * Ces trois tests tiennent l'amendement **et sa borne** : le repli n'est pas « envoyer
 * n'importe quoi », c'est « envoyer ce que tout le monde sait lire ».
 */
describe("repli : un AAC part tel quel plutôt que de ne pas partir", () => {
  const sansEncodeur = () =>
    fakeEnv({
      transcodeAudio: vi.fn(async () => {
        throw new Error("transcodage audio indisponible");
      }),
    });

  it("envoie le MP4/AAC sans conversion, en annonçant son vrai type", async () => {
    const env = sansEncodeur();
    const aac = new File([bytes("mp4 aac")], "vocal.m4a", { type: "audio/mp4" });
    const content = await uploadAttachment(session, env, aac);

    expect(env.transcodeAudio).toHaveBeenCalledTimes(1);
    expect(content.msgtype).toBe("m.audio");
    // L'étiquette dit ce que le fichier est, jamais ce qu'on aurait voulu qu'il soit.
    expect(content.info.mimetype).toBe("audio/mp4");
    expect(content.info.size).toBe(aac.size);
  });

  it("reste un vocal complet : durée, forme d'onde et marqueur MSC3245", async () => {
    const content = await uploadAttachment(
      session,
      sansEncodeur(),
      new File([bytes("mp4 aac")], "vocal.m4a", { type: "audio/mp4" }),
    );

    expect(content.info.duration).toBe(3000);
    expect(content["org.matrix.msc1767.audio"]!.waveform).toHaveLength(60);
    expect(content["org.matrix.msc3245.voice"]).toBeDefined();
  });

  it("refuse toujours un conteneur que personne ne saura lire", async () => {
    // La liste des replis est close : un format exotique échoue à l'envoi plutôt que
    // d'arriver chez quelqu'un sous la forme d'un message qu'il ne peut pas ouvrir.
    await expect(
      uploadAttachment(
        session,
        sansEncodeur(),
        new File([bytes("flac")], "vocal.flac", { type: "audio/flac" }),
      ),
    ).rejects.toThrow("transcodage audio indisponible");
  });
});

describe("vérification du hash puis déchiffrement local", () => {
  it("rend les octets d'origine sur un aller-retour complet", async () => {
    const clear = bytes("les octets exacts, au bit près");
    const { ciphertext, keys } = await encryptAttachment(clear, env);

    expect(await decryptAttachment(ciphertext, keys, env.subtle)).toEqual(clear);
  });

  it("accepte une empreinte paddée : la spec dit non paddé, les clients font ce qu'ils veulent", async () => {
    const clear = bytes("média venu d'un autre client");
    const { ciphertext, keys } = await encryptAttachment(clear, env);
    const padded = { ...keys, hashes: { sha256: `${keys.hashes.sha256}==` } };

    expect(await decryptAttachment(ciphertext, padded, env.subtle)).toEqual(clear);
  });

  it("rejette un blob altéré avant toute tentative de déchiffrement", async () => {
    const { ciphertext, keys } = await encryptAttachment(bytes("intact"), env);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;

    await expect(decryptAttachment(ciphertext, keys, env.subtle)).rejects.toBeInstanceOf(
      MediaIntegrityError,
    );
  });
});

describe("média authentifié, aucune URL publique supposée", () => {
  it("passe par l'endpoint authentifié avec le jeton en en-tête", async () => {
    const clear = bytes("blob chiffré");
    const { ciphertext, keys } = await encryptAttachment(clear, env);
    const fetchStub = vi.fn(async () => new Response(ciphertext));
    vi.stubGlobal("fetch", fetchStub);

    const file: EncryptedFile = { ...keys, url: MXC };
    expect(await downloadAttachment(session, env, file)).toEqual(clear);

    // Dernier argument : `useAuthentication`. Les endpoints v3 répondent 404.
    expect(fake.client.mxcUrlToHttp).toHaveBeenCalledWith(
      MXC,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );
    const [url, init] = fetchStub.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toContain("/_matrix/client/v1/media/download/");
    expect(init.headers).toEqual({ Authorization: "Bearer syt_token" });
  });

  it("échoue explicitement si le serveur refuse le média", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const { keys } = await encryptAttachment(bytes("x"), env);

    await expect(downloadAttachment(session, env, { ...keys, url: MXC })).rejects.toThrow(
      "HTTP 404",
    );
  });
});

describe("aucun contenu média ni clé dans les erreurs", () => {
  it("ne laisse fuiter ni clé, ni IV, ni octets dans l'erreur d'intégrité", async () => {
    const { ciphertext, keys } = await encryptAttachment(bytes("secret"), env);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;

    const error = await rejection(decryptAttachment(ciphertext, keys, env.subtle));
    const serialised = `${error.message} ${JSON.stringify(error)}`;
    expect(serialised).not.toContain(keys.key.k);
    expect(serialised).not.toContain(keys.iv);
    expect(serialised).not.toContain(keys.hashes.sha256);
  });

  it("n'expose pas l'URL du média dans l'erreur de téléchargement", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const { keys } = await encryptAttachment(bytes("x"), env);

    const error = await rejection(downloadAttachment(session, env, { ...keys, url: MXC }));
    expect(error.message).not.toContain(MXC);
    expect(error.message).not.toContain("tacita.test");
  });
});

/** Le contenu rendu est directement `enqueue`-able : pas de post-traitement. */
describe("contenu prêt pour la file d'envoi", () => {
  it("porte msgtype, body et file sans étape supplémentaire", async () => {
    const content: AttachmentContent = await uploadAttachment(
      session,
      env,
      new File([bytes("zip")], "archive.zip", { type: "application/zip" }),
    );

    expect(content.body).toBe("archive.zip");
    expect(content.file.url).toBe(MXC);
    expect(content.info).toMatchObject({ mimetype: "application/zip" });
  });

  /**
   * L'invariant que le PM a exigé en contrepartie de « le média est hors périmètre de
   * par construction ». La construction est saine : le pipeline
   * téléverse et rend un contenu, c'est `outbox` qui envoie — donc la garde de salon
   * non chiffré s'applique une fois, au bon endroit. Rien ne la gardait.
   *
   * Un `sendEvent`/`sendMessage` ajouté ici rouvrirait un chemin d'envoi qui contourne
   * la file **et** sa garde de chiffrement, sans qu'aucun test existant ne bouge.
   */
  it("aucun chemin d'envoi dans le package : le pipeline ne poste jamais d'événement", () => {
    expect(packageCode()).not.toMatch(/\bsend(Event|Message)\b/);
  });
});

describe("l'unique chemin public du pipeline, et son site d'appel unique", () => {
  const photo = () => new File([bytes("\xFF\xD8\xFF")], "moi.jpg", { type: "image/jpeg" });

  it("téléverse la photo de profil en clair : un avatar chiffré n'est un avatar nulle part", async () => {
    const uri = await uploadPublicProfileImage(session, env, photo());

    expect(uri).toBe(MXC);
    const [blob, options] = fake.client.uploadContent.mock.calls[0] as [Blob, { type: string }];
    // Le contraste avec est tout le sujet : là, `application/octet-stream`,
    // parce que le serveur ne voit qu'un blob opaque. Ici il doit pouvoir le servir à
    // des clients qui n'ont aucune clé.
    expect(options.type).not.toBe("application/octet-stream");
    expect(options).toMatchObject({ includeFilename: false });

    // Et surtout : ce qui part est **lisible**. La vérification porte sur les octets,
    // pas sur l'intention — c'est le raster que `resizeImage` a rendu, tel quel.
    const cible = PROFILES[detectProfile(env.connection)].image;
    await expect(blob.text()).resolves.toBe(`image ${cible.maxEdge}@${cible.quality}`);
  });

  it("passe par la même compression que le reste : un seul pipeline (interdit n°11)", async () => {
    await uploadPublicProfileImage(session, env, photo());

    // Même `resizeImage`, mêmes cibles D-04. Une photo de profil de 8 Mo est un problème
    // pour tout le monde, chiffrée ou non.
    expect(env.resizeImage).toHaveBeenCalledTimes(1);
    expect(env.resizeImage).toHaveBeenCalledWith(expect.anything(), PROFILES[detectProfile(env.connection)].image);
  });

  it("n'a que ses deux sites d'appel nommés dans tout le dépôt", () => {
    // La condition qui rend acceptable. « Tout ce qui sort du pipeline est
    // chiffré, sauf le chemin nommé public » ne vaut que tant que ses appelants sont
    // comptés par une machine — une consigne de revue se contourne par distraction.
    //
    // Deux, et l'assertion reste une **égalité** : ce qui compte
    // n'est pas le nombre mais la liste, chaque entrée ayant été relue une fois.
    // `fileURLToPath` et non `.pathname` : sous Windows ce dernier rend `/C:/…`, que Node
    // résout ensuite depuis la racine du lecteur courant — `C:\C:\…`, et le parcours échoue
    // avant d'avoir lu un seul fichier. Les barres sont normalisées pour que la racine se
    // retire des chemins collectés, qui sont construits en avant.
    const racine = fileURLToPath(new URL("../../../", import.meta.url)).replaceAll("\\", "/");
    const ignores = new Set(["node_modules", ".next", ".git", "dist", "tsconfig.tsbuildinfo"]);
    const appelants: string[] = [];

    const parcourir = (dossier: string) => {
      for (const entree of readdirSync(dossier, { withFileTypes: true })) {
        if (ignores.has(entree.name)) continue;
        const chemin = `${dossier}/${entree.name}`;
        if (entree.isDirectory()) parcourir(chemin);
        else if (/\.tsx?$/.test(entree.name)) {
          const code = readFileSync(chemin, "utf-8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^[ \t]*\/\/.*$/gm, "");
          // L'appel, pas la mention : `uploadPublicProfileImage(` suivi d'une parenthèse.
          if (/uploadPublicProfileImage\s*\(/.test(code)) appelants.push(chemin.replace(racine, ""));
        }
      }
    };
    parcourir(racine.replace(/\/$/, ""));

    // Le câblage du profil (M-G) et celui des images par défaut, et rien
    // d'autre. Pas `ProfilMoi.tsx` ni `identite.ts` du paquet messagerie : l'un reçoit
    // `onPhoto` injecté, l'autre reçoit `televerser` — ils ne connaissent ni `Session`
    // ni le pipeline. C'est ce découplage qui garde la liste courte.
    const produit = appelants.filter(
      (chemin) => !chemin.includes("/tests/") && !chemin.endsWith("packages/media-pipeline/src/index.ts"),
    );
    expect(produit.sort()).toEqual([
      "apps/web/components/profil/EcranProfil.tsx",
      "apps/web/lib/identite-par-defaut.ts",
    ]);
  });
});

describe("on ne téléverse pas ce que le serveur refusera", () => {
  /**
   * Mesuré : une vidéo de onze minutes sort à environ 206 Mo aux cibles
   * D-04, au-dessus du plafond de 200 Mo du déploiement. Sans ce contrôle, le client
   * téléversait les 206 Mo pour s'entendre refuser à la fin — plusieurs minutes de réseau
   * et de batterie pour un échec connu d'avance.
   */
  const televersement = (taille: number) => ({
    chemin: ["file", "url"],
    ciphertext: new Uint8Array(taille) as never,
  });

  it("rend la taille fautive et le plafond, de quoi écrire une phrase juste", async () => {
    const refus = await refusePourTaille(session, [televersement(10), televersement(300 * 1024 * 1024)]);
    expect(refus).toEqual({ taille: 300 * 1024 * 1024, plafond: 200 * 1024 * 1024 });
  });

  it("sous le plafond, rien ne s'oppose à l'envoi", async () => {
    expect(await refusePourTaille(session, [televersement(1024)])).toBeUndefined();
  });

  it("un serveur qui n'annonce pas de plafond ne bloque rien", async () => {
    // Deviner un plafond serait pire que ne pas en avoir : le refus viendrait de nous,
    // sur une valeur inventée, alors que le serveur aurait accepté.
    fake.client.getMediaConfig.mockResolvedValueOnce({});
    expect(await refusePourTaille(session, [televersement(10 ** 9)])).toBeUndefined();

    fake.client.getMediaConfig.mockRejectedValueOnce(new Error("hors ligne"));
    expect(await refusePourTaille(session, [televersement(10 ** 9)])).toBeUndefined();
  });
});
