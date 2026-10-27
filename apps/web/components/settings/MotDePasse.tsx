"use client";

import {
  changerMotDePasse,
  LONGUEUR_MINIMALE_MOT_DE_PASSE,
  type Session,
} from "@tacita/client-core";
import { useState } from "react";

import { Banner, Button, Text, TextInput, VStack } from "../foundation/primitives";

/**
 * **changer son mot de passe, la clé de récupération à l'appui.**
 *
 * Le mot de passe courant n'est pas demandé, et ce n'est pas un oubli : il n'autorise rien
 * ici. C'est la clé de récupération qui garde ce changement, et elle seule — une session
 * volée, qui connaît pourtant le mot de passe courant, ne peut pas s'en servir pour
 * s'approprier le compte.
 *
 * Le garde est **serveur** : `POST /_matrix/client/v3/account/password` est fermé au proxy
 * et le module Synapse exige la clé. Ce que cet écran vérifie avant d'envoyer ne remplace
 * rien — c'est ce qui rend une faute de frappe immédiate, et ce qui évite d'exposer la clé
 * pour rien.
 *
 * **Ce que l'écran doit dire, et qu'il dit** : la clé part vers le serveur. C'est la
 * contrepartie de D-12, elle est écrite dans « Limites connues », et la taire ici ferait
 * lire la promesse E2EE plus large qu'elle n'est (interdit n°13).
 */
type Echec = "cle" | "court" | "differents" | "reseau";

const MESSAGES: Record<Echec, string> = {
  cle: "Cette clé ne correspond pas à ce compte. Vérifiez la recopie.",
  court: `Choisissez un mot de passe d'au moins ${LONGUEUR_MINIMALE_MOT_DE_PASSE} caractères.`,
  differents: "Les deux mots de passe ne sont pas identiques.",
  reseau: "Le serveur n'a pas répondu. Réessayez.",
};

/**
 * La même longueur minimale que le module Synapse et que l'écran de création — le nombre
 * vient du paquet, il ne se recopie pas. Un garde d'écran n'en est pas un : celui qui
 * compte est `password_config.policy`, côté serveur.
 */
const LONGUEUR_MINIMALE = LONGUEUR_MINIMALE_MOT_DE_PASSE;

export function MotDePasse({ session }: { session: Session }) {
  const [cle, setCle] = useState("");
  const [nouveau, setNouveau] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [echec, setEchec] = useState<Echec>();
  const [fait, setFait] = useState(false);
  const [enCours, setEnCours] = useState(false);

  const complet = cle.trim() !== "" && nouveau !== "" && confirmation !== "";

  const changer = async () => {
    if (!complet || enCours) return;
    if (nouveau.length < LONGUEUR_MINIMALE) return setEchec("court");
    if (nouveau !== confirmation) return setEchec("differents");

    setEnCours(true);
    setEchec(undefined);
    try {
      await changerMotDePasse(session, { cleRecuperation: cle.trim(), nouveau });
      // La clé quitte l'état dès que l'appel aboutit : elle n'a plus de raison d'être en
      // mémoire, et l'écran reste monté tant qu'on ne quitte pas les réglages.
      setCle("");
      setNouveau("");
      setConfirmation("");
      setFait(true);
    } catch (erreur) {
      /*
       * Deux cas seulement, et la différence compte : une clé refusée se corrige en la
       * retapant, une panne ne se corrige pas comme ça (règle 2). Le message du serveur
       * n'est jamais affiché — sur ce chemin, la requête porte la clé.
       */
      const refus = erreur instanceof Error && /incorrecte|parity|prefix|length|base/i.test(erreur.message);
      setEchec(refus ? "cle" : "reseau");
    } finally {
      setEnCours(false);
    }
  };

  if (fait) {
    return (
      <VStack gap={5}>
        <Banner
          status="success"
          title="Mot de passe changé"
          /*
           * **le trou nommé, dit là où il se produit.** La clé de récupération est
           * dérivée du mot de passe ; ce changement ne la re-dérive pas, donc la prochaine
           * connexion sur un appareil neuf redemandera la clé une fois. Personne n'est
           * enfermé dehors — la clé écrite quelque part ouvre toujours —, mais le taire
           * ferait de « votre mot de passe suffit » une promesse à moitié tenue.
           */
          description="Vos autres appareils restent connectés. Gardez votre clé de récupération : après ce changement, une connexion sur un nouvel appareil vous la demandera une fois."
        />
        <Button label="Changer à nouveau" variant="ghost" onClick={() => setFait(false)} />
      </VStack>
    );
  }

  return (
    <VStack gap={5}>
      <VStack gap={4}>
        <Text style={{ textWrap: "pretty" }}>
          Votre clé de récupération est ce qui autorise ce changement — pas votre mot de
          passe actuel. Quelqu&apos;un qui aurait accès à cet appareil ne peut donc pas
          s&apos;approprier le compte.
        </Text>
        {/*
          La contrepartie de D-12, dite là où elle se produit et pas seulement dans un
          écran de limites qu'on ne lit qu'une fois. Elle est en `warning` et non en
          `danger` : c'est une information pour décider, pas un acte destructif.
        */}
        <Banner
          status="warning"
          title="Votre clé est transmise au serveur"
          description="Elle sert à vérifier que c'est bien vous. Un serveur qui la conserverait pourrait déchiffrer vos conversations — c'est la contrepartie de ce garde, et elle est décrite dans « Limites connues »."
        />
      </VStack>

      <VStack gap={4}>
        {/* Mêmes garde-fous de clavier que l'écran de clé : le base58 est sensible à la casse. */}
        <div autoCapitalize="none" autoCorrect="off" spellCheck={false}>
          <TextInput
            label="Clé de récupération"
            value={cle}
            onChange={(v) => {
              setCle(v);
              setEchec(undefined);
            }}
            placeholder="EsTb ABCD EFGH …"
            width="100%"
            status={echec === "cle" ? { type: "error", message: MESSAGES.cle } : undefined}
          />
        </div>

        <TextInput
          label="Nouveau mot de passe"
          type="password"
          value={nouveau}
          onChange={(v) => {
            setNouveau(v);
            setEchec(undefined);
          }}
          width="100%"
          status={echec === "court" ? { type: "error", message: MESSAGES.court } : undefined}
        />

        <TextInput
          label="Confirmez le mot de passe"
          type="password"
          value={confirmation}
          onChange={(v) => {
            setConfirmation(v);
            setEchec(undefined);
          }}
          onEnter={() => void changer()}
          width="100%"
          status={
            echec === "differents" ? { type: "error", message: MESSAGES.differents } : undefined
          }
        />

        {echec === "reseau" && (
          <Text type="supporting" style={{ color: "var(--color-error)" }}>
            {MESSAGES.reseau}
          </Text>
        )}

        <Button
          label="Changer le mot de passe"
          variant="primary"
          isLoading={enCours}
          isDisabled={!complet}
          onClick={() => void changer()}
        />
      </VStack>
    </VStack>
  );
}
