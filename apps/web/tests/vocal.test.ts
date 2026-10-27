import { describe, expect, it } from "vitest";

import { FORMATS_VOCAUX, fichierVocal, formatVocal, vocalDisponible } from "../lib/vocal";

/**
 * La cascade de formats vocaux. Elle décide, sur chaque appareil, lequel des quatre
 * paliers du pipeline sera emprunté — et s'il faut afficher un bouton micro du tout.
 *
 * Les cas ci-dessous sont des appareils réels, pas des combinaisons imaginées : les
 * réponses d'un iPhone en 18.7 viennent d'un relevé, pas d'un tableau de compatibilité.
 */

const accepte = (...types: string[]) => (type: string) => types.includes(type);

describe("le format vocal se négocie avec l'appareil", () => {
  it("prend l'Ogg/Opus quand il existe : le pipeline n'a alors rien à faire", () => {
    expect(formatVocal(accepte("audio/ogg;codecs=opus", "audio/webm;codecs=opus"))).toBe(
      "audio/ogg;codecs=opus",
    );
  });

  it("prend le WebM/Opus ensuite : un remuxage, sans ré-encodage", () => {
    // Chrome, Android, et iOS depuis 18.4.
    expect(formatVocal(accepte("audio/webm;codecs=opus", "audio/mp4"))).toBe(
      "audio/webm;codecs=opus",
    );
  });

  it("retombe sur le MP4 d'un Safari ancien plutôt que de renoncer", () => {
    expect(formatVocal(accepte("audio/mp4"))).toBe("audio/mp4");
  });

  it("ne rend rien quand l'appareil n'offre aucun format — et alors pas de bouton", () => {
    expect(formatVocal(accepte())).toBeUndefined();
  });

  /**
   * Le piège que ce test tient : un iPhone en 18.7 répond `true` à
   * `audio/mp4;codecs=opus`. Le fichier s'annoncerait `audio/mp4` en contenant de
   * l'Opus — que beaucoup de lecteurs ne décodent pas dans ce conteneur. Le repli
   * « lisible partout » reposerait sur une étiquette fausse.
   */
  it("ne demande jamais de l'Opus dans un conteneur MP4", () => {
    expect(FORMATS_VOCAUX).not.toContain("audio/mp4;codecs=opus");
    const iphone187 = accepte("audio/webm;codecs=opus", "audio/mp4;codecs=opus", "audio/mp4");
    expect(formatVocal(iphone187)).toBe("audio/webm;codecs=opus");
  });

  it("traite une exception comme un refus : Safari lève au lieu de rendre false", () => {
    const grognon = (type: string) => {
      if (type.startsWith("audio/ogg")) throw new TypeError("type inconnu");
      return type === "audio/mp4";
    };
    expect(formatVocal(grognon)).toBe("audio/mp4");
  });
});

describe("la disponibilité se lit sur l'appareil, pas sur son nom", () => {
  const portee = (recorder: unknown, micro: boolean) =>
    ({
      MediaRecorder: recorder,
      navigator: micro ? { mediaDevices: { getUserMedia: () => {} } } : {},
    }) as unknown as typeof globalThis;

  it("rend le format quand l'enregistreur et le micro sont là", () => {
    expect(
      vocalDisponible(portee({ isTypeSupported: (t: string) => t === "audio/mp4" }, true)),
    ).toBe("audio/mp4");
  });

  it("ne rend rien sans MediaRecorder", () => {
    expect(vocalDisponible(portee(undefined, true))).toBeUndefined();
  });

  /** Un contexte non sécurisé retire `getUserMedia` en laissant `MediaRecorder`. */
  it("ne rend rien sans getUserMedia, même si l'enregistreur existe", () => {
    expect(
      vocalDisponible(portee({ isTypeSupported: () => true }, false)),
    ).toBeUndefined();
  });
});

describe("le fichier produit décrit ce qu'il contient", () => {
  it("lit le type sur le blob, jamais sur ce qu'on avait demandé", () => {
    // Safari a déjà rendu autre chose que le `mimeType` demandé : mentir au pipeline
    // enverrait cet AAC dans le chemin du remuxage WebM, sur des octets inconnus.
    const fichier = fichierVocal(
      [new Blob(["aac"], { type: "audio/mp4" })],
      "audio/webm;codecs=opus",
      1700000000000,
    );
    expect(fichier.type).toBe("audio/mp4");
    expect(fichier.name).toBe("vocal-1700000000000.m4a");
  });

  it("retombe sur le format demandé quand le navigateur n'a rien déclaré", () => {
    const fichier = fichierVocal([new Blob(["ogg"])], "audio/ogg;codecs=opus", 1);
    expect(fichier.type).toBe("audio/ogg;codecs=opus");
    expect(fichier.name).toBe("vocal-1.ogg");
  });

  it("donne au WebM son extension", () => {
    const fichier = fichierVocal(
      [new Blob(["webm"], { type: "audio/webm;codecs=opus" })],
      "audio/webm;codecs=opus",
      2,
    );
    expect(fichier.name).toBe("vocal-2.webm");
  });
});
