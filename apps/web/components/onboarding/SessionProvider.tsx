"use client";

import { onSessionInvalidee, restoreSession, type Session } from "@tacita/client-core";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { ecrireOnboardingEnCours } from "../../lib/preferences";
import { etatDe, type EtatSession } from "../../lib/session";

/** Au-delà, la reprise n'a ni abouti ni échoué : on propose de réessayer. */
const DELAI_CHARGEMENT_MAX_MS = 20_000;

interface Contexte {
  etat: EtatSession;
  /**
   * appelé par l'étape de récupération une fois la clé confirmée (création)
   * ou l'appareil déverrouillé (reconnexion). Les deux gestes finissent au même endroit :
   * cet appareil est désormais signé, la porte s'ouvre.
   */
  recuperationConfirmee: () => void;
  /**
   * le parcours d'accueil est terminé (ou n'a jamais commencé). C'est la
   * seule chose qui rende l'app atteignable une fois la clé confirmée sur un compte neuf.
   */
  onboardingTermine: () => void;
  /** wipe complet, après confirmation explicite. */
  deconnecter: (session: Session) => Promise<void>;
  /**
   * une session que l'écran de connexion vient d'ouvrir. C'est lui qui
   * parle au réseau ; le provider ne fait que router l'état qui en sort.
   */
  sessionOuverte: (session: Session) => void;
  /** Relance la reprise de session depuis l'écran d'échec. */
  reessayer: () => void;
}

const ContexteSession = createContext<Contexte>({
  etat: { phase: "chargement" },
  recuperationConfirmee: () => {},
  onboardingTermine: () => {},
  deconnecter: async () => {},
  sessionOuverte: () => {},
  reessayer: () => {},
});

export const useSession = () => useContext(ContexteSession);

interface SessionProviderProps {
  children: ReactNode;
  homeserverUrl: string;
  /** surchargeable en test ; `globalThis.indexedDB` en navigateur. */
  indexedDB?: IDBFactory;
}

/**
 * la reprise de session, réduite à deux cas depuis D-12 :
 *
 * 1. une session restaurable en IndexedDB → arrivée directe sur l'Accueil, sans réseau ni
 *    écran intermédiaire ;
 * 2. sinon → l'écran de connexion, rendu par la porte.
 *
 * Le premier cas — un jeton de connexion à lire dans l'URL, puis à retirer de l'historique
 * — a disparu avec le SSO : il n'y a plus de retour de fournisseur, donc plus de secret qui
 * transite par la barre d'adresse.
 *
 * Un jeton restauré n'est pas validé (limite assumée de `client-core`) : un
 * `M_UNKNOWN_TOKEN` au premier appel se traduit ici par un retour au formulaire.
 */
export function SessionProvider({ children, homeserverUrl, indexedDB }: SessionProviderProps) {
  const [etat, setEtat] = useState<EtatSession>({ phase: "chargement" });
  const base = indexedDB ?? globalThis.indexedDB;

  // Une reprise est identifiée par sa génération : le watchdog, le démontage et « Réessayer »
  // l'invalident en l'incrémentant, ce qui neutralise une promesse résolue après coup.
  const generation = useRef(0);

  const charger = useCallback(() => {
    const gen = ++generation.current;
    setEtat({ phase: "chargement" });

    // Filet de sécurité : iOS peut laisser une connexion IndexedDB pendante après avoir
    // suspendu la PWA — ni succès ni erreur, et l'écran de chargement tournait à l'infini.
    const watchdog = setTimeout(() => terminer({ phase: "echec" }), DELAI_CHARGEMENT_MAX_MS);

    function terminer(suite: EtatSession) {
      if (gen !== generation.current) return;
      generation.current += 1;
      clearTimeout(watchdog);
      setEtat(suite);
    }

    void (async () => {
      try {
        const session = await restoreSession({ homeserverUrl, indexedDB: base });
        // plus de redirection : sans session, la porte rend le formulaire.
        terminer(session ? await etatDe(session, base) : { phase: "hors-session" });
      } catch {
        // Jeton révoqué, crypto indisponible, réseau absent au premier appel : dans tous
        // les cas l'entrée repasse par le formulaire. Rien n'est journalisé — un message
        // d'erreur de connexion peut porter l'identifiant.
        terminer({ phase: "hors-session" });
      }
    })();
  }, [homeserverUrl, base]);

  useEffect(() => {
    charger();
    return () => {
      generation.current += 1;
    };
  }, [charger]);

  /*
   * un jeton que le serveur refuse ne doit pas survivre à l'écran.
   *
   * Mesuré au navigateur : session révoquée côté serveur, page rechargée,
   * et l'application se rouvrait comme si de rien n'était — les credentials locaux
   * suffisaient à la faire démarrer, et le refus n'arrivait que plus tard, dans /sync.
   * Le SDK a un signal pour ça, et c'est le seul qui distingue « refusé » de « injoignable ».
   */
  useEffect(() => {
    if (etat.phase !== "prete" && etat.phase !== "recuperation-requise") return;
    return onSessionInvalidee(etat.session, () => setEtat({ phase: "hors-session" }));
  }, [etat]);

  const recuperationConfirmee = useCallback(() => {
    if (etat.phase !== "recuperation-requise") return;

    /*
     * **le seul endroit du produit où « le compte vient d'être créé » est une
     * information disponible.** `mode` vaut `creation` quand le compte n'a aucune identité
     * cross-signing, c'est-à-dire à la toute première ouverture et à ce moment-là
     * seulement ; toute reconnexion passe par `deverrouillage`.
     *
     * C'est donc ici, et nulle part ailleurs, que le parcours d'accueil peut savoir qu'il
     * a lieu d'être. Un déverrouillage, lui, entre directement dans l'app : la personne a
     * déjà un profil, des notifications réglées et des conversations — lui rejouer le
     * parcours serait lui redemander ce qu'elle a déjà répondu.
     *
     * La marque IndexedDB qui rend le parcours reprenable après un rechargement est posée
     * par le parcours lui-même (`Onboarding`), pas ici : c'est lui qui sait quand il
     * commence et quand il finit.
     *
     * **Mais `mode` ne suffit pas à décider seul** (corrigé). Il dit d'où
     * l'on sort, pas où l'on en était : une inscription interrompue au dépôt de l'identité
     * repart en `deverrouillage`, et le parcours — commencé, marqué, jamais fini — était
     * alors jeté. Symptôme exact remonté par l'utilisateur : la clé recréée, puis l'accueil
     * d'une application vide au lieu de l'étape suivante. La marque est la seule chose qui
     * sache répondre, et `etatDe` l'a déjà lue pour les deux phases.
     */
    setEtat({
      phase: "prete",
      session: etat.session,
      onboarding: etat.mode === "creation" || etat.onboarding,
    });
  }, [etat]);

  const onboardingTermine = useCallback(() => {
    if (etat.phase !== "prete") return;
    // Sans bruit si l'écriture échoue : le pire cas est un parcours reproposé au prochain
    // lancement, jamais une app inatteignable — la marque n'ouvre aucune porte, elle en
    // retarde une.
    if (base) void ecrireOnboardingEnCours(base, false).catch(() => {});
    setEtat({ phase: "prete", session: etat.session });
  }, [etat, base]);

  /*
   * **la déconnexion redevient locale, et c'est tout**.
   *
   * Elle traînait un défaut tant que Keycloak existait : `logout()` révoquait le jeton
   * Matrix, mais le cookie de session du fournisseur y survivait, et le retour vers
   * `/login/sso/redirect` rouvrait une session dans la seconde — sur un appareil neuf, donc
   * sur l'écran de clé de récupération. Sans fournisseur externe, il n'y a plus de session
   * ailleurs : révoquer et effacer suffit, et la porte rend le formulaire.
   */
  const deconnecter = useCallback(async (session: Session) => {
    await session.logout();
    setEtat({ phase: "hors-session" });
  }, []);

  /** L'écran de connexion a ouvert une session : on repart par le même chemin que la reprise. */
  const sessionOuverte = useCallback(
    (session: Session) => void etatDe(session, base).then(setEtat),
    [base],
  );

  return (
    <ContexteSession.Provider
      value={{ etat, recuperationConfirmee, onboardingTermine, deconnecter, sessionOuverte, reessayer: charger }}
    >
      {children}
    </ContexteSession.Provider>
  );
}
