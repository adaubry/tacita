/**
 * La timeline : la liste des messages, et ce qui s'intercale entre eux.
 *
 *  1. `appelsParAncre` — range les entrées du journal d'appels sous le message
 *     après lequel elles se sont produites, pour qu'un appel s'affiche à sa place.
 *  2. `Timeline` — regroupement par expéditeur et par jour, séparateurs de date,
 *     ancre de défilement, chargement du passé quand on remonte.
 *
 * L'ordre vient du flux /sync et de rien d'autre.
 */
"use client";

import type { CallLogEntry } from "@tacita/calls";
import type { ReactionTally } from "@tacita/messaging";
import type { ReceiptStatus } from "@tacita/receipts";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";


import { AppelObjet } from "./AppelObjet";
import { DateSeparator } from "./DateSeparator";
import { MessageObject } from "./MessageObject";
import type { Media, Telecharger } from "../media/media";
import { nouveauJour, shouldShowHeader, type MessageAffiche } from "./message";
import { Skeleton } from "../foundation/Skeleton";

interface TimelineProps {
  messages: MessageAffiche[];
  chargement?: boolean;
  /** le starter est le premier élément de la timeline, pas un en-tête. */
  starter?: React.ReactNode;
  reactions?: (message: MessageAffiche) => ReactionTally[];
  /**
   * l'état du dernier message envoyé, et la clé de ce message.
   *
   * La clé vient du câblage, qui la calcule déjà pour interroger les accusés : la
   * recalculer ici donnait deux définitions de « dernier message envoyé » dans deux
   * fichiers, exactement le genre qui dérive.
   */
  recu?: { cle: string; statut: ReceiptStatus; indecidable: boolean };
  onRepondre: (message: MessageAffiche) => void;
  onHold: (message: MessageAffiche) => void;
  onReagir: (message: MessageAffiche, emoji: string) => void;
  onRenvoyer: (message: MessageAffiche) => void;
  onAbandonner: (message: MessageAffiche) => void;
  /** déchiffrement des pièces jointes (M-E), et ouverture du viewer. */
  telecharger?: Telecharger;
  onOuvrirMedia?: (message: MessageAffiche) => void;
  /** sauvegarde d'une pièce jointe sur l'appareil (M-E). */
  onSauvegarderMedia?: (media: Media) => void;
  /**
   * (M-F) — l'identifiant du message sur lequel se positionner, tel qu'un
   * résultat de recherche l'a passé dans l'URL.
   *
   * Un identifiant absent de la timeline chargée **ne déclenche rien** : la contrainte
   * de M-F interdit d'aller le chercher au serveur, et une recherche silencieuse qui
   * échoue vaut mieux qu'un aller-retour réseau que l'utilisateur n'a pas demandé.
   */
  ancre?: string;
  /**
   * « remonte d'un cran dans l'historique ». Appelé quand le défilement
   * approche du haut ; l'appelant décide s'il reste quelque chose à charger et cesse de
   * répondre quand le salon est remonté jusqu'à son début.
   *
   * Absent, la timeline se comporte comme avant : elle n'affiche que ce qui est déjà là.
   */
  onRemonter?: () => void;
  /**
   * l'URL d'objet du fond d'écran choisi pour ce salon (M-H), quand il y
   * en a un. La timeline pose alors le voile de lisibilité (`scrim`), qui est ce qui
   * autorise à laisser l'utilisateur choisir n'importe quelle image.
   */
  fondEcran?: string;
  /**
   * Les appels passés du salon, appels manqués compris.
   *
   * **Chaque entrée porte son ancre** (`apres`), l'identifiant du message qu'elle suit
   * dans le flux `/sync` — et c'est elle qui la place, pas son horodatage. Fusionner les
   * deux listes par date serait le tri que l'interdit n°6 refuse, et pour la raison qu'il
   * donne : `origin_server_ts` n'est pas l'ordre du salon. Une entrée sans ancre ouvre la
   * fenêtre chargée et se rend en tête.
   */
  appels?: CallLogEntry[];
  /** Rappeler après un appel manqué : le seul geste qu'on veut faire en le lisant. */
  onRappeler?: () => void;
}

/**
 * Les appels rangés par le message qu'ils suivent. La clé `""` porte ceux qui ouvrent la
 * fenêtre — un salon dont l'historique chargé commence par un appel.
 *
 * Les appels **en cours** n'y entrent pas : le bandeau du salon les porte déjà, et deux
 * surfaces pour le même appel se contrediraient au premier décalage.
 */
export function appelsParAncre(appels: readonly CallLogEntry[]): Map<string, CallLogEntry[]> {
  const parAncre = new Map<string, CallLogEntry[]>();
  for (const appel of appels) {
    if (appel.enCours) continue;
    const cle = appel.apres ?? "";
    parAncre.set(cle, [...(parAncre.get(cle) ?? []), appel]);
  }
  return parAncre;
}

/**
 * la timeline : l'ordre est **celui du paquet**, jamais retrié ici.
 *
 * Deux fonctions pures gouvernent le rendu, et elles sont testables sans DOM :
 * `nouveauJour` place les séparateurs, `shouldShowHeader` décide du regroupement Discord.
 * Le composant ne fait que les appliquer.
 *
 * ponytail: rendu intégral, sans fenêtrage — même arbitrage qu'en M-C, Astryx 0.2.0
 * n'expose aucune liste virtualisée. Le plafond est réel ici (une conversation ancienne
 * fait des milliers de messages) : à reprendre dès qu'un historique long rame, en
 * fenêtrant sur la timeline du paquet plutôt qu'en triant quoi que ce soit.
 */
export function Timeline({
  messages,
  chargement = false,
  starter,
  reactions,
  recu,
  onRepondre,
  onHold,
  onReagir,
  onRenvoyer,
  onAbandonner,
  telecharger,
  onOuvrirMedia,
  onSauvegarderMedia,
  ancre,
  onRemonter,
  fondEcran,
  appels,
  onRappeler,
}: TimelineProps) {
  // l'état vit ici : le geste porte sur un message, la révélation porte sur
  // la colonne entière. C'est ce que fait Instagram, et c'est ce qu'on attend.
  const [heuresVisibles, setHeuresVisibles] = useState(false);
  const journalParAncre = useMemo(() => appelsParAncre(appels ?? []), [appels]);
  const cible = useRef<HTMLDivElement>(null);
  const zone = useRef<HTMLDivElement>(null);

  /**
   * la hauteur de la zone **avant** que des messages anciens s'insèrent en
   * tête. Sans elle, l'insertion pousse tout le contenu vers le bas et le lecteur perd
   * sa ligne : il repart en haut, ce qui redéclenche aussitôt une demande — une boucle,
   * pas un chargement.
   *
   * `null` = aucune remontée en cours ; toute autre valeur est la hauteur à compenser.
   */
  const hauteurAvant = useRef<number | null>(null);

  /*
   * `useLayoutEffect` et non `useEffect` : la correction doit être appliquée **avant** que
   * le navigateur peigne, sinon le saut est visible.
   *
   * La dépendance est la **tête** de la liste et non sa longueur : seule une insertion en
   * tête déplace ce qu'on est en train de lire. Un message reçu par le bas allonge aussi
   * la liste, et compenser là ferait descendre l'écran tout seul.
   */
  useLayoutEffect(() => {
    const element = zone.current;
    if (!element || hauteurAvant.current === null) return;
    const delta = element.scrollHeight - hauteurAvant.current;
    hauteurAvant.current = null;
    if (delta > 0) element.scrollTop += delta;
  }, [messages[0]?.cle]);

  /**
   * **une conversation s'ouvre sur son dernier message, et y reste tant qu'on
   * n'est pas remonté.** Rien ne positionnait la zone : elle s'ouvrait donc à zéro, c'est
   * à dire sur le message le plus ancien de la fenêtre chargée, et il fallait défiler
   * jusqu'en bas pour lire ce qui venait d'arriver.
   *
   * Le drapeau part à `true` : le premier rendu **est** une arrivée en bas. Ensuite il
   * suit le défilement, si bien qu'un message reçu pendant qu'on relit le passé ne
   * ramène personne au bas de force.
   *
   * **`chargement` est en dépendance, et c'est lui qui manquait.** Tant que la timeline
   * rend ses squelettes, elle rend un *autre* élément : `zone` n'est attachée à rien, et
   * l'effet sort sans rien positionner. Quand les messages arrivent, leur nombre n'a
   * souvent pas changé — le paquet les tenait déjà, seul `pret` a basculé — donc l'effet
   * ne se rejouait pas, et la conversation s'ouvrait sur le message le plus **ancien**.
   * Signalé par les utilisateurs après que a été posée : la logique était juste,
   * elle ne s'exécutait pas. Le test d'origine rendait la timeline sans jamais passer par
   * l'état de chargement, donc sans jamais emprunter le chemin réel.
   */
  const presDuBas = useRef(true);
  /** La marge sous laquelle « en bas » veut encore dire en bas — une ligne ou deux. */
  const SEUIL_BAS = 80;

  useLayoutEffect(() => {
    const element = zone.current;
    if (!element || !presDuBas.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, chargement]);

  /** À quelle distance du haut on demande la suite. Une hauteur d'écran, environ. */
  const SEUIL_REMONTEE = 400;

  const surDefilement = () => {
    const element = zone.current;
    if (!element) return;
    presDuBas.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= SEUIL_BAS;

    if (!onRemonter || element.scrollTop > SEUIL_REMONTEE) return;
    // On mesure à chaque passage sous le seuil, et l'appelant se charge de ne pas
    // relancer une requête déjà en vol. Se garder soi-même ici obligerait à savoir
    // quand la remontée s'achève — y compris quand elle ne rend rien —, et une garde
    // qui ne se relève pas dans ce cas-là fige l'historique pour de bon.
    hauteurAvant.current = element.scrollHeight;
    onRemonter();
  };

  useEffect(() => {
    // `messages.length` en dépendance : l'ancre arrive souvent avant la timeline, et
    // sans cela on tenterait de défiler vers un élément pas encore rendu.
    if (!ancre) return;
    // `scrollIntoView` manque à jsdom ; l'absence de défilement n'est pas une panne.
    cible.current?.scrollIntoView?.({ block: "center" });
    // On vient d'un résultat de recherche : la lecture est ancrée là, pas en bas. Sans
    // cette ligne, le message suivant reçu ramènerait au dernier message.
    presDuBas.current = false;
  }, [ancre, messages.length]);

  if (chargement) {
    return (
      <div
        aria-label="Chargement des messages"
        aria-busy="true"
        style={{
          // Même place dans la colonne que la timeline chargée : sinon le composer
          // remonte au moment où les squelettes cèdent la place aux messages.
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "grid",
          alignContent: "start",
          gap: "var(--spacing-3)",
          padding: "var(--spacing-3)",
        }}
      >
        {[0, 1, 2, 3].map((rang) => (
          <Skeleton key={rang} height={40} />
        ))}
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-label="Messages"
      aria-live="polite"
      ref={zone}
      onScroll={surDefilement}
      style={{
        // La timeline **est** la zone défilante de l'écran : c'est ce qui tient le
        // composer au bas de la fenêtre. `minHeight: 0` parce qu'un enfant de flex refuse
        // par défaut de descendre sous la taille de son contenu — sans lui, la colonne
        // s'allonge et c'est la page entière qui défile, composer compris.
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        /*
         * **Le premier message ne colle plus à l'en-tête** (30/08/2026, plainte :
         * « spacing du layout d'une conversation »). La timeline ne payait que son bas :
         * en haut, le premier bloc démarrait à un pixel du filet de la barre, et le
         * séparateur de date s'y écrasait. Les deux bouts au même pas.
         */
        paddingBlock: "var(--spacing-3)",
        // Le voile est **au-dessus** de l'image et sous le texte : c'est lui qui rend les
        // messages lisibles quel que soit le fond choisi (DESIGN.md, token `scrim`). Sans
        // lui, un fond clair effacerait le texte, et l'utilisateur n'aurait aucun moyen
        // de le savoir avant de l'avoir posé.
        backgroundImage: fondEcran
          ? `linear-gradient(var(--tacita-scrim), var(--tacita-scrim)), url(${fondEcran})`
          : undefined,
        // Pas de `backgroundAttachment: "local"` : sur une zone défilante, c'est la valeur
        // qui fait défiler le fond **avec** les messages, jusqu'à le faire sortir de
        // l'écran. Le défaut (`scroll`) l'attache à la boîte : il reste en place.
        backgroundSize: fondEcran ? "cover" : undefined,
        backgroundPosition: fondEcran ? "center" : undefined,
      }}
    >
      {starter}

      {/* Les appels antérieurs au premier message chargé : ils n'ont aucun message à
          suivre, et les rendre à la fin les daterait de maintenant. */}
      {(journalParAncre.get("") ?? []).map((appel) => (
        <AppelObjet key={appel.id} appel={appel} onRappeler={() => onRappeler?.()} />
      ))}

      {messages.map((message, rang) => {
        const precedent = messages[rang - 1];
        const vise = ancre !== undefined && message.eventId === ancre;
        const apres = message.eventId ? (journalParAncre.get(message.eventId) ?? []) : [];
        return (
          <Fragment key={message.cle}>
            {nouveauJour(precedent, message) && <DateSeparator horodatage={message.horodatage} />}
            {/* Le conteneur n'existe que pour porter la cible du défilement : envelopper
                tous les messages ajouterait un niveau de DOM par message pour rien. */}
            {vise && <div ref={cible} data-ancre={message.eventId} aria-hidden="true" />}
            <MessageObject
              message={message}
              entete={shouldShowHeader(precedent, message)}
              heureVisible={heuresVisibles}
              reactions={reactions?.(message)}
              recu={message.cle === recu?.cle ? recu : undefined}
              onRepondre={() => onRepondre(message)}
              onHold={() => onHold(message)}
              onRevelerHeures={() => setHeuresVisibles((visible) => !visible)}
              onReagir={(emoji) => onReagir(message, emoji)}
              onRenvoyer={message.envoi === "failed" ? () => onRenvoyer(message) : undefined}
              onAbandonner={message.envoi === "failed" ? () => onAbandonner(message) : undefined}
              telecharger={telecharger}
              onOuvrirMedia={onOuvrirMedia ? () => onOuvrirMedia(message) : undefined}
              onSauvegarderMedia={onSauvegarderMedia}
            />
            {apres.map((appel) => (
              <AppelObjet key={appel.id} appel={appel} onRappeler={() => onRappeler?.()} />
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}
