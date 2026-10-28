"use client";

import type { Session } from "@tacita/client-core";
import {
  conversations as listerConversations,
  createGroupChat,
  invitations,
  leaveConversation,
  openDirectMessage,
  setFavourite,
  subscribeConversations,
  type Conversation,
} from "@tacita/messaging";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useSession } from "../onboarding/SessionProvider";
import { ConversationsList, type Tri } from "./ConversationsList";
import { HomeHeader } from "./HomeHeader";
import { NewConversationSheet } from "./NewConversationSheet";
import { RequestsBanner } from "./RequestsBanner";
import { contactsDeLaSession } from "../../lib/contacts";
import { useTirerPourRafraichir } from "../../lib/gestes";
import { Text } from "../foundation/primitives";
import { routeConversation } from "../../lib/routes";

interface Donnees {
  conversations: Conversation[];
  demandes: number;
}

/**
 * Layout Default, variation home (M-C) — l'écran d'atterrissage.
 *
 * Il ne calcule rien : la liste, les compteurs et les invitations viennent du package
 * messaging, et le seul état local est celui de l'écran — tri courant, feuille
 * de création ouverte, bannière écartée. Le shard ne contient aucune logique métier.
 */
export function Accueil() {
  const { etat } = useSession();
  const router = useRouter();
  const session: Session | null = etat.phase === "prete" ? etat.session : null;

  const [donnees, setDonnees] = useState<Donnees | null>(null);
  const [tri, setTri] = useState<Tri>("recentes");
  const [creation, setCreation] = useState(false);
  // Écartées jusqu'à la prochaine : on retient **combien** on a ignoré, pas un booléen.
  // Un booléen ferait disparaître la bannière pour toujours dès le premier glissement.
  const [ignorees, setIgnorees] = useState(0);

  useEffect(() => {
    if (!session) return;

    const rafraichir = () =>
      setDonnees({
        conversations: listerConversations(session),
        demandes: invitations(session).length,
      });

    rafraichir();
    return subscribeConversations(session, rafraichir);
  }, [session]);

  const contacts = useMemo(
    () => (session ? contactsDeLaSession(session).lister() : []),
    // La liste des DM change avec les conversations : la recalculer à chaque
    // rafraîchissement, pas une fois pour toutes.
    [session, donnees],
  );

  const epingler = useCallback(
    (roomId: string, epingle: boolean) => {
      // L'échec ne se rattrape pas ici : la liste suit le tag tel que le serveur le
      // renvoie, donc une écriture perdue se voit — l'épingle ne bouge pas.
      if (session) void setFavourite(session, roomId, epingle).catch(() => {});
    },
    [session],
  );

  // La liste suit `subscribeConversations` : le salon quitté en sort de lui-même.
  const quitter = useCallback(
    async (roomId: string) => {
      if (session) await leaveConversation(session, roomId);
    },
    [session],
  );

  const ouvrir = useCallback((roomId: string) => router.push(routeConversation(roomId)), [router]);

  /*
   * **Tirer pour rafraîchir** (30/08/2026, demande utilisateur). La liste se met à jour
   * toute seule par `subscribeConversations` ; le geste ne sert donc pas à aller chercher
   * des données, il sert à **le vérifier** — c'est ce qu'on fait quand on doute que
   * l'application soit à jour, et ne rien avoir sous le doigt est ce qui fait douter.
   */
  const relire = useCallback(() => {
    if (!session) return;
    setDonnees({
      conversations: listerConversations(session),
      demandes: invitations(session).length,
    });
  }, [session]);
  const tirage = useTirerPourRafraichir(relire);

  return (
    <div
      onPointerDown={tirage.onPointerDown}
      onPointerMove={tirage.onPointerMove}
      onPointerUp={tirage.onPointerUp}
      onPointerCancel={tirage.onPointerCancel}
      style={tirage.style}
    >
      {/* Le repère du tirage : il occupe la place qu'il prend, plutôt que de flotter. */}
      {tirage.tire > 0 && (
        <div
          role="status"
          style={{
            display: "grid",
            placeItems: "center",
            height: tirage.tire,
            overflow: "hidden",
          }}
        >
          <Text type="supporting" color="secondary">
            {tirage.pret ? "Relâchez pour actualiser" : "Tirez pour actualiser"}
          </Text>
        </div>
      )}
      <HomeHeader
        tri={tri}
        onTri={setTri}
        onAjouterDesAmis={() => router.push("/amis/ajouter")}
        onRechercher={() => router.push("/recherche")}
        onCreer={() => setCreation(true)}
      />

      <RequestsBanner
        demandes={Math.max((donnees?.demandes ?? 0) - ignorees, 0)}
        onOuvrir={() => router.push("/amis/demandes")}
        onIgnorer={() => setIgnorees(donnees?.demandes ?? 0)}
      />

      <ConversationsList
        conversations={donnees?.conversations ?? []}
        chargement={donnees === null}
        tri={tri}
        onOuvrir={ouvrir}
        onEpingler={epingler}
        onQuitter={quitter}
        onDemarrer={() => setCreation(true)}
      />

      <NewConversationSheet
        ouvert={creation}
        onFermer={() => setCreation(false)}
        contacts={contacts}
        onConversation={(userId) => {
          if (session) void openDirectMessage(session, userId).then(ouvrir);
        }}
        onGroupe={(nom, membres) => {
          if (session) void createGroupChat(session, nom, membres).then(({ room_id }) => ouvrir(room_id));
        }}
      />
    </div>
  );
}
