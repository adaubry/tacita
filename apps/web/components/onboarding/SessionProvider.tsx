"use client";

import { initSession, restoreSession, type Session } from "@tacita/client-core";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { etatDe, retirerJetonDeLUrl, urlConnexion, type EtatSession } from "../../lib/session";

/**
 * Filet de sécurité : au-delà de ce délai sans que la reprise ait abouti ni échoué, on
 * bascule en `echec`. iOS peut laisser une connexion IndexedDB pendante après avoir
 * suspendu la PWA — la promesse ne se résout alors jamais, et sans ce garde l'écran de
 * chargement tournerait à l'infini (aucune branche d'erreur n'est atteinte). Généreux
 * pour ne pas déclencher sur un premier `/sync` lent, court pour rester secourable.
 */
const DELAI_CHARGEMENT_MAX_MS = 20_000;

interface Contexte {
  etat: EtatSession;
  /** REQ-UI-04 — appelé par l'étape de récupération une fois la clé confirmée. */
  recuperationConfirmee: () => void;
  /** REQ-UIX-06 — wipe complet (REQ-COR-10), après confirmation explicite. */
  deconnecter: (session: Session) => Promise<void>;
  /** Relance la reprise de session depuis l'écran d'échec. */
  reessayer: () => void;
}

const ContexteSession = createContext<Contexte>({
  etat: { phase: "chargement" },
  recuperationConfirmee: () => {},
  deconnecter: async () => {},
  reessayer: () => {},
});

export const useSession = () => useContext(ContexteSession);

export interface SessionProviderProps {
  children: ReactNode;
  homeserverUrl: string;
  /** Injecté en test ; en production, la vraie redirection du navigateur. */
  rediriger?: (url: string) => void;
}

/**
 * REQ-UIX-06 — la reprise de session, dans l'ordre où elle se produit :
 *
 * 1. un jeton de connexion dans l'URL (retour du fournisseur OIDC) → on ouvre la session
 *    et **on retire le jeton de l'historique** ;
 * 2. sinon, une session restaurable en IndexedDB → arrivée directe sur l'Accueil, sans
 *    réseau ni écran intermédiaire ;
 * 3. sinon → retour à l'OIDC, sans écran intermédiaire non plus. Un écran « connectez-vous »
 *    qui ne fait que rediriger est une étape de plus pour rien.
 *
 * Un jeton restauré n'est pas validé (limite assumée de `client-core`) : un
 * `M_UNKNOWN_TOKEN` au premier appel se traduit ici par un retour à l'OIDC.
 */
export function SessionProvider({ children, homeserverUrl, rediriger }: SessionProviderProps) {
  const [etat, setEtat] = useState<EtatSession>({ phase: "chargement" });

  const versOidc = useCallback(() => {
    const aller = rediriger ?? ((url: string) => globalThis.location.assign(url));
    aller(urlConnexion(homeserverUrl, globalThis.location.origin));
  }, [homeserverUrl, rediriger]);

  // Une reprise en cours est identifiée par sa génération : le watchdog, le démontage et
  // un « Réessayer » l'invalident tous en l'incrémentant, ce qui neutralise une promesse
  // qui se résoudrait après coup (le cas iOS : IndexedDB qui répond très tard, ou jamais).
  const generation = useRef(0);

  const charger = useCallback(() => {
    const gen = ++generation.current;
    const valide = () => gen === generation.current;
    setEtat({ phase: "chargement" });

    const watchdog = setTimeout(() => {
      // Ni abouti ni rejeté à temps : on abandonne cette tentative (incrément) et on
      // rend la main à l'utilisateur au lieu de tourner indéfiniment.
      if (valide()) {
        generation.current += 1;
        setEtat({ phase: "echec" });
      }
    }, DELAI_CHARGEMENT_MAX_MS);

    const terminer = (suite: EtatSession) => {
      if (!valide()) return;
      clearTimeout(watchdog);
      setEtat(suite);
    };

    void (async () => {
      try {
        const jeton = retirerJetonDeLUrl(globalThis.location, globalThis.history);
        const session = jeton
          ? await initSession({ homeserverUrl, loginToken: jeton })
          : await restoreSession({ homeserverUrl });

        if (!valide()) return;
        if (!session) {
          terminer({ phase: "hors-session" });
          versOidc();
          return;
        }
        terminer(await etatDe(session));
      } catch {
        // Jeton révoqué, crypto indisponible, réseau absent au premier appel : dans tous
        // les cas l'entrée passe par l'OIDC. Rien n'est journalisé — un message d'erreur
        // de connexion peut porter le jeton.
        if (!valide()) return;
        terminer({ phase: "hors-session" });
        versOidc();
      }
    })();
  }, [homeserverUrl, versOidc]);

  useEffect(() => {
    charger();
    // Au démontage, on invalide la tentative en cours : sa résolution tardive ne doit
    // pas toucher l'état d'un provider qui n'existe plus.
    return () => {
      generation.current += 1;
    };
  }, [charger]);

  const recuperationConfirmee = useCallback(() => {
    setEtat((precedent) =>
      precedent.phase === "recuperation-requise"
        ? { phase: "prete", session: precedent.session }
        : precedent,
    );
  }, []);

  const deconnecter = useCallback(
    async (session: Session) => {
      await session.logout();
      setEtat({ phase: "hors-session" });
      versOidc();
    },
    [versOidc],
  );

  return (
    <ContexteSession.Provider value={{ etat, recuperationConfirmee, deconnecter, reessayer: charger }}>
      {children}
    </ContexteSession.Provider>
  );
}
