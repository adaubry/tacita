/**
 * La file d'envoi persistante : ce qui est composé part, même après un rechargement.
 *
 * Le local echo du SDK ne survit pas à un F5 ; cette file vit en IndexedDB.
 *
 *  1. `enqueue` — l'entrée est écrite avant toute tentative réseau.
 *  2. Départ à la reconnexion, en FIFO par salon.
 *  3. Classement des erreurs par résolubilité, pas par classe HTTP : réessayable
 *     avec backoff, ou `failed` — qui veut dire « l'utilisateur doit agir sur
 *     *ce* message ».
 *  4. Le téléversement est injecté : cette file ne connaît ni média ni chiffrement.
 *
 * Un salon non chiffré fait échouer l'entrée (`NOT_ENCRYPTED`) plutôt que d'envoyer.
 */
import type { Session } from "@tacita/client-core";
import { ClientEvent, EventStatus, SyncState, type MatrixEvent } from "matrix-js-sdk";

import { byQueuedAt, type OutboxEntry, type TeleversementEnAttente } from "./entry";
import { openOutboxStore } from "./store";

/**
 * ponytail: seul `m.room.message` est mis en file — c'est le seul type qui se
 * compose hors ligne (texte `@tacita/messaging`, média `@tacita/media-pipeline` produit le même type). Ajouter
 * un champ `eventType` à l'entrée le jour où un autre type doit être différé.
 */
const EVENT_TYPE = "m.room.message";

/**
 * code d'échec propre au refus d'envoyer en clair. Il n'appartient pas
 * à l'espace de noms Matrix : c'est nous qui refusons, pas le serveur. Le shard UI
 * doit lui donner un libellé qui dise pourquoi, sinon l'utilisateur voit
 * « échec » et réessaie en boucle.
 */
export const NOT_ENCRYPTED = "TACITA_NOT_ENCRYPTED";

export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * au bout de combien d'échecs **sans statut HTTP** une entrée cesse de
 * réessayer, quand le serveur est joignable.
 *
 * Une erreur sans statut est indiscernable d'une panne réseau, et une panne réseau se
 * résout par l'attente : c'est pourquoi elle est réessayable. Mais si `/sync` répond —
 * donc si le serveur est là — et que la même requête échoue six fois de suite sans
 * jamais rendre de statut, l'attente ne résout rien. Elle boucle.
 *
 * Mesuré : un téléversement au-dessus du plafond recevait un 413 **sans
 * en-tête CORS**, que le navigateur masquait au JavaScript. Le client ne voyait qu'une
 * erreur d'origine, sans statut, donc réessayable — et l'entrée réessayait indéfiniment
 * une requête qui ne pouvait pas aboutir. La cause est corrigée côté proxy ; ce plafond
 * est le garde-fou pour la prochaine erreur qu'on ne saura pas classer.
 */
export const ABANDON_SANS_STATUT = 6;

/** États de sync qui valent « le homeserver répond ». */
const HEALTHY: ReadonlySet<SyncState | null> = new Set([SyncState.Prepared, SyncState.Syncing]);

export interface OutboxOptions {
  /** Injectable en test ; `globalThis.indexedDB` en navigateur. */
  indexedDB?: IDBFactory;
  /**
   * l'étape de téléversement, **injectée** : ce paquet ne connaît ni les
   * médias, ni le chiffrement, ni l'API media de Matrix. Le pipeline (
   *) fournit une étape idempotente, la file décide quand la rejouer.
   *
   * Absente ⇒ une entrée qui attend un téléversement ne peut pas partir, et le dit.
   */
  televerser?: (octets: ArrayBuffer) => Promise<string>;
}

export interface Outbox {
  enqueue(
    roomId: string,
    content: Record<string, unknown>,
    txnId?: string,
    /** les blobs chiffrés à téléverser avant l'envoi de l'événement. */
    televersements?: TeleversementEnAttente[],
  ): Promise<OutboxEntry>;
  /** renvoi manuel après échec définitif. */
  retry(txnId: string): Promise<void>;
  /** abandon d'une entrée. */
  remove(txnId: string): Promise<void>;
  /** entrées du salon en ordre FIFO, à fusionner avec la timeline. */
  pending(roomId: string): OutboxEntry[];
  subscribe(listener: () => void): () => void;
  flush(): Promise<void>;
  dispose(): void;
}

/** Erreurs du SDK lues en canard : un `instanceof` casse dès que le module est dupliqué. */
function errcodeOf(error: unknown): string {
  const errcode = (error as { errcode?: unknown }).errcode;
  return typeof errcode === "string" ? errcode : "network";
}

function httpStatusOf(error: unknown): number | undefined {
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return typeof status === "number" ? status : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const data = (error as { data?: { retry_after_ms?: unknown } }).data;
  return typeof data?.retry_after_ms === "number" ? data.retry_after_ms : undefined;
}

/**
 * Les 4xx dont le serveur revient : trop vite (429) ou jeton à renouveler. Un jeton
 * expire par le temps qui passe, pas par le contenu du message — condamner la file
 * dessus obligerait l'utilisateur à renvoyer chaque entrée à la main après une
 * simple reconnexion.
 */
const RETRYABLE = new Set(["M_LIMIT_EXCEEDED", "M_UNKNOWN_TOKEN"]);

/**
 * un 4xx définitif ne changera pas d'avis : salon inconnu, droits
 * refusés, contenu rejeté. Réessayer en boucle ne ferait que brûler la batterie.
 * Tout le reste (réseau, 5xx, et les codes ci-dessus) reste réessayable.
 */
function isPermanent(error: unknown): boolean {
  const status = httpStatusOf(error);
  return status !== undefined && status >= 400 && status < 500 && !RETRYABLE.has(errcodeOf(error));
}

/** exponentiel, mais le serveur a le dernier mot s'il donne un délai. */
export function backoffMs(attempts: number, error: unknown): number {
  return retryAfterMs(error) ?? Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

export async function createOutbox(
  session: Session,
  options: OutboxOptions = {},
): Promise<Outbox> {
  const store = await openOutboxStore(options.indexedDB ?? globalThis.indexedDB);
  const { televerser } = options;
  const entries = new Map<string, OutboxEntry>();
  const listeners = new Set<() => void>();

  // réhydratation : la file survit au rechargement de page, ce que le
  // local echo du SDK ne fait pas.
  for (const entry of await store.all()) entries.set(entry.txnId, entry);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let rerun = false;
  let disposed = false;
  let synced = HEALTHY.has(session.client.getSyncState());

  const notify = () => {
    for (const listener of listeners) listener();
  };

  /**
   * Mise à jour visible seulement : `sending` est transitoire et n'a rien à faire
   * sur disque — au redémarrage, tout ce qui n'est pas parti est `queued` de toute
   * façon, donc le persister n'achèterait aucune récupération.
   */
  const mark = (entry: OutboxEntry): void => {
    if (disposed) return;
    entries.set(entry.txnId, entry);
    notify();
  };

  // Après `dispose`, la base est fermée : toute écriture qui traînait lèverait un
  // InvalidStateError. Les envois en vol se terminent, ils ne persistent plus rien.
  const save = async (entry: OutboxEntry): Promise<void> => {
    if (disposed) return;
    await store.put(entry);
    mark(entry);
  };

  const drop = async (txnId: string): Promise<void> => {
    if (disposed) return;
    entries.delete(txnId);
    await store.remove(txnId);
    notify();
  };

  /**
   * **L'écho local qu'un envoi raté laisse dans la timeline du SDK.**
   *
   * `sendEvent` pose un écho indexé par `txnId`, et un échec le laisse en place, en
   * `NOT_SENT` — le SDK ne l'oublie qu'à l'écho distant. Rappeler `sendEvent` avec le
   * même `txnId` était donc refusé avant tout réseau (« known txnId ») : l'erreur, sans
   * statut, passait pour une coupure, et l'entrée réessayait sans jamais rien envoyer
   * jusqu'à finir `failed` — renvoi manuel compris. Aucun mock ne pouvait le voir : un
   * `sendEvent` mocké ne retient rien (`tests/sdk-reel.test.ts`).
   *
   * Absent après un rechargement : le SDK ne persiste pas ses échos, la file si.
   */
  const echoNonEnvoye = (entry: OutboxEntry): MatrixEvent | undefined => {
    const echo = session.client.getRoom(entry.roomId)?.getEventForTxnId(entry.txnId);
    return echo?.status === EventStatus.NOT_SENT ? echo : undefined;
  };

  /**
   * Tête de file de chaque salon : les seules entrées qui peuvent partir
   * (FIFO par salon). C'est aussi elle qui fixe le prochain réveil —
   * viser une entrée coincée derrière ferait tourner le timer à vide.
   */
  const heads = (): OutboxEntry[] => {
    const byRoom = new Map<string, OutboxEntry>();
    for (const entry of [...entries.values()].sort(byQueuedAt)) {
      if (entry.status !== "failed" && !byRoom.has(entry.roomId)) byRoom.set(entry.roomId, entry);
    }
    return [...byRoom.values()];
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    const due = heads().map((entry) => entry.nextAttemptAt);
    if (due.length === 0) return;
    timer = setTimeout(() => void flush(), Math.max(0, Math.min(...due) - Date.now()));
  };

  const attempt = async (entree: OutboxEntry): Promise<boolean> => {
    // Réassignable : les téléversements réussis avancent l'entrée avant l'envoi.
    let entry = entree;
    // rien ne part vers un salon non chiffré. Le contrôle est ici et
    // non à l'enqueue : la file est différée par nature, l'état du salon au moment
    // de la mise en file n'est pas celui de l'envoi.
    //
    // Et il est **avant** le `try`, pas dedans : dans le `catch`, `errcodeOf` d'une
    // erreur nue rendrait "network" et `isPermanent` rendrait `false` faute de
    // `httpStatus` — l'entrée réessaierait indéfiniment sur une condition qui ne
    // changera pas.
    if (!(await session.isEncrypted(entry.roomId))) {
      await save({
        ...entry,
        status: "failed",
        attempts: entry.attempts + 1,
        errcode: NOT_ENCRYPTED,
      });
      return false;
    }

    mark({ ...entry, status: "sending" });
    try {
      /*
       * **les téléversements d'abord, un par un, et chacun persisté.**
       *
       * Un envoi média se fait en deux temps, et le premier n'appartenait à personne : la
       * `@tacita/media-pipeline` met la file hors scope, celle-ci ne parlait que d'événements, et un
       * téléversement de 200 Mo qui échouait à 90 % n'était réessayé par personne.
       *
       * Chaque réussite sort de la liste **et l'entrée est réécrite** : une reprise — après
       * un échec réseau comme après un redémarrage — ne rechiffre rien et ne re-téléverse
       * que ce qui manquait. Un échec, lui, tombe dans le `catch` commun : c'est le même
       * backoff et le même statut que pour l'envoi, parce que c'est la même question — est-ce
       * que réessayer a une chance de marcher ?
       */
      while (entry.televersements && entry.televersements.length > 0) {
        const [prochain, ...reste] = entry.televersements as [
          TeleversementEnAttente,
          ...TeleversementEnAttente[],
        ];
        if (!televerser) throw new Error("aucun téléverseur : la pièce jointe ne peut pas partir");

        const url = await televerser(prochain.octets);
        const content = { ...entry.content };
        poser(content, prochain.chemin, url);
        /*
         * **`entry` avance à chaque réussite, avant l'appel suivant.** Écrit dans une
         * variable locale rendue à la fin, un échec au second blob aurait fait persister
         * l'entrée d'origine par le `catch` — donc re-téléverser le premier à la reprise,
         * et la « reprise » n'aurait été qu'un renvoi complet. C'est le test à deux blobs
         * qui l'a montré.
         */
        entry = { ...entry, content, televersements: reste };
        await save(entry);
        mark({ ...entry, status: "sending" });
      }

      // Une reprise passe par l'écho que le SDK a gardé : c'est le chemin qu'il prévoit
      // pour un envoi raté, et le seul qu'il accepte sous le même `txnId`. Son contenu
      // est déjà le bon — les téléversements sont faits avant le premier `sendEvent`.
      const echo = echoNonEnvoye(entry);
      const room = session.client.getRoom(entry.roomId);
      if (echo && room) {
        await session.client.resendEvent(echo, room);
      } else {
        await session.client.sendEvent(
          entry.roomId,
          EVENT_TYPE as never,
          entry.content as never,
          entry.txnId,
        );
      }
      await drop(entry.txnId);
      return true;
    } catch (error) {
      const attempts = entry.attempts + 1;
      const errcode = errcodeOf(error);
      /*
       * Règle 2 — une erreur se classe par sa **résolubilité**. Une erreur sans statut
       * pendant que la sync répond n'est pas une panne réseau : c'est quelque chose que
       * le navigateur nous cache, et l'attente ne le lèvera pas. `failed` veut dire
       * « l'utilisateur doit agir sur ce message », et c'est bien le cas — il verra le
       * bouton de renvoi au lieu d'une file qui tourne en silence.
       */
      const inclassableEtRepete =
        synced && httpStatusOf(error) === undefined && attempts >= ABANDON_SANS_STATUT;

      await save(
        isPermanent(error) || inclassableEtRepete
          ? { ...entry, status: "failed", attempts, errcode }
          : {
              ...entry,
              status: "queued",
              attempts,
              errcode,
              nextAttemptAt: Date.now() + backoffMs(entry.attempts, error),
            },
      );
      return false;
    }
  };

  const pass = async (): Promise<void> => {
    const now = Date.now();
    // FIFO par salon : dès qu'une entrée d'un salon ne part pas, les
    // suivantes de ce salon attendent, sinon le message 2 doublerait le message 1.
    const blocked = new Set<string>();
    for (const entry of [...entries.values()].sort(byQueuedAt)) {
      if (disposed) return;
      if (entry.status === "failed" || blocked.has(entry.roomId)) continue;
      if (entry.nextAttemptAt > now || !(await attempt(entry))) blocked.add(entry.roomId);
    }
  };

  /**
   * Une seule passe à la fois, mais `await flush()` doit vouloir dire « tout ce qui
   * était en file a été tenté ». Un appel pendant une passe en cours réarme donc une
   * passe suivante — sinon une entrée mise en file pendant la passe serait manquée
   * par l'appelant qui attend.
   */
  function flush(): Promise<void> {
    // Rien ne part tant que le homeserver ne répond pas. La garde est ici, et pas
    // dans `pass()`, parce que le `finally` ci-dessous rappelle `schedule()` : une
    // passe qui sortirait à vide réarmerait un timer à 0 ms, qui rappellerait
    // `flush`, en boucle. Ici, le timer déjà armé se déclenche une fois sans rien
    // faire et personne ne le réarme — c'est `onSync` qui relance.
    if (disposed || !synced) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      do {
        rerun = false;
        await pass();
      } while (rerun && !disposed);
    })().finally(() => {
      running = undefined;
      schedule();
    });
    return running;
  }

  // Connectivité prise de l'état de sync de la Session : `navigator.onLine` dit
  // seulement qu'une interface réseau existe, pas que le homeserver répond.
  //
  // L'état est retenu ici plutôt que relu par `getSyncState()` au moment du flush :
  // relire supposerait que le SDK a déjà publié le nouvel état quand il émet
  // l'événement. Si l'ordre était l'inverse, le flush de reconnexion verrait encore
  // l'ancien état et la file ne repartirait jamais — une panne qu'aucun test sur
  // Session mockée ne peut voir, puisque c'est le mock qui fixe l'ordre. Ici,
  // l'argument de l'événement fait foi.
  const onSync = (state: SyncState, previous: SyncState | null): void => {
    synced = HEALTHY.has(state);
    if (synced && !HEALTHY.has(previous)) void flush();
  };
  session.client.on(ClientEvent.Sync, onSync);

  // la file fait partie de ce qu'une déconnexion efface.
  session.registerWipe("outbox", async () => {
    entries.clear();
    await store.clear();
    notify();
  });

  schedule();

  return {
    async enqueue(roomId, content, txnId = session.client.makeTxnId(), televersements) {
      const now = Date.now();
      const entry: OutboxEntry = {
        txnId,
        roomId,
        content,
        ...(televersements && televersements.length > 0 ? { televersements } : {}),
        status: "queued",
        attempts: 0,
        queuedAt: now,
        nextAttemptAt: now,
      };
      // persisté avant toute tentative réseau, jamais l'inverse.
      await save(entry);
      void flush();
      return entry;
    },

    async retry(txnId) {
      const entry = entries.get(txnId);
      if (!entry) return;
      // Renvoi demandé par l'utilisateur : le backoff repart de zéro, mais le txnId
      // ne bouge pas.
      await save({ ...entry, status: "queued", attempts: 0, nextAttemptAt: Date.now() });
      await flush();
    },

    async remove(txnId) {
      /*
       * L'écho raté s'en va avec l'entrée. L'UI le masque tant que la file la tient ;
       * laissé là, il redevenait visible à l'abandon — un message jamais parti, rendu
       * comme les autres (interdit n°13).
       */
      const entry = entries.get(txnId);
      const echo = entry && echoNonEnvoye(entry);
      if (echo) session.client.cancelPendingEvent(echo);
      await drop(txnId);
    },

    pending(roomId) {
      return [...entries.values()].filter((entry) => entry.roomId === roomId).sort(byQueuedAt);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    flush,

    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      session.client.off(ClientEvent.Sync, onSync);
      listeners.clear();
      store.close();
    },
  };
}

/**
 * Écrit une URL au bout d'un chemin dans le contenu. Le chemin existe : c'est le pipeline
 * qui l'a créé en même temps que le téléversement qui l'accompagne.
 */
function poser(contenu: Record<string, unknown>, chemin: string[], url: string): void {
  let noeud: Record<string, unknown> = contenu;
  for (const cle of chemin.slice(0, -1)) {
    const suivant = noeud[cle];
    if (typeof suivant !== "object" || suivant === null) return;
    noeud = { ...(suivant as Record<string, unknown>) };
    // Copie à chaque niveau : l'entrée persistée ne doit pas partager de branche avec
    // celle qu'on vient de lire, sinon une reprise réécrirait un objet déjà modifié.
    (contenu as Record<string, unknown>)[cle] = noeud;
    contenu = noeud;
  }
  noeud[chemin.at(-1)!] = url;
}
