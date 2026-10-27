/**
 * L'écran de connexion : identifiant, mot de passe, et la porte de secours.
 *
 * Trois voies — se connecter, créer un compte, ou entrer par la clé de récupération
 * quand le mot de passe est perdu. `MESSAGES` tient les échecs : chacun dit ce qui
 * s'est passé et ce qu'on peut faire, jamais « erreur ».
 *
 * Les garde-fous de clavier sont portés par le parent : un identifiant Matrix est en
 * minuscules, et une majuscule posée par un clavier mobile donne un compte
 * introuvable sans que personne ne voie ce qui a changé.
 */
"use client";

import {
  connexionParCle,
  creerCompte,
  initSession,
  LONGUEUR_MINIMALE_MOT_DE_PASSE,
  type Session,
} from "@tacita/client-core";
import { useState } from "react";

import { IconeCle } from "../foundation/icons";
import { Banner, Button, Text, TextInput, VStack } from "../foundation/primitives";

/**
 * **l'écran de connexion**, réécrit.
 *
 * Il n'existait pas : la connexion partait chez un fournisseur OIDC externe, et cet
 * écran-ci était une phrase d'attente pendant la redirection. Keycloak supprimé, l'identité
 * est portée par Synapse — le formulaire revient donc dans le produit, et c'est le premier
 * écran que voit quelqu'un qui n'a pas de session.
 *
 * **Un seul écran pour les deux gestes**, pas deux routes. Se connecter et créer un compte
 * demandent les deux mêmes champs ; les séparer aurait fait deux formulaires jumeaux à
 * tenir en phase, et obligé à choisir avant de savoir. La bascule ne perd pas la saisie :
 * quelqu'un qui se trompe de mode a déjà tapé son identifiant.
 *
 * **Deux champs, et deux seulement** (même jour) : créer un compte demande un
 * identifiant et un mot de passe. Le code d'invitation qu'exigeait la première version a
 * été retiré du serveur, donc de l'écran — ce que ça ouvre est assumé et écrit dans
 * C'est une limite assumée ; ce n'est pas au formulaire de la compenser.
 *
 * **Un troisième mode, et c'est une porte de secours** : la clé de récupération
 * ouvre une session quand le mot de passe est perdu. Elle n'est pas offerte à côté des
 * deux autres — on y arrive par « Mot de passe oublié ? », et l'écran dit ce qu'elle
 * engage. Sans elle, un mot de passe oublié est un compte mort : ce déploiement n'a ni
 * e-mail ni SSO, et le changement de mot de passe exige déjà la clé.
 *
 * Ce que cet écran ne fait pas, et qui appartient à la porte : décider de ce qui vient
 * après. Il rend une `Session`, `RecoveryGate` s'occupe du reste (clé, parcours d'accueil).
 */
type Mode = "connexion" | "creation" | "cle";

/** Ce qui a échoué, dit dans les mots de la personne et non dans ceux du protocole. */
type Echec = "identifiants" | "court" | "refus" | "pris" | "cle" | "reseau";

const MESSAGES: Record<Echec, string> = {
  identifiants: "Identifiant ou mot de passe incorrect.",
  court: `Choisissez un mot de passe d'au moins ${LONGUEUR_MINIMALE_MOT_DE_PASSE} caractères.`,
  refus: "La création de compte est refusée par ce serveur.",
  pris: "Cet identifiant est déjà pris.",
  cle: "Identifiant ou clé de récupération incorrect.",
  reseau: "Le serveur n'a pas répondu. Réessayez.",
};

/**
 * Classe l'échec par **ce que la personne doit faire**, jamais par son code HTTP (règle 2).
 *
 * Le message du serveur n'est jamais affiché : sur ce chemin il peut porter l'identifiant
 * tapé, et un mot de passe faux se dit autrement qu'un identifiant déjà pris — la même
 * phrase pour les deux enverrait corriger le mauvais champ.
 */
function classer(erreur: unknown, mode: Mode): Echec {
  const { errcode } = (erreur ?? {}) as { errcode?: string };
  if (errcode === "M_USER_IN_USE") return "pris";
  /*
   * le module refuse d'un seul message pour quatre causes : compte inconnu,
   * désactivé, sans clé, ou clé fausse. Les distinguer donnerait un oracle de comptes à
   * qui interroge cette porte ouverte (même jurisprudence que), et l'écran ne
   * peut donc rien dire de plus honnête que « l'un des deux est faux ».
   */
  if (mode === "cle" && errcode === "M_FORBIDDEN") return "cle";
  /*
   * Le serveur exige une étape d'inscription que le client ne sait pas franchir — un code
   * d'invitation remis par exemple (le repli écrit dans D-13). Il a répondu, et vite :
   * « le serveur n'a pas répondu » enverrait réessayer sans fin. Le message dit donc
   * refus, parce que c'en est un, et parce que rien dans cet écran ne peut le lever.
   */
  if (errcode === "TACITA_INSCRIPTION_IMPOSSIBLE") return "refus";
  if (errcode === "M_FORBIDDEN") return mode === "creation" ? "refus" : "identifiants";
  if (mode === "cle") return "reseau";
  if (errcode === "M_UNAUTHORIZED" || errcode === "M_INVALID_PARAM") return "identifiants";
  return "reseau";
}

export function Connexion({
  homeserverUrl,
  onSession,
  indexedDB,
}: {
  homeserverUrl: string;
  onSession: (session: Session) => void;
  /** surchargeable en test ; `globalThis.indexedDB` en navigateur. */
  indexedDB?: IDBFactory;
}) {
  const [mode, setMode] = useState<Mode>("connexion");
  const [identifiant, setIdentifiant] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [cleRecuperation, setCleRecuperation] = useState("");
  const [echec, setEchec] = useState<Echec>();
  const [enCours, setEnCours] = useState(false);

  const creation = mode === "creation";
  const parCle = mode === "cle";
  const complet =
    identifiant.trim() !== "" && (parCle ? cleRecuperation.trim() !== "" : motDePasse !== "");

  const soumettre = async () => {
    if (!complet || enCours) return;
    /*
     * Le plancher est **serveur** (`password_config.policy`) : ce contrôle-ci ne le
     * remplace pas, il évite d'envoyer un mot de passe pour se faire refuser. Le nombre
     * vient du paquet, pas d'une constante d'écran — trois copies avaient déjà divergé.
     */
    if (creation && motDePasse.length < LONGUEUR_MINIMALE_MOT_DE_PASSE) {
      setEchec("court");
      return;
    }
    setEnCours(true);
    setEchec(undefined);
    try {
      const config = { homeserverUrl, identifiant: identifiant.trim(), motDePasse, indexedDB };
      if (parCle) {
        onSession(
          await connexionParCle({ ...config, cleRecuperation: cleRecuperation.trim() }),
        );
      } else {
        onSession(creation ? await creerCompte(config) : await initSession(config));
      }
    } catch (erreur) {
      // Rien n'est journalisé : le mot de passe est dans la portée de ce bloc.
      setEchec(classer(erreur, mode));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <VStack style={{ gap: "var(--spacing-12)" }}>
      <VStack hAlign="center">
        <div
          aria-hidden
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 88,
            height: 88,
            borderRadius: "var(--radius-full)",
            backgroundColor: "var(--color-accent-muted)",
            color: "var(--color-accent)",
          }}
        >
          {IconeCle}
        </div>
      </VStack>

      <VStack gap={8}>
        <VStack gap={5}>
          <Text type="display-3" as="h1" style={{ textWrap: "balance" }}>
            {parCle
              ? "Entrer avec votre clé"
              : creation
                ? "Créez votre compte"
                : "Connectez-vous"}
          </Text>
          <Text style={{ textWrap: "pretty" }}>
            {parCle
              ? "Votre clé de récupération ouvre une session quand le mot de passe est perdu. Choisissez ensuite un nouveau mot de passe dans Réglages."
              : creation
                ? `Choisissez un identifiant et un mot de passe d'au moins ${LONGUEUR_MINIMALE_MOT_DE_PASSE} caractères. Rien d'autre n'est demandé : ni e-mail, ni code d'invitation.`
                : "Votre identifiant est celui que vous avez choisi à la création du compte."}
          </Text>
          {/*
            D-14 — la contrepartie, dite là où le geste se fait. Même formulation que
            l'écran de changement de mot de passe : la clé part vers le serveur, et un
            serveur qui la garderait déchiffrerait tout. En `warning`, pas en `danger` :
            c'est de quoi décider, pas un acte destructif.
          */}
          {parCle && (
            <Banner
              status="warning"
              title="Une mesure exceptionnelle"
              description="Votre clé est transmise au serveur pour vérifier que c'est bien vous, et elle ouvre alors le compte à elle seule. Ne l'utilisez que si le mot de passe est perdu."
            />
          )}
        </VStack>

        <VStack gap={4}>
          {/*
            Mêmes garde-fous de clavier que l'écran de clé, et portés par le parent pour la
            même raison (on ne recode pas une primitive). Un identifiant
            Matrix est en minuscules : une majuscule posée par un clavier mobile donne un
            compte introuvable, sans que personne ne voie ce qui a changé.
          */}
          <div autoCapitalize="none" autoCorrect="off" spellCheck={false}>
            <TextInput
              label="Identifiant"
              value={identifiant}
              onChange={(v) => {
                setIdentifiant(v);
                setEchec(undefined);
              }}
              onEnter={() => void soumettre()}
              placeholder="alice"
              hasAutoFocus
              width="100%"
              status={
                echec === "pris" ? { type: "error", message: MESSAGES.pris } : undefined
              }
            />
          </div>

          {!parCle && (
            <TextInput
              label="Mot de passe"
              type="password"
              value={motDePasse}
              onChange={(v) => {
                setMotDePasse(v);
                setEchec(undefined);
              }}
              onEnter={() => void soumettre()}
              width="100%"
              status={
                echec === "identifiants" || echec === "court"
                  ? { type: "error", message: MESSAGES[echec] }
                  : undefined
              }
            />
          )}

          {/* Le base58 est sensible à la casse : mêmes garde-fous de clavier qu'ailleurs. */}
          {parCle && (
            <div autoCapitalize="none" autoCorrect="off" spellCheck={false}>
              <TextInput
                label="Clé de récupération"
                value={cleRecuperation}
                onChange={(v) => {
                  setCleRecuperation(v);
                  setEchec(undefined);
                }}
                onEnter={() => void soumettre()}
                placeholder="EsTb ABCD EFGH …"
                width="100%"
                status={echec === "cle" ? { type: "error", message: MESSAGES.cle } : undefined}
              />
            </div>
          )}

          {/*
            D-13 — il n'y a pas de troisième champ. Le code d'invitation vivait ici ; le
            serveur ne l'exige plus (`registration_requires_token` retiré), et un champ
            qui n'est plus lu est pire qu'absent : il fait chercher un code à quelqu'un
            qui n'en a pas besoin.
          */}
          {(echec === "reseau" || echec === "refus") && (
            <Text type="supporting" style={{ color: "var(--color-error)" }}>
              {MESSAGES[echec]}
            </Text>
          )}

          <Button
            label={parCle ? "Ouvrir ma session" : creation ? "Créer mon compte" : "Se connecter"}
            variant="primary"
            isLoading={enCours}
            isDisabled={!complet}
            onClick={() => void soumettre()}
          />

          {/*
            La bascule est en `ghost` sous l'action : un seul aplat plein par vue, comme
            partout ailleurs dans ce parcours. Elle ne vide pas les champs — se tromper de
            mode ne doit pas coûter la saisie déjà faite.
          */}
          <VStack hAlign="center">
            <Button
              label={
                parCle
                  ? "Revenir à la connexion"
                  : creation
                    ? "J'ai déjà un compte"
                    : "Créer un compte"
              }
              variant="ghost"
              onClick={() => {
                setMode(mode === "connexion" ? "creation" : "connexion");
                setEchec(undefined);
              }}
            />
            {/*
              D-14 — la porte de secours ne s'offre pas au même rang que les deux gestes
              normaux : elle se trouve quand on la cherche. Elle n'apparaît qu'en mode
              connexion — la proposer à quelqu'un qui crée son compte n'aurait aucun sens,
              il n'a pas encore de clé.
            */}
            {mode === "connexion" && (
              <Button
                label="Mot de passe oublié ?"
                variant="ghost"
                onClick={() => {
                  setMode("cle");
                  setEchec(undefined);
                }}
              />
            )}
          </VStack>
        </VStack>
      </VStack>
    </VStack>
  );
}
