/**
 * L'écran d'une conversation : tout ce qu'un salon ouvert met à l'écran.
 *
 * Le plus gros composant du shard, parce qu'il est le point où sept modules se
 * rencontrent. Dans l'ordre du fichier :
 *
 *  1. État local — intention du composer (rien, réponse, édition), menu d'appui long,
 *     envoi de média, capture, visionneur, fond d'écran.
 *  2. Abonnements — timeline, file d'envoi, accusés. Chacun rend sa fonction de
 *     désabonnement ; aucun ne survit au démontage.
 *  3. Fusion — les messages du serveur et ceux qui attendent dans la file, en un seul
 *     flux, dans l'ordre du /sync.
 *  4. Rendu — `Timeline`, `Composer`, et les surfaces qui s'ouvrent par-dessus.
 *
 * Aucune logique métier ici : ce que cet écran découvre remonte dans le paquet
 * concerné.
 */
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
  members,
  mentionCandidates,
  messages as listerMessages,
  messageText,
  parseMentions,
  react,
  reactions as listerReactions,
  redact,
  replyRelation,
  replyTo,
  replyToOf,
  setPinnedEvents,
  subscribe,
  subscribeTyping,
  typingUsers,
  type MentionCandidate,
} from "@tacita/messaging";
import { callHistory } from "@tacita/calls";
import { prepareAttachment, refusePourTaille, saveOriginal } from "@tacita/media-pipeline";
import { useOutbox } from "./OutboxProvider";
import { createReceipts, type Receipts, type ReceiptStatus } from "@tacita/receipts";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { identifiantCourt } from "../../lib/identifiants";
import { routeAppel, routeInfos } from "../../lib/routes";
import { TranscodageIndisponible } from "../../lib/media-env";
import { brancherModeMasque } from "../../lib/mode-masque";
import { effacerNotifications } from "../../lib/push";
import { lireFondEcran } from "../../lib/preferences";
import { BandeauAppel } from "../appels/BandeauAppel";
import { LayoutHeader } from "../foundation/LayoutHeader";
import { IconeAppel, IconeCamera, IconeInfo, IconeVideo } from "../foundation/icons";
import { Button } from "../foundation/primitives";
import { MediaPicker } from "../media/MediaPicker";
import { MediaViewer } from "../media/MediaViewer";
import { PhotoCapture } from "../media/PhotoCapture";
import { mediaDe, tailleLisible, type Media } from "../media/media";
import { useMediaActions } from "../media/useMediaActions";
import { useSession } from "../onboarding/SessionProvider";
import { Composer } from "./Composer";
import { ConversationStarter } from "./ConversationStarter";
import { HoldMenu } from "./HoldMenu";
import { Timeline } from "./Timeline";
import { apercu, citation, depuisFile, type MessageAffiche } from "./message";

/** Ce que le composer est en train de faire : rien, une réponse, ou une modification. */
type Intention =
  | { quoi: "repondre"; message: MessageAffiche }
  | { quoi: "modifier"; message: MessageAffiche };

/**
 * Layout Conversation (M-D) — le cœur de l'app.
 *
 * Tout ce qui est métier vient des paquets : l'ordre de la timeline (`@tacita/client-core`/05), la
 * file d'envoi (07), les accusés (06), le typing et les mentions (05). Ce composant les
 * compose et rend ; il ne dérive rien — pas même le nom du salon, qui vient de
 * `conversations()` plutôt que d'un accès au SDK que `CLAUDE.md` interdit au shard.
 */
export function Conversation({ roomId }: { roomId: string }) {
  const { etat } = useSession();
  const router = useRouter();
  const session: Session | null = etat.phase === "prete" ? etat.session : null;

  /**
   * M-F — le message visé par un résultat de recherche, quand on arrive d'un résultat.
   * La timeline s'y positionne si elle le contient ; sinon rien ne se passe, et surtout
   * aucun aller-retour serveur (contrainte de M-F).
   */
  const ancre = useSearchParams()?.get("m");

  // La file d'envoi vient de la session (voir `OutboxProvider`) : la créer ici la faisait
  // mourir avec l'écran, et avec elle tout ce qui attendait la reconnexion.
  const outbox = useOutbox();
  const receipts = useRef<Receipts | null>(null);
  const typing = useRef<ReturnType<typeof createTypingIndicator> | null>(null);

  const [version, setVersion] = useState(0);
  const [pret, setPret] = useState(false);
  const [intention, setIntention] = useState<Intention | undefined>();
  const [holdSur, setHoldSur] = useState<MessageAffiche | undefined>();
  const [envoiMedia, setEnvoiMedia] = useState(false);
  const [capture, setCapture] = useState(false);
  const [viewer, setViewer] = useState<number | undefined>();

  // L'environnement média est créé une fois : il ouvre un `AudioContext` et
  // lit `navigator.connection`, ni l'un ni l'autre à refaire à chaque rendu. Les deux
  // gestes qui l'accompagnent — déchiffrer, sauvegarder — viennent du même endroit que
  // pour les autres écrans à médias.
  const { env, avis, telecharger, telechargerChiffre, sauvegarder } = useMediaActions(session);
  /**
   * l'échec **dédié** de la compression, distinct de l'absence de bouton.
   *
   * La vidéo est proposée partout depuis que le chemin rapide existe : une source
   * déjà conforme se remuxe sans encodeur. Ce qui reste possible, c'est qu'une source
   * **non** conforme tombe sur un appareil qui ne sait pas réencoder — et ça, il faut le
   * dire à ce moment-là, avec sa phrase, sinon le bouton promet plus que le pipeline ne
   * tient (interdit n°13).
   */
  const [erreurMedia, setErreurMedia] = useState<string>();

  const rafraichir = useCallback(() => setVersion((v) => v + 1), []);

  /**
   * le fond d'écran choisi pour ce salon (M-H), lu sur cet appareil.
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

  // Ouvrir une conversation efface ses notifications et remet le badge au compte. Aussi au
  // retour au premier plan : sur iOS on déverrouille souvent sur une conversation déjà
  // ouverte, qui ne se remonte pas, alors que des notifications y sont arrivées.
  useEffect(() => {
    const effacer = () => {
      if (document.visibilityState === "visible") void effacerNotifications(roomId).catch(() => {});
    };
    effacer();
    document.addEventListener("visibilitychange", effacer);
    return () => document.removeEventListener("visibilitychange", effacer);
  }, [roomId]);

  // Les trois services de session, créés une fois par salon et **arrêtés au démontage** :
  // sans cet arrêt, un aller-retour entre deux conversations laisse deux files et deux
  // jeux d'accusés branchés sur le même `/sync`.
  useEffect(() => {
    if (!session) return;

    receipts.current = createReceipts(session);
    typing.current = createTypingIndicator(session);

    const desabonner = [
      subscribe(session, roomId, rafraichir),
      subscribeTyping(session, roomId, rafraichir),
      receipts.current.subscribe(rafraichir),
      // le mode masqué est réglé dans les réglages (M-H) et s'applique ici :
      // sans ce branchement, la bascule n'aurait aucun effet sur les reçus émis.
      brancherModeMasque(globalThis.indexedDB, receipts.current),
    ];

    setPret(true);

    return () => {
      for (const off of desabonner) off();
      receipts.current?.stop();
      typing.current?.dispose();
      receipts.current = null;
      typing.current = null;
    };
  }, [session, roomId, rafraichir]);

  // On s'abonne, on ne dispose pas : la file ne nous appartient plus (`OutboxProvider`).
  useEffect(() => outbox?.subscribe(rafraichir), [outbox, rafraichir]);

  /**
   * **remonter l'historique.**
   *
   * Ce que /sync laisse dans le store est une fenêtre courte : au bout de quelques jours,
   * les messages plus anciens n'y sont plus, et jusqu'ici rien n'allait les rechercher —
   * ils paraissaient « oubliés ». `paginate` les redemande au serveur, un cran à la fois,
   * quand le défilement approche du haut.
   *
   * Deux gardes, et elles ne disent pas la même chose : `enCours` empêche deux requêtes
   * simultanées pour le même geste, `debut` retient qu'on a atteint la naissance du salon
   * et arrête de demander pour de bon. Sans la seconde, arriver en haut d'un salon
   * entièrement chargé relancerait une requête à chaque pixel de défilement.
   *
   * Les deux sont des `ref` et non des états : les relire ne doit pas provoquer de rendu,
   * et le rendu suivant vient de toute façon de `rafraichir`.
   */
  const remontee = useRef({ enCours: false, debut: false });
  useEffect(() => {
    // Changer de salon repart d'une timeline neuve : l'état de remontée du précédent
    // n'a plus rien à dire sur celle-ci.
    remontee.current = { enCours: false, debut: false };
  }, [roomId]);

  const remonter = useCallback(() => {
    if (!session || remontee.current.enCours || remontee.current.debut) return;
    remontee.current.enCours = true;
    void session
      .timeline(roomId)
      .paginate()
      .then((reste) => {
        remontee.current.debut = !reste;
        rafraichir();
      })
      // Un échec réseau n'est pas la fin de l'historique : on relâche la garde et le
      // prochain défilement réessaiera. Rien n'est journalisé — l'erreur porterait le
      // salon (interdit n°8).
      .catch(() => {})
      .finally(() => {
        remontee.current.enCours = false;
      });
  }, [session, roomId, rafraichir]);

  const candidats: MentionCandidate[] = useMemo(
    () => (session ? mentionCandidates(session, roomId) : []),
    [session, roomId, version],
  );

  /**
   * Le nom d'affichage d'un auteur. `mentionCandidates` **est** l'annuaire des membres du
   * salon avec leurs libellés : le relire ici évite une API de plus dans le
   * paquet et un accès SDK dans le shard.
   */
  const nomDe = useCallback(
    (userId: string) => candidats.find((candidat) => candidat.id === userId)?.label ?? userId,
    [candidats],
  );

  /**
   * La photo d'un auteur. Elle vient de son **appartenance au salon** — c'est là que
   * Matrix la porte — et non d'un `profileOf` par personne : ce serait un aller-retour
   * réseau par ligne de timeline pour une image que `/sync` a déjà livrée.
   *
   * Sans elle, `ConversationAvatar` ne recevait aucun `mxc` et ne rendait que des
   * initiales : la photo était posée, synchronisée, et jamais affichée.
   */
  const membres = useMemo(
    () => (session ? members(session, roomId) : []),
    [session, roomId, version],
  );
  const avatarDe = useCallback(
    (userId: string) => membres.find((membre) => membre.userId === userId)?.getMxcAvatarUrl(),
    [membres],
  );

  const salon = useMemo(
    () => (session ? conversations(session).find((c) => c.roomId === roomId) : undefined),
    [session, roomId, version],
  );

  /**
   * Le journal des appels du salon — appels manqués compris. Même dépendance `version`
   * que les messages : les deux viennent de la même timeline, et les recalculer au même
   * moment est ce qui les garde d'accord.
   */
  const appels = useMemo(
    () => (session ? callHistory(session, roomId) : []),
    [session, roomId, version],
  );

  const messages: MessageAffiche[] = useMemo(() => {
    if (!session) return [];
    const moi = session.client.getUserId() ?? "";

    const lus = listerMessages(session, roomId).map((evenement) => {
      const auteur = evenement.getSender() ?? "";
      return {
        // l'événement cité, lu par le paquet : le `body` porte bien une
        // citation en `> `, mais `messageText` la retire et elle ne dit ni qui ni quoi
        // quand le message cité est une photo.
        citeId: replyTo(evenement),
        message: {
          cle: evenement.getId() ?? "",
          eventId: evenement.getId(),
          auteur,
          nom: nomDe(auteur),
          avatar: avatarDe(auteur),
          texte: messageText(evenement),
          horodatage: evenement.getTs(),
          moi: auteur === moi,
          // les droits viennent du paquet, message par message. Les calculer
          // ici, où l'on tient déjà l'événement, évite de le rechercher au moment du menu.
          modifiable: canEdit(session, roomId, evenement),
          supprimable: canRedact(session, roomId, evenement),
          media: mediaDe(evenement),
        } satisfies MessageAffiche,
      };
    });

    /*
     * de quoi résoudre une citation **sans repasser par le SDK** : le message
     * cité est presque toujours quelques lignes plus haut, et la fenêtre chargée le porte
     * déjà. Ce qu'elle ne porte pas se dit tel quel (`citation`), plutôt que d'aller le
     * chercher au serveur ligne par ligne.
     */
    const parId = new Map(
      lus.filter(({ message }) => message.eventId).map(({ message }) => [message.eventId!, message]),
    );
    const citer = (citeId: string | undefined, message: MessageAffiche): MessageAffiche =>
      citeId === undefined ? message : { ...message, repondA: citation(parId.get(citeId)) };

    const timeline = lus.map(({ citeId, message }) => citer(citeId, message));

    // Une réponse encore en file se cite comme une autre : c'est le propre de l'envoi
    // optimiste, et c'est le message qu'on vient d'écrire — celui qu'on regarde.
    const attente = (outbox?.pending(roomId) ?? []).map((entree) =>
      citer(replyToOf(entree.content), depuisFile(entree, nomDe(moi), moi, avatarDe(moi))),
    );
    // les entrées en attente vont **à la fin**, sans exception : elles n'ont
    // pas encore d'ordre dans /sync, et leur donner une place au milieu supposerait un
    // tri d'horodatages que l'interdit n°6 refuse. C'est aussi ce qu'attend celui qui
    // vient d'écrire : son message est en bas.
    //
    // `version` est la dépendance qui compte : les paquets rendent des vues, et c'est
    // l'abonnement qui dit qu'elles ont changé.
    return [...timeline, ...attente];
  }, [session, roomId, outbox, nomDe, avatarDe, version]);

  /**
   * **ouvrir une conversation la marque lue.**
   *
   * Le badge de non-lus est le compteur natif du serveur (`getUnreadNotificationCount`,
   *) : il ne retombe que sur un reçu `m.read`, et **personne ne l'émettait**.
   * `createReceipts` exposait `markRead` depuis le premier jour, sans un seul appelant —
   * le compteur ne pouvait donc que monter, ce que les utilisateurs ont signalé tel quel.
   * C'est exactement la règle 7 : un membre que rien ne lit est indétectable.
   *
   * Un reçu vaut « lu jusqu'ici » : marquer le dernier message suffit, les précédents
   * suivent. La garde par identifiant évite de réémettre à chaque tour de `version` —
   * la timeline se rafraîchit à chaque frappe d'en face, pas seulement à chaque message.
   *
   * ponytail: aucune condition de visibilité ni de position de défilement — écran ouvert
   * vaut lu, comme Instagram. À affiner le jour où quelqu'un veut « garder non lu ».
   */
  const dernierLu = useRef<string>(undefined);
  useEffect(() => {
    if (!session || !pret) return;
    const dernier = listerMessages(session, roomId).at(-1);
    const eventId = dernier?.getId();
    if (!dernier || !eventId || dernierLu.current === eventId) return;
    dernierLu.current = eventId;
    // Un reçu perdu n'est pas une panne d'écran : le prochain message le rattrapera.
    // Rien n'est journalisé — l'erreur porterait le salon (interdit n°8).
    void receipts.current?.markRead(dernier).catch(() => {});
  }, [session, roomId, pret, version]);

  // l'accusé se rend sur le dernier message envoyé, et sur lui seul.
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
      // une modification part directement : elle porte sur un événement qui
      // existe déjà côté serveur, la file d'envoi n'a rien à en faire.
      void edit(session, roomId, intention.message.eventId, texte, { mentions: candidats });
    } else {
      // envoi optimiste : l'entrée entre dans la file, la timeline la rend
      // aussitôt. Chiffrement et reprises sont l'affaire de `@tacita/outbox`.
      /*
       * la relation vient du paquet, et elle porte l'`event_id`
       * du message cité — jamais sa `cle`, qui est un identifiant de transaction tant que
       * le serveur n'a rien attribué. Répondre à un message encore en file aurait posé une
       * relation vers un événement qui n'existe nulle part : personne ne l'aurait résolue,
       * et rien à l'écran ne l'aurait dit.
       */
      const cite = intention?.quoi === "repondre" ? intention.message.eventId : undefined;
      void outbox?.enqueue(roomId, {
        ...contenu,
        ...(cite ? replyRelation(cite) : {}),
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
   * un seul pipeline pour toutes les pièces jointes (interdit n°11) :
   * `uploadAttachment` chiffre, compresse et téléverse, puis le contenu rendu part par la
   * file d'envoi comme un message texte.
   */
  const joindre = async (fichiers: File[]) => {
    if (!session || !outbox) return;
    setEnvoiMedia(true);
    setErreurMedia(undefined);
    avis.current = undefined;
    try {
      for (const fichier of fichiers) {
        /*
         * **la compression et le chiffrement ici, le téléversement dans la
         * file.** Rien ne part au réseau avant `enqueue` : ce qui est mis en file porte
         * ses octets chiffrés, donc un envoi interrompu reprend là où il s'est arrêté,
         * sans rechiffrer, y compris après un rechargement de la page.
         */
        const { contenu, televersements } = await prepareAttachment(env, fichier);

        /*
         * **on ne met pas en file ce que le serveur refusera.** Le plafond
         * vient du serveur lui-même, pas d'une constante : sans ce contrôle, une vidéo
         * de onze minutes partait en 206 Mo pour s'entendre refuser à la fin, et le refus
         * arrivait sous une forme que le navigateur masquait (413 sans en-tête CORS).
         */
        const refus = await refusePourTaille(session, televersements);
        if (refus) {
          setErreurMedia(
            `Cette pièce jointe est trop volumineuse pour ce serveur : ${tailleLisible(refus.taille)}, limite ${tailleLisible(refus.plafond)}.`,
          );
          continue;
        }

        await outbox.enqueue(
          roomId,
          contenu,
          undefined,
          televersements.map(({ chemin, ciphertext }) => ({
            chemin,
            // `ArrayBuffer` : c'est ce qu'IndexedDB range et rend tel quel.
            octets: ciphertext.buffer.slice(
              ciphertext.byteOffset,
              ciphertext.byteOffset + ciphertext.byteLength,
            ),
          })),
        );
      }
      // la vidéo est partie ; ce qu'elle a laissé en route se dit
      // maintenant, à l'expéditeur et à lui seul. Une vidéo envoyée est un succès ; la
      // taire à moitié serait l'interdit n°13.
      if (avis.current === "video-sans-son") {
        setErreurMedia("Cette vidéo est partie sans le son : son format audio ne peut pas être transporté.");
      } else if (avis.current === "video-non-compressee") {
        setErreurMedia(
          "Cette vidéo est partie telle quelle : ce navigateur ne sait pas la recompresser. Elle est donc plus lourde que d'habitude.",
        );
      }
    } catch (cause) {
      // le message ne cite jamais le fichier : ni son nom, ni ses octets.
      /*
       * **trois phrases, parce que ce sont trois situations.** « Ce
       * navigateur ne sait pas lire ce format » se règle en changeant d'appareil ou en
       * réexportant la vidéo ; « il ne sait pas l'encoder » non. Les confondre — ce que
       * faisait la phrase unique — envoyait chercher une solution qui n'existe pas :
       * mesuré sur un `.mov` d'iPhone en HEVC, refusé sous le mot
       * « compresser » alors que rien n'avait pu être décodé.
       */
      setErreurMedia(
        cause instanceof TranscodageIndisponible
          ? cause.motif === "codec-source"
            ? "Ce navigateur ne sait pas lire ce format de vidéo. Réexportez-la en H.264, ou envoyez-la depuis un autre appareil."
            : "Impossible de compresser cette vidéo sur cet appareil."
          : "L'envoi de cette pièce jointe a échoué.",
      );
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

  return (
    <>
      {/* La colonne de l'écran, et la seule raison pour laquelle la barre d'écriture est
          en bas : header et composer aux deux bouts, timeline au milieu — c'est elle qui
          défile. Sans hauteur fixée, tout suit le flux du document et la barre se pose
          sous le dernier message, donc au milieu d'une conversation qui commence.

          `100dvh` et non `100vh` : la barre d'URL rétractable des mobiles (même raison
          qu'en M-B, `RecoveryGate`). */}
      <div style={{ display: "flex", flexDirection: "column", height: "100dvh" }}>
        <LayoutHeader
          titre={salon?.name ?? "Conversation"}
          fin={
            <div style={{ display: "flex", gap: "var(--spacing-1)" }}>
              {/* M-D fournit l'emplacement, M-I le comportement : les deux
                  boutons routent vers l'écran d'appel, qui embarque Element Call. Rien
                  n'est composé ici (interdit n°7), et **aucun des deux n'est désactivé**
                  sans focus RTC — la cause s'affiche dans l'écran. */}
              <Button
                label="Appel audio"
                variant="ghost"
                isIconOnly
                icon={IconeAppel}
                onClick={() => router.push(routeAppel(roomId))}
              />
              <Button
                label="Appel vidéo"
                variant="ghost"
                isIconOnly
                icon={IconeVideo}
                onClick={() => router.push(routeAppel(roomId, true))}
              />
              {/* Le point d'entrée du layout Conversation info (M-H) : sans lui, l'écran
                  des options n'est atteignable par aucun geste. */}
              <Button
                label="Informations"
                variant="ghost"
                isIconOnly
                icon={IconeInfo}
                onClick={() => router.push(routeInfos(roomId))}
              />
            </div>
          }
        />

        {/* « appel en cours — rejoindre », dans le salon concerné. */}
        <BandeauAppel roomId={roomId} />

        <Timeline
          messages={messages}
          appels={appels}
          // Rappeler après un appel manqué mène au même écran que le bouton du header :
          // un seul chemin d'appel, un seul comportement à tenir.
          onRappeler={() => router.push(routeAppel(roomId))}
          chargement={!pret}
          ancre={ancre ?? undefined}
          onRemonter={remonter}
          fondEcran={fondEcran}
          starter={
            <ConversationStarter
              nom={salon?.name ?? ""}
              sousTitre={
                salon?.direct
                  ? // l'identifiant sans son domaine, identique pour tous.
                    (salon.peerId ? identifiantCourt(salon.peerId) : "")
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
          onSauvegarderMedia={sauvegarder}
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
              // « Photo », « Vidéo », « Message vocal » : un média n'a pas de
              // texte, et son `body` est un nom de fichier que personne ne reconnaît.
              extrait: apercu(intention.message),
              onAnnuler: () => setIntention(undefined),
            }
          }
          onEnvoyer={envoyer}
          onFrappe={() => typing.current?.keystroke(roomId)}
          ecrivent={session ? typingUsers(session, roomId).map(nomDe) : []}
          actions={
            <MediaPicker
              onFichiers={(fichiers) => void joindre(fichiers)}
              enCours={envoiMedia}
              erreur={erreurMedia}
            />
          }
          actionsEnvoi={
            <Button
              label="Prendre une photo"
              variant="ghost"
              isIconOnly
              icon={IconeCamera}
              onClick={() => setCapture(true)}
            />
          }
        />
      </div>

      <PhotoCapture
        ouvert={capture}
        onFermer={() => setCapture(false)}
        // deux gestes, deux destinations : l'original reste sur l'appareil,
        // seule la version compressée par le pipeline part au correspondant.
        onEnregistrer={(original, nom) => saveOriginal(env, original, nom)}
        onEnvoyer={(photo) => void joindre([photo])}
      />

      {viewer !== undefined && (
        <MediaViewer
          medias={medias}
          depart={viewer}
          telecharger={telecharger}
          telechargerChiffre={telechargerChiffre}
          onFermer={() => setViewer(undefined)}
          onSauvegarder={sauvegarder}
        />
      )}

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
        // le texte vient du paquet, l'accès presse-papiers est à l'UI.
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
