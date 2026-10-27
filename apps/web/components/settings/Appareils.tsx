/**
 * La liste des appareils connectés, et leur révocation.
 *
 * Une dernière activité peut manquer : le serveur ne la connaît que si l'appareil a
 * parlé depuis qu'il la retient. On n'affiche alors rien plutôt qu'une date inventée —
 * un « jamais vu » lu comme « inactif » ferait révoquer le mauvais appareil.
 */
"use client";

import type { Appareil, Session } from "@tacita/client-core";
import { useCallback, useEffect, useState } from "react";

import { dateComplete } from "../../lib/dates";
import { IconeInfo } from "../foundation/icons";
import { Placeholder } from "../foundation/Placeholder";
import { Banner, Button, Divider, Text, TextInput, VStack } from "../foundation/primitives";
import { Skeleton } from "../foundation/Skeleton";

/**
 * **les appareils connectés, et le moyen de les déconnecter.**
 *
 * Il n'existait rien de tel, et l'audit a dit ce que ça voulait dire mis
 * bout à bout : les jetons d'accès de ce déploiement n'expirent jamais, le changement de
 * mot de passe ne déconnecte volontairement personne (pour ne pas faire perdre son
 * historique déchiffré à chaque appareil), et la clé de récupération ouvre une session à
 * elle seule. Un jeton qui fuit restait donc valable pour toujours, sans que son
 * propriétaire puisse ni le voir ni le révoquer. **Après une compromission, il n'y avait
 * rien à faire** — et un produit qui garde une promesse de confidentialité doit au
 * minimum offrir le geste de la reprendre.
 *
 * Ce que cet écran ne fait pas : deviner. Une session inconnue ne se distingue pas d'un
 * vieil appareil oublié, et Synapse ne connaît pas toujours la dernière activité. On
 * montre ce qu'on sait, on écrit « inconnue » quand on ne sait pas, et c'est la personne
 * qui tranche.
 */
type Etat =
  | { phase: "chargement" }
  | { phase: "prete"; appareils: Appareil[] }
  | { phase: "indisponible" };

/** Ce que le serveur a refusé, dit par ce que la personne peut y faire (règle 2). */
type Echec = "motdepasse" | "reseau";

const MESSAGES: Record<Echec, string> = {
  motdepasse: "Mot de passe incorrect.",
  reseau: "La déconnexion n'a pas abouti. Réessayez.",
};

/**
 * La dernière activité, dite en clair. Le format long plutôt qu'un « il y a 3 jours » :
 * on est en train de décider si une session est la sienne, et une date exacte se compare
 * à un souvenir — « il y a 3 jours » ne se compare à rien.
 */
const dateLisible = (ms?: number) =>
  ms === undefined ? "Dernière activité inconnue" : `Vu le ${dateComplete(ms)}`;

export function Appareils({ session }: { session: Session }) {
  const [etat, setEtat] = useState<Etat>({ phase: "chargement" });
  const [cible, setCible] = useState<Appareil[]>();
  const [motDePasse, setMotDePasse] = useState("");
  const [echec, setEchec] = useState<Echec>();
  const [enCours, setEnCours] = useState(false);

  const relire = useCallback(async () => {
    try {
      setEtat({ phase: "prete", appareils: await session.appareils() });
    } catch {
      // Rien n'est journalisé : la liste porte des identifiants d'appareil, et l'erreur
      // du SDK peut porter l'identifiant du compte.
      setEtat({ phase: "indisponible" });
    }
  }, [session]);

  useEffect(() => {
    void relire();
  }, [relire]);

  const revoquer = async () => {
    if (!cible || enCours) return;
    setEnCours(true);
    setEchec(undefined);
    try {
      /*
       * Le mot de passe n'est envoyé que si le module ne l'a pas déjà : après une
       * connexion, le champ ne s'affiche même pas. Ce qui suit vaut donc pour une page
       * rechargée, où plus personne ne le connaît.
       */
      await session.revoquerAppareils(
        cible.map((appareil) => appareil.id),
        motDePasse === "" ? undefined : motDePasse,
      );
      setMotDePasse("");
      setCible(undefined);
      await relire();
    } catch (erreur) {
      const { errcode } = (erreur ?? {}) as { errcode?: string };
      // Un 401 sur ce chemin veut dire « le serveur a redemandé, et ce qu'on a donné ne
      // vaut pas » : c'est le mot de passe, jamais autre chose.
      setEchec(errcode === "M_FORBIDDEN" || errcode === "M_UNAUTHORIZED" ? "motdepasse" : "reseau");
    } finally {
      setEnCours(false);
    }
  };

  if (etat.phase === "chargement") {
    // DESIGN.md : pas de spinner plein écran. Une géométrie d'attente, localisée.
    return (
      <VStack gap={2} style={{ padding: "var(--spacing-3)" }}>
        <Skeleton height={64} />
        <Skeleton height={64} />
      </VStack>
    );
  }

  if (etat.phase === "indisponible") {
    return (
      <div style={{ padding: "var(--spacing-3)" }}>
        <Placeholder
          icone={IconeInfo}
          titre="La liste n'a pas pu être lue"
          explication="Le serveur n'a pas répondu. Rouvrez cet écran pour réessayer."
        />
      </div>
    );
  }

  /*
   * La confirmation **remplace** la liste au lieu de se poser dessus : on est déjà dans
   * une feuille, et empiler une seconde surface par-dessus une première ferait deux
   * gestes de retour pour une seule décision.
   */
  if (cible) {
    const multiple = cible.length > 1;
    return (
      <VStack gap={5} style={{ padding: "var(--spacing-3)" }}>
        <Text type="display-3" as="h2" style={{ textWrap: "balance" }}>
          {multiple ? "Déconnecter les autres appareils ?" : "Déconnecter cet appareil ?"}
        </Text>
        <Text style={{ textWrap: "pretty" }}>
          {multiple
            ? "Toutes les autres sessions seront fermées immédiatement. Celle-ci reste ouverte."
            : `« ${cible[0]!.nom ?? cible[0]!.id} » sera déconnecté immédiatement.`}{" "}
          Les messages déjà reçus par cet appareil y restent lisibles tant qu&apos;il n&apos;est
          pas effacé — la déconnexion ferme l&apos;accès au compte, elle ne vide pas ce qui a
          déjà été téléchargé.
        </Text>

        <TextInput
          label="Votre mot de passe"
          type="password"
          value={motDePasse}
          onChange={(v) => {
            setMotDePasse(v);
            setEchec(undefined);
          }}
          onEnter={() => void revoquer()}
          width="100%"
          status={echec === "motdepasse" ? { type: "error", message: MESSAGES.motdepasse } : undefined}
        />
        <Text type="supporting" color="secondary">
          Le serveur le redemande pour ce geste : c&apos;est exactement celui qu&apos;un
          intrus retournerait contre vous.
        </Text>

        {echec === "reseau" && (
          <Text type="supporting" style={{ color: "var(--color-error)" }}>
            {MESSAGES.reseau}
          </Text>
        )}

        <Button
          label={multiple ? "Déconnecter les autres" : "Déconnecter"}
          variant="destructive"
          isLoading={enCours}
          onClick={() => void revoquer()}
        />
        <VStack hAlign="center">
          <Button
            label="Annuler"
            variant="ghost"
            onClick={() => {
              setCible(undefined);
              setMotDePasse("");
              setEchec(undefined);
            }}
          />
        </VStack>
      </VStack>
    );
  }

  const autres = etat.appareils.filter((appareil) => !appareil.courant);

  return (
    <VStack gap={4} style={{ padding: "var(--spacing-3)" }}>
      <Text style={{ textWrap: "pretty" }}>
        Chaque connexion ouvre un appareil, et il le reste tant que vous ne le fermez pas.
        Si vous n&apos;en reconnaissez pas un, déconnectez-le et changez votre mot de passe.
      </Text>

      <VStack gap={3}>
        {etat.appareils.map((appareil) => (
          <div key={appareil.id}>
            <VStack gap={1}>
              <Text>
                {appareil.nom ?? "Appareil sans nom"}
                {appareil.courant ? " · celui-ci" : ""}
              </Text>
              <Text type="supporting" color="secondary">
                {dateLisible(appareil.derniereActivite)}
              </Text>
              {!appareil.courant && (
                <div>
                  <Button
                    label="Déconnecter"
                    variant="ghost"
                    onClick={() => setCible([appareil])}
                  />
                </div>
              )}
            </VStack>
            <Divider />
          </div>
        ))}
      </VStack>

      {autres.length > 0 ? (
        <Banner
          status="info"
          title={`${autres.length} autre${autres.length > 1 ? "s" : ""} session${autres.length > 1 ? "s" : ""} ouverte${autres.length > 1 ? "s" : ""}`}
          description="Un mot de passe changé ne les ferme pas : elles gardent leur accès jusqu'à ce que vous les déconnectiez."
        />
      ) : (
        <Text type="supporting" color="secondary">
          Aucune autre session n&apos;est ouverte.
        </Text>
      )}

      {autres.length > 0 && (
        <Button
          label="Déconnecter les autres appareils"
          variant="destructive"
          onClick={() => setCible(autres)}
        />
      )}
    </VStack>
  );
}
