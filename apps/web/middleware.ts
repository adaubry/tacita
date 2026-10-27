import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "./lib/csp";

/**
 * Durcissement — pose la CSP (avec un nonce par requête) et les en-têtes de sécurité qui
 * l'accompagnent. Next lit le nonce dans l'en-tête `content-security-policy` de la requête
 * et l'appose sur ses propres `<script>` : c'est ce qui permet `script-src 'nonce-…'` sans
 * casser l'hydratation.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce, {
    elementCallUrl: process.env.NEXT_PUBLIC_ELEMENT_CALL_URL ?? "https://call.example.org",
    // Le repli vaut `'self'` deux fois : une variable absente ne doit pas ouvrir la
    // politique sur un domaine arbitraire, et pas davantage faire planter le rendu.
    homeserverUrl: process.env.NEXT_PUBLIC_HOMESERVER_URL ?? request.nextUrl.origin,
    dev: process.env.NODE_ENV === "development",
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", csp);
  // HSTS : le contexte sécurisé est déjà exigé (REQ-INF-10) ; ceci empêche une première
  // requête en clair. `preload` suppose le domaine soumis à la liste HSTS des navigateurs.
  response.headers.set("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("referrer-policy", "same-origin");
  return response;
}

export const config = {
  // Tout sauf les assets versionnés, le service worker et le manifeste : ils restent
  // cacheables, et le nonce forcerait un rendu dynamique inutile sur eux.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icone-).*)",
  ],
};
