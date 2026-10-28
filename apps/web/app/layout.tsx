import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";

// `tokens.css` en premier, et l'ordre compte : il ouvre par la déclaration des couches en
// cascade, qui n'a d'effet que si elle précède la première feuille qui en utilise une.
import "../components/foundation/tokens.css";
import "@astryxdesign/core/astryx.css";
import { PALETTE } from "../components/foundation/palette";
import { Providers } from "./providers";
import { RegisterServiceWorker } from "./register-sw";

export const metadata: Metadata = {
  title: "Tacita",
  // le manifeste est un fichier statique : le service worker doit pouvoir
  // le précacher comme le reste de la coquille.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Tacita", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  // `viewport-fit=cover` : sans lui, `env(safe-area-inset-*)` vaut zéro et la navbar
  // passe sous la barre de gestes en PWA installée sur iOS.
  viewportFit: "cover",
  // La barre système du navigateur : lue avant toute feuille de style, elle ne peut pas
  // prendre une variable CSS. Elle vient donc du thème, jamais d'une valeur recopiée.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PALETTE.bg.clair },
    { media: "(prefers-color-scheme: dark)", color: PALETTE.bg.sombre },
  ],
};

/*
 * **Rendu à la demande, pour que chaque script porte le nonce de la CSP.** Next.js ne pose
 * le nonce que sur les pages rendues à la requête ; pré-rendues au build, elles servaient
 * 45 scripts sans nonce, et `'strict-dynamic'` — qui ignore `'self'` — les aurait tous
 * bloqués : une app blanche (mesuré sur le build de production). Lire `headers()` suffit
 * à rendre toute l'arborescence dynamique. Le pré-rendu perdu ne coûte presque rien à une
 * instance auto-hébergée ; le service worker garde la coquille, HTML et en-têtes ensemble.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await headers();
  return (
    <html lang="fr">
      <body>
        <Providers>{children}</Providers>
        <RegisterServiceWorker />
      </body>
    </html>
  );
}
