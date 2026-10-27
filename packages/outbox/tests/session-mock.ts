import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import { IDBFactory } from "fake-indexeddb";
import { vi } from "vitest";

/** Erreur du SDK reproduite en canard : errcode, httpStatus, data.retry_after_ms. */
export function matrixError(errcode: string, httpStatus: number, retryAfterMs?: number) {
  return Object.assign(new Error(errcode), {
    errcode,
    httpStatus,
    data: retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs },
  });
}

export const networkError = () => new Error("fetch failed");

/**
 * Session mockée. `indexedDB` est une vraie IDBFactory (fake-indexeddb) partagée
 * entre deux `createOutbox` successifs, pour rejouer un rechargement de page.
 */
export function fakeSession(indexedDB: IDBFactory = new IDBFactory()) {
  let txnCounter = 0;
  // Sain par défaut : la plupart des tests n'ont rien à dire sur la connectivité.
  let syncState: string | null = "SYNCING";
  const wipes = new Map<string, () => Promise<void> | void>();
  const syncListeners: ((state: string, previous: string | null) => void)[] = [];

  const client = {
    getSyncState: vi.fn(() => syncState),
    makeTxnId: vi.fn(() => `txn-${txnCounter++}`),
    // Aucun salon connu, donc aucun écho local : ce faux `sendEvent` n'en pose pas.
    // Ce que le SDK garde d'un envoi raté se prouve contre le vrai (`sdk-reel.test.ts`).
    getRoom: vi.fn((_roomId: string) => null),
    sendEvent: vi.fn(
      async (_roomId: string, _type: string, _content: object, txnId?: string) => ({
        event_id: `$evt-${txnId}`,
      }),
    ),
    on: vi.fn((_event: string, listener: (state: string, previous: string | null) => void) => {
      syncListeners.push(listener);
    }),
    off: vi.fn((_event: string, listener: (state: string, previous: string | null) => void) => {
      const index = syncListeners.indexOf(listener);
      if (index >= 0) syncListeners.splice(index, 1);
    }),
  };

  const session = {
    client,
    // chiffré par défaut : la plupart des tests n'ont rien à dire
    // là-dessus, un salon non chiffré est le cas exceptionnel à poser exprès.
    isEncrypted: vi.fn(async (_roomId: string) => true),
    registerWipe: vi.fn((name: string, wipe: () => Promise<void> | void) => {
      wipes.set(name, wipe);
    }),
    // Audit des jonctions — `satisfies` ancre les membres définis ici sur le vrai
    // contrat. Les membres absents sont complétés par `asSession`, qui les fait lever
    // au lieu de manquer. Le `client` reste un faux assumé.
  } satisfies { client: unknown } & Partial<Omit<Session, "client">>;

  return {
    session: asSession(session),
    client,
    indexedDB,
    /**
     * Rejoue une transition d'état de sync (reconnexion). Appelée avant
     * `createOutbox`, elle ne fait que poser l'état : personne n'écoute encore.
     */
    emitSync(state: string, previous: string | null) {
      syncState = state;
      for (const listener of [...syncListeners]) listener(state, previous);
    },
    async runWipes() {
      for (const wipe of wipes.values()) await wipe();
    },
  };
}
