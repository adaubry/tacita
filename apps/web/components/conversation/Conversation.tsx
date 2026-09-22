"use client";

import type { Session } from "@tacita/client-core";
import {
  canEdit,
  canRedact,
  conversations,
  createTypingIndicator,
  edit,
  getPinnedEvents,
  memberCount,
  mentionCandidates,
  messages as listerMessages,
  messageText,
  parseMentions,
  react,
  reactions as listerReactions,
  redact,
  setPinnedEvents,
  subscribe,
  subscribeTyping,
  typingUsers,
  type MentionCandidate,
} from "@tacita/messaging";
import { downloadAttachment, PROFILES, saveOriginal, uploadAttachment } from "@tacita/media-pipeline";
import { createOutbox, type Outbox } from "@tacita/outbox";
import { createReceipts, type Receipts, type ReceiptStatus } from "@tacita/receipts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { environnementMedia } from "../../lib/media-env";
import { brancherModeMasque } from "../../lib/mode-masque";
import { effacerNotifications } from "../../lib/notifications";
import { lireFondEcran } from "../../lib/preferences";
import { videoTranscodable } from "../../lib/transcode-video";
import { BandeauAppel } from "../appel/BandeauAppel";
import { BoutonsAppel } from "../appel/BoutonsAppel";
import { LayoutHeader } from "../foundation/LayoutHeader";
import { Button, Icon } from "../foundation/primitives";
import { MediaPicker } from "../media/MediaPicker";
import { MediaViewer } from "../media/MediaViewer";
import { PhotoCapture } from "../media/PhotoCapture";
import { mediaDe, type Media } from "../media/media";
import { InvitePush } from "../notifications/InvitePush";
import { useSession } from "../onboarding/SessionProvider";
import { Composer } from "./Composer";
import { ConversationStarter } from "./ConversationStarter";
import { HoldMenu } from "./HoldMenu";
import { Timeline } from "./Timeline";
import { depuisFile, texteAffiche, type MessageAffiche } from "./message";

/** Ce que le composer est en train de faire : rien, une réponse, ou une modification. */
type Intention =
  | { quoi: "repondre"; message: MessageAffiche }
  | { quoi: "modifier"; message: MessageAffiche };

/**
 * Layout Conversation (M-D) — le cœur de l'app.
 *
 * Tout ce qui est métier vient des paquets : l'ordre de la timeline (specs 04/05), la
 * file d'envoi (07), les accusés (06), le typing et les mentions (05). Ce composant les
 * compose et rend ; il ne dérive rien — pas même le nom du salon, qui vient de
 * `conversations()` plutôt que d'un accès au SDK que la spec 00 interdit au shard.
 */
export function Conversation({ roomId }: { roomId: string }) {
  const { etat } = useSession();
  const router = useRouter();
  const session: Session | null = etat.phase === "prete" ? etat.session : null;

  const [outbox, setOutbox] = useState<Outbox | null>(null);
  const receipts = useRef<Receipts | null>(null);
  const typing = useRef<ReturnType<typeof createTypingIndicator> | null>(null);

  const [version, setVersion] = useState(0);
  const [pret, setPret] = useState(false);
  const [intention, setIntention] = useState<Intention | undefined>();
  const [holdSur, setHoldSur] = useState<MessageAffiche | undefined>();
  const [envoiMedia, setEnvoiMedia] = useState(false);
  const [capture, setCapture] = useState(false);
  const [viewer, setViewer] = useState<number | undefined>();

  // L'environnement média (spec 08) est créé une fois : il ouvre un `AudioContext` et
  // lit `navigator.connection`, ni l'un ni l'autre à refaire à chaque rendu.
  const env = useMemo(() => environnementMedia(), []);
  const [videoAutorisee, setVideoAutorisee] = useState(false);

  // REQ-MED-04 — `WebCodecs` est large mais pas universel : on **mesure** avant de
  // proposer la vidéo, plutôt que de l'offrir partout et d'échouer chez certains.
  useEffect(() => {
    void videoTranscodable(PROFILES.good.video.height).then(setVideoAutorisee);
  }, []);

  const rafraichir = useCallback(() => setVersion((v) => v + 1), []);

  // Ouvrir une conversation efface ses notifications et remet le badge au compte. Aussi
  // au retour au premier plan : sur iOS on déverrouille souvent sur une conversation
  // déjà ouverte, qui ne se remonte pas, alors que des notifications y sont arrivées.
  useEffect(() => {
    const effacer = () => {
      if (document.visibilityState === "visible") void effacerNotifications(roomId).catch(() => {});
    };
    effacer();
    document.addEventListener("visibilitychange", effacer);
    return () => document.removeEventListener("visibilitychange", effacer);
  }, [roomId]);

  /**
   * REQ-UIX-35 — le fond d'écran choisi pour ce salon (M-H), lu sur cet appareil.
   *
   * L'URL d'objet est révoquée au changement de salon comme au démontage : sans cela,
   * chaque conversation ouverte retiendrait son image en mémoire pour toujours.
   */
  const [fondEcran, setFondEcran] = useState<string | undefined>();
  useEffect(() => {
    let url: string | undefined;
    void lireFondEcran(globalThis.indexedDB, roomId)
      .then((image) => {
        if (!image) return;
        url = URL.createObjectURL(image);
        setFondEcran(url);
      })
      .catch(() => {});

    return () => {
      if (url) URL.revokeObjectURL(url);
      setFondEcran(undefined);
    };
  }, [roomId]);

  // Les trois services de session, créés une fois par salon et **arrêtés au démontage** :
  // sans cet arrêt, un aller-retour entre deux conversations laisse deux files et deux
  // jeux d'accusés branchés sur le même `/sync`.
  useEffect(() => {
    if (!session) return;
    let vivant = true;

    receipts.current = createReceipts(session);
    typing.current = createTypingIndicator(session);

    const desabonner = [
      subscribe(session, roomId, rafraichir),
      subscribeTyping(session, roomId, rafraichir),
      receipts.current.subscribe(rafraichir),
      // REQ-UI-13 — le mode masqué est réglé dans les réglages (M-H) et s'applique ici :
      // sans ce branchement, la bascule n'aurait aucun effet sur les reçus émis.
      brancherModeMasque(globalThis.indexedDB, receipts.current),
    ];

    void createOutbox(session).then((file) => {
      if (!vivant) {
        file.dispose();
        return;
      }
      setOutbox(file);
      setPret(true);
    });

    return () => {
      vivant = false;
      for (const off of desabonner) off();
      receipts.current?.stop();
      typing.current?.dispose();
      receipts.current = null;
      typing.current = null;
    };
  }, [session, roomId, rafraichir]);

  useEffect(() => {
    if (!outbox) return;
    const off = outbox.subscribe(rafraichir);
    return () => {
      off();
      outbox.dispose();
    };
  }, [outbox, rafraichir]);

  const candidats: MentionCandidate[] = useMemo(
    () => (session ? mentionCandidates(session, roomId) : []),
    [session, roomId, version],
  );

  /**
   * Le nom d'affichage d'un auteur. `mentionCandidates` **est** l'annuaire des membres du
   * salon avec leurs libellés (REQ-MSG-10) : le relire ici évite une API de plus dans le
   * paquet et un accès SDK dans le shard.
   */
  const nomDe = useCallback(
    (userId: string) => candidats.find((candidat) => candidat.id === userId)?.label ?? userId,
    [candidats],
  );

  const salon = useMemo(
    () => (session ? conversations(session).find((c) => c.roomId === roomId) : undefined),
    [session, roomId, version],
  );

  const messages: MessageAffiche[] = useMemo(() => {
    if (!session) return [];
    const moi = session.client.getUserId() ?? "";

    const timeline = listerMessages(session, roomId).map((evenement) => {
      const auteur = evenement.getSender() ?? "";
      return {
        cle: evenement.getId() ?? "",
        eventId: evenement.getId(),
        auteur,
        nom: nomDe(auteur),
        texte: messageText(evenement),
        horodatage: evenement.getTs(),
        moi: auteur === moi,
        // REQ-MSG-06 — les droits viennent du paquet, message par message. Les calculer
        // ici, où l'on tient déjà l'événement, évite de le rechercher au moment du menu.
        modifiable: canEdit(session, roomId, evenement),
        supprimable: canRedact(session, roomId, evenement),
        media: mediaDe(evenement),
      } satisfies MessageAffiche;
    });

    const attente = (outbox?.pending(roomId) ?? []).map((entree) =>
      depuisFile(entree, nomDe(moi), moi),
    );
    // REQ-UI-06 — les entrées en attente vont **à la fin**, sans exception : elles n'ont
    // pas encore d'ordre dans /sync, et leur donner une place au milieu supposerait un
    // tri d'horodatages que l'interdit n°6 refuse. C'est aussi ce qu'attend celui qui
    // vient d'écrire : son message est en bas.
    //
    // `version` est la dépendance qui compte : les paquets rendent des vues, et c'est
    // l'abonnement qui dit qu'elles ont changé.
    return [...timeline, ...attente];
  }, [session, roomId, outbox, nomDe, version]);

  // REQ-UI-13 — l'accusé se rend sur le dernier message envoyé, et sur lui seul.
  const dernierEnvoye = [...messages].reverse().find((message) => message.moi && message.eventId);
  const recu = dernierEnvoye?.eventId
    ? {
        cle: dernierEnvoye.cle,
        statut: (receipts.current?.status(dernierEnvoye.eventId) ?? "sent") as ReceiptStatus,
        indecidable: receipts.current?.deliveryUnknowable(dernierEnvoye.eventId) ?? false,
      }
    : undefined;

  const envoyer = (texte: string) => {
    if (!session) return;
    const contenu = { msgtype: "m.text", ...parseMentions(texte, candidats) };

    if (intention?.quoi === "modifier" && intention.message.eventId) {
      // REQ-UI-07 — une modification part directement : elle porte sur un événement qui
      // existe déjà côté serveur, la file d'envoi n'a rien à en faire.
      void edit(session, roomId, intention.message.eventId, texte, { mentions: candidats });
    } else {
      // REQ-UIX-15 — envoi optimiste : l'entrée entre dans la file, la timeline la rend
      // aussitôt. Chiffrement et reprises sont l'affaire de la spec 07.
      void outbox?.enqueue(roomId, {
        ...contenu,
        ...(intention?.quoi === "repondre"
          ? { "m.relates_to": { "m.in_reply_to": { event_id: intention.message.cle } } }
          : {}),
      } as Record<string, unknown>);
    }

    typing.current?.stop(roomId);
    setIntention(undefined);
  };

  const epingler = (eventId: string) => {
    if (!session) return;
    const epingles = getPinnedEvents(session, roomId);
    void setPinnedEvents(
      session,
      roomId,
      epingles.includes(eventId) ? epingles.filter((id) => id !== eventId) : [...epingles, eventId],
    );
  };

  const reagir = (message: MessageAffiche, emoji: string) => {
    if (session && message.eventId) void react(session, roomId, message.eventId, emoji);
  };

  /**
   * REQ-UI-14 — un seul pipeline pour toutes les pièces jointes (interdit n°11) :
   * `uploadAttachment` chiffre, compresse et téléverse, puis le contenu rendu part par la
   * file d'envoi comme un message texte.
   */
  const joindre = async (fichiers: File[]) => {
    if (!session || !outbox) return;
    setEnvoiMedia(true);
    try {
      for (const fichier of fichiers) {
        const contenu = await uploadAttachment(session, env, fichier);
        await outbox.enqueue(roomId, contenu);
      }
    } finally {
      setEnvoiMedia(false);
    }
  };

  /** Les médias du salon, dans l'ordre de la timeline : le viewer navigue dedans. */
  const medias: Media[] = messages.flatMap((message) =>
    message.media?.msgtype === "m.image" || message.media?.msgtype === "m.video"
      ? [message.media]
      : [],
  );

  const telecharger = useCallback(
    async (fichier: Parameters<typeof downloadAttachment>[2], mimeType?: string) => {
      if (!session) throw new Error("session absente : aucun média déchiffrable");
      const octets = await downloadAttachment(session, env, fichier);
      // Le type est celui que l'UI attend pour l'affichage, pas celui du blob chiffré :
      // le pipeline rend des octets nus, sans en-tête de contenu.
      return new Blob([octets as BlobPart], { type: mimeType ?? "application/octet-stream" });
    },
    [session, env],
  );

  return (
    <>
      <LayoutHeader
        titre={salon?.name ?? "Conversation"}
        fin={
          <div style={{ display: "flex", gap: "var(--spacing-1)" }}>
            {/* REQ-UI-19 — M-D fournit l'emplacement, M-I le comportement. Le shard ne
                compose rien lui-même : l'appel vit dans le widget (interdit n°7). */}
            <BoutonsAppel roomId={roomId} />
            {/* Le point d'entrée du layout Conversation info (M-H) : sans lui, l'écran
                des options n'est atteignable par aucun geste. */}
            <Button
              label="Informations"
              variant="ghost"
              isIconOnly
              icon={<Icon icon="info" />}
              onClick={() => router.push(`/c/${roomId}/infos`)}
            />
          </div>
        }
      />

      {/* REQ-CAL-03 — persistant tant que l'appel dure, dans le salon concerné. */}
      {session && <BandeauAppel session={session} roomId={roomId} />}

      <Timeline
        messages={messages}
        chargement={!pret}
        fondEcran={fondEcran}
        starter={
          <ConversationStarter
            nom={salon?.name ?? ""}
            sousTitre={
              salon?.direct
                ? (salon.peerId ?? "")
                : `${session ? memberCount(session, roomId) : 0} membres`
            }
            direct={salon?.direct ?? false}
          />
        }
        reactions={(message) =>
          session && message.eventId ? listerReactions(session, roomId, message.eventId) : []
        }
        recu={recu}
        onRepondre={(message) => setIntention({ quoi: "repondre", message })}
        onHold={setHoldSur}
        onReagir={reagir}
        onRenvoyer={(message) => void outbox?.retry(message.cle)}
        onAbandonner={(message) => void outbox?.remove(message.cle)}
        telecharger={telecharger}
        onOuvrirMedia={(message) => {
          const rang = medias.findIndex((media) => media === message.media);
          if (rang >= 0) setViewer(rang);
        }}
      />

      <Composer
        // Remonter le composer sur changement d'intention est ce qui remplit le champ
        // avec le texte à modifier : un état contrôlé par le parent ferait un aller-retour
        // à chaque frappe pour un besoin qui n'existe qu'au changement.
        key={intention?.quoi === "modifier" ? intention.message.cle : "nouveau"}
        mentions={candidats}
        texteInitial={intention?.quoi === "modifier" ? intention.message.texte : ""}
        contexte={
          intention && {
            libelle: intention.quoi === "repondre" ? `Réponse à ${intention.message.nom}` : "Modification",
            extrait: texteAffiche(intention.message.texte),
            onAnnuler: () => setIntention(undefined),
          }
        }
        onEnvoyer={envoyer}
        onFrappe={() => typing.current?.keystroke(roomId)}
        ecrivent={session ? typingUsers(session, roomId).map(nomDe) : []}
        actions={
          <>
            <MediaPicker
              onFichiers={(fichiers) => void joindre(fichiers)}
              enCours={envoiMedia}
              videoAutorisee={videoAutorisee}
            />
            <Button label="Prendre une photo" variant="ghost" onClick={() => setCapture(true)} />
          </>
        }
      />

      <PhotoCapture
        ouvert={capture}
        onFermer={() => setCapture(false)}
        // REQ-UI-15 — deux gestes, deux destinations : l'original reste sur l'appareil,
        // seule la version compressée par le pipeline part au correspondant.
        onEnregistrer={(original, nom) => saveOriginal(env, original, nom)}
        onEnvoyer={(photo) => void joindre([photo])}
      />

      {viewer !== undefined && (
        <MediaViewer
          medias={medias}
          depart={viewer}
          telecharger={telecharger}
          onFermer={() => setViewer(undefined)}
          onSauvegarder={(media) => {
            void telecharger(media.fichier).then((blob) => saveOriginal(env, blob, media.nom));
          }}
        />
      )}

      {/* REQ-UI-18 — le bon moment : un message reçu est là, donc la notification a un
          sens démontré. Jamais au premier lancement, où elle n'en aurait aucun. */}
      <InvitePush declenche={messages.some((message) => !message.moi)} session={session} />

      <HoldMenu
        ouvert={holdSur !== undefined}
        onFermer={() => setHoldSur(undefined)}
        modifiable={holdSur?.modifiable ?? false}
        supprimable={holdSur?.supprimable ?? false}
        epingle={
          session && holdSur?.eventId
            ? getPinnedEvents(session, roomId).includes(holdSur.eventId)
            : false
        }
        onReagir={(emoji) => holdSur && reagir(holdSur, emoji)}
        onRepondre={() => holdSur && setIntention({ quoi: "repondre", message: holdSur })}
        // REQ-MSG-07 — le texte vient du paquet, l'accès presse-papiers est à l'UI.
        onCopier={() => holdSur && void navigator.clipboard?.writeText(holdSur.texte)}
        onModifier={() => holdSur && setIntention({ quoi: "modifier", message: holdSur })}
        onSupprimer={() => {
          if (session && holdSur?.eventId) void redact(session, roomId, holdSur.eventId);
        }}
        onEpingler={() => holdSur?.eventId && epingler(holdSur.eventId)}
      />
    </>
  );
}
