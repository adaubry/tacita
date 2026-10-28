import { describe, expect, it } from "vitest";
import { buildCsp } from "../lib/csp";
import { lire } from "./sources";

/**
 * Durcissement (pas de REQ de spec : à rattacher à un REQ-UI si le PM veut le tracer).
 * Le test exerce la seule chose qui rend la CSP utile ou inutile — les directives qui
 * décident si une XSS peut s'exécuter et exfiltrer, ou non.
 */
describe("Durcissement CSP — contenir une XSS : ni script étranger, ni exfiltration", () => {
  const csp = buildCsp("NONCE", {
    elementCallUrl: "https://call.tacita.chat/room",
    homeserverUrl: "https://chat.tacita.chat",
    dev: false,
  });
  const directive = (nom: string) =>
    csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d === nom || d.startsWith(`${nom} `));

  it("un <script> injecté ne s'exécute pas : nonce + strict-dynamic, jamais 'unsafe-inline'", () => {
    const script = directive("script-src")!;
    expect(script).toContain("'nonce-NONCE'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
  });

  it("l'app ne peut être ni encadrée, ni détournée par <base> ou un plugin", () => {
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("base-uri")).toBe("base-uri 'none'");
    expect(directive("object-src")).toBe("object-src 'none'");
  });

  it("seule l'origine Element Call du déploiement est un cadre autorisé — l'origine, pas l'URL", () => {
    expect(directive("frame-src")).toBe("frame-src https://call.tacita.chat");
  });

  it("les pièces jointes déchiffrées (blob:) s'affichent, la sortie réseau reste bornée", () => {
    expect(directive("img-src")).toContain("blob:");
    expect(directive("media-src")).toContain("blob:");
    // Deux origines et pas une de plus : la nôtre, et le homeserver du déploiement.
    // C'est la directive qui décide si une XSS peut exfiltrer une clé Megolm.
    expect(directive("connect-src")).toBe("connect-src 'self' https://chat.tacita.chat");
  });

  /**
   * **La CSP doit tenir en développement local aussi**, où le shard est servi par
   * `localhost:3000` contre un homeserver distant. `connect-src 'self'` seul y coupait
   * `/sync`, les médias et la connexion — et une CSP qu'on désactive pour travailler est
   * une CSP qui finit désactivée.
   */
  it("le homeserver est joignable même servi depuis une autre origine", () => {
    const local = buildCsp("N", {
      elementCallUrl: "https://call.example",
      homeserverUrl: "https://chat.spleen.blog/_matrix",
      dev: true,
    });
    // L'origine, jamais l'URL : un chemin dans une directive CSP ne veut rien dire ici.
    expect(local).toContain("connect-src 'self' https://chat.spleen.blog;");
  });

  it("le chiffrement en WebAssembly peut se compiler en production, sans ouvrir `eval`", () => {
    const script = directive("script-src")!;
    expect(script).toContain("'wasm-unsafe-eval'");
    expect(script.split(" ")).not.toContain("'unsafe-eval'");
  });

  it("chaque page est rendue à la requête : une page pré-rendue n'aurait aucun nonce", () => {
    // Avec 'strict-dynamic', un script sans nonce ne s'exécute pas, 'self' compris. Le
    // build de production pré-rendait les dix routes : 45 scripts, zéro nonce.
    const layout = lire("app/layout.tsx");
    expect(layout).toContain("await headers();");
  });

  it("'unsafe-eval' n'existe qu'en dev (HMR), jamais dans la CSP servie en production", () => {
    expect(
      buildCsp("N", {
        elementCallUrl: "https://c.example",
        homeserverUrl: "https://h.example",
        dev: true,
      }),
    ).toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
  });
});
