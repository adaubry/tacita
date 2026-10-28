"use client";

import { subscribeConversations, conversations as listerConversations } from "@tacita/messaging";
import { useCallback, useEffect, useState } from "react";

import { ecrireDemandePushFaite, lireDemandePushFaite } from "../../lib/preferences";
import {
  apercuLocal,
  brancherPush,
  demanderEtBrancher,
  endpointPush,
  etatPushLocal,
  signalerPresence,
  TYPE_APERCU,
  type EtatPush,
} from "../../lib/push";
import { Sheet } from "../foundation/Sheet";
import { Button, Text, VStack } from "../foundation/primitives";
import { IosPushEducation } from "../onboarding/IosPushEducation";
import { useSession } from "../onboarding/SessionProvider";

/** Bien en deçà des 45 s de la passerelle : un battement perdu ne lâche pas la présence. */
const PRESENCE_INTERVALLE_MS = 20_000;

/**
 * la chaîne push côté fenêtre. Elle ne rend presque jamais rien.
 *
 * Trois rôles, tous invisibles la plupart du temps :
 *
 * 1. **répondre au service worker.** Réveillé par un push, il ne peut pas déchiffrer :
 *    les clés Megolm sont dans le store crypto de cette fenêtre. Il demande donc
 *    l'aperçu ici, et nous le rendons — rien n'est conservé de part ni d'autre
 *
 * 2. **réparer l'abonnement à chaque ouverture.** Une `PushSubscription` tourne sans
 *    prévenir, un pusher disparaît du compte au premier 410, une reconnexion donne un
 *    `device_id` neuf : rien de tout cela n'est une panne, et rien de tout cela ne se
 *    voit. Sans ce rôle, « notifications activées » finissait par ne plus rien vouloir
 *    dire, et c'est le défaut le plus coûteux des quatre — l'utilisateur ne reçoit rien
 *    et l'interface le félicite ;
 * 3. **demander la permission une seule fois.** Jamais au premier lancement : au premier
 *    message reçu, quand la question a un sens et une réponse évidente. Une seule fois
 *    dans la vie de l'appareil — la marque est en IndexedDB —, parce qu'une question
 *    reposée à chaque `/sync` n'est plus une question, c'est un obstacle.
 */
interface PushNotificationsProps {
  /** surchargeable en test ; `globalThis.indexedDB` en navigateur. */
  indexedDB?: IDBFactory;
}

export function PushNotifications({ indexedDB }: PushNotificationsProps = {}) {
  const { etat } = useSession();
  const session = etat.phase === "prete" ? etat.session : null;
  const base = indexedDB ?? globalThis.indexedDB;

  /** Un message non lu est arrivé : le seul moment où la question a un sens (M-B, M-I). */
  const [declenche, setDeclenche] = useState(false);
  const [propose, setPropose] = useState(false);
  const [echec, setEchec] = useState<EtatPush | null>(null);

  // Rôle 1 — le pont avec le service worker.
  useEffect(() => {
    if (!session || !("serviceWorker" in navigator)) return;

    const repondre = (evenement: MessageEvent) => {
      const donnees = evenement.data as { type?: string; roomId?: string; eventId?: string };
      if (donnees?.type !== TYPE_APERCU || !donnees.roomId) return;
      // Sans aperçu, le SW affiche « Nouveau message ». `visible` répond à l'autre
      // question : la page est-elle à l'écran ? Elle seule le sait à coup sûr — le
      // `visibilityState` d'un client vu du service worker ne suffisait pas sur iOS.
      evenement.ports[0]?.postMessage({
        ...apercuLocal(session, donnees.roomId, donnees.eventId),
        visible: document.visibilityState === "visible",
      });
    };

    navigator.serviceWorker.addEventListener("message", repondre);
    return () => navigator.serviceWorker.removeEventListener("message", repondre);
  }, [session]);

  // Rôle 2 — la réparation silencieuse. Idempotente, sans interface : quand tout va
  // bien, elle lit deux choses et n'écrit rien.
  useEffect(() => {
    if (!session || etatPushLocal() !== "accordee") return;
    void brancherPush(session);
  }, [session]);

  // Rôle 4 — la présence. Tant que la page est visible, la passerelle ne lui pousse
  // rien : renouvelée bien avant l'échéance de la passerelle (45 s), retirée dès que la
  // page passe en arrière-plan.
  useEffect(() => {
    if (!session || etatPushLocal() !== "accordee") return;

    let endpoint: string | undefined;
    let minuteur: ReturnType<typeof setInterval> | undefined;
    const envoyer = (visible: boolean) => {
      if (endpoint) void signalerPresence(endpoint, visible).catch(() => {});
    };

    const surVisibilite = () => {
      clearInterval(minuteur);
      if (document.visibilityState === "visible") {
        // Relu à chaque retour : le navigateur peut avoir tourné l'abonnement.
        void endpointPush()
          .then((valeur) => {
            endpoint = valeur;
            envoyer(true);
          })
          .catch(() => {});
        minuteur = setInterval(() => envoyer(true), PRESENCE_INTERVALLE_MS);
      } else {
        envoyer(false);
      }
    };

    surVisibilite();
    document.addEventListener("visibilitychange", surVisibilite);
    return () => {
      clearInterval(minuteur);
      document.removeEventListener("visibilitychange", surVisibilite);
      envoyer(false);
    };
  }, [session]);

  // Rôle 3 — le déclencheur : un message non lu est arrivé.
  useEffect(() => {
    if (!session) return;
    let annule = false;
    let vu = false;

    const verifier = () => {
      if (vu || annule) return;
      if (!listerConversations(session).some((conversation) => conversation.unread > 0)) return;
      vu = true;

      // L'écran d'éducation iOS se garde tout seul (M-B) : il ne dépend pas de la
      // permission, qui sur iPhone hors écran d'accueil n'existe même pas.
      setDeclenche(true);

      // **Relu ici, et pas au montage de l'effet.** C'était le défaut : la permission
      // était lue une seule fois, donc une permission accordée entre-temps ne coupait
      // rien, et la feuille revenait à chaque `/sync`.
      if (etatPushLocal() !== "possible") return;

      void lireDemandePushFaite(base)
        .then((faite) => {
          if (annule || faite) return;
          setPropose(true);
          // Posée à l'affichage : une feuille montrée est une question posée.
          return ecrireDemandePushFaite(base);
        })
        .catch(() => {});
    };

    verifier();
    const desabonner = subscribeConversations(session, verifier);
    return () => {
      annule = true;
      desabonner();
    };
  }, [session, base]);

  const accepter = useCallback(async () => {
    if (!session) return;
    // `Notification.requestPermission()` n'a d'effet que dans le geste : aucun `await`
    // avant elle, et `setPropose(false)` seulement après, sinon React démonte la feuille
    // et le navigateur perd l'activation utilisateur.
    const diagnostic = await demanderEtBrancher(session);
    setPropose(false);
    // `possible` = l'invite système a été fermée sans réponse. Rien à annoncer : la
    // question reste ouverte, et une feuille d'échec par-dessus serait une insistance.
    const muet = diagnostic.etat === "abonne" || diagnostic.etat === "possible";
    setEchec(muet ? null : diagnostic.etat);
  }, [session]);

  return (
    <>
      {/* sur iPhone hors écran d'accueil, aucun abonnement n'est possible :
          l'éducation (M-B) passe avant la demande de permission, qui échouerait. */}
      <IosPushEducation declenche={declenche} indexedDB={indexedDB} />

      {/* Rien de monté tant que la question n'a pas lieu d'être : `<dialog>` garde son
          contenu dans le DOM même fermé, et une proposition non pertinente y resterait
          lisible — même raison que l'écran d'éducation iOS (M-B). */}
      {propose && (
        <Sheet ouvert onFermer={() => setPropose(false)} titre="Être prévenu des nouveaux messages ?">
          <VStack gap={4}>
            <Text>
              Votre appareil vous préviendra à l&apos;arrivée d&apos;un message. Le serveur ne
              transmet que de quoi réveiller l&apos;application — le contenu est déchiffré ici,
              sur votre appareil.
            </Text>
            <Button
              label="Activer les notifications"
              variant="primary"
              onClick={() => void accepter()}
            />
            <Button label="Plus tard" variant="ghost" onClick={() => setPropose(false)} />
          </VStack>
        </Sheet>
      )}

      {echec !== null && (
        <Sheet ouvert onFermer={() => setEchec(null)} titre="Notifications non activées">
          <VStack gap={4}>
            <Text>
              {/* Interdit n°13 : deux causes très différentes, deux phrases. Un refus se
                  lève dans le navigateur ; une chaîne cassée se réessaie. */}
              {echec === "refuse"
                ? "Ce navigateur les a bloquées pour Tacita. Elles peuvent être réactivées depuis ses réglages de site, puis depuis Profil › Réglages › Notifications."
                : "L'activation n'a pas abouti. Réessayez depuis Profil › Réglages › Notifications : cet écran indique quelle étape a échoué."}
            </Text>
            <Button label="Compris" variant="primary" onClick={() => setEchec(null)} />
          </VStack>
        </Sheet>
      )}
    </>
  );
}
