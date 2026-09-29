import type { TxInput } from "@/lib/transactions";

/**
 * Offline quick-entry queue on raw IndexedDB (no runtime deps).
 * Store uses an out-of-line autoIncrement key, so iteration order IS insertion
 * order (FIFO); a non-unique "by-id" index supports removal by client UUID.
 * Connections are opened per operation and closed after — no cached handle,
 * so tests can swap the IDB factory and the browser never holds the DB open.
 */

const DB_NAME = "duit-offline";
const STORE = "quick-entry-queue";

export type QueuedEntry = { id: string; input: TxInput; queuedAt: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { autoIncrement: true });
      store.createIndex("by-id", "id");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run one transaction against the store; the DB is closed when it settles. */
async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function enqueue(entry: QueuedEntry): Promise<void> {
  await withStore("readwrite", (store) => store.add(entry));
}

/** All queued entries, oldest first (FIFO). */
export async function peekAll(): Promise<QueuedEntry[]> {
  return withStore("readonly", (store) => store.getAll() as IDBRequest<QueuedEntry[]>);
}

export async function remove(id: string): Promise<void> {
  const key = await withStore("readonly", (store) => store.index("by-id").getKey(id));
  if (key !== undefined) {
    await withStore("readwrite", (store) => store.delete(key));
  }
}

/**
 * Send queued entries oldest-first through `send`; each success is removed.
 * Stops at the first failure (returned `ok: false` or a throw), keeping the
 * failed entry and everything after it in order. Safe to re-run: entries carry
 * client UUIDs, so the server dedups a retry of a half-sent save.
 */
export async function flushQueue(
  send: (input: TxInput) => Promise<{ ok: boolean }>,
): Promise<{ sent: number; remaining: number }> {
  const entries = await peekAll();
  let sent = 0;
  for (const entry of entries) {
    try {
      const result = await send(entry.input);
      if (!result.ok) break;
    } catch {
      break;
    }
    await remove(entry.id);
    sent += 1;
  }
  return { sent, remaining: entries.length - sent };
}
