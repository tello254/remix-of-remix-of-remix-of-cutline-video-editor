/**
 * Imported media is kept in the browser so a reload does not empty the library.
 *
 * Files live in IndexedDB as blobs; the editor only ever sees object URLs,
 * which are recreated from the stored blobs on startup. Nothing is uploaded:
 * the database is local to this origin and can be cleared from the browser's
 * site-data settings.
 */

const DB_NAME = "cutline-media";
const DB_VERSION = 1;
const STORE = "files";

export type StoredMediaKind = "visual" | "audio" | "voice";
export type StoredMediaType = "video" | "image" | "audio";

export type StoredMediaFile = {
  id: string;
  name: string;
  kind: StoredMediaKind;
  mediaType: StoredMediaType;
  duration: number;
  size: number;
  createdAt: number;
  blob: Blob;
};

let database: Promise<IDBDatabase | null> | null = null;

function openDatabase() {
  if (database) return database;
  database = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T> | null,
): Promise<T | null> {
  return openDatabase().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let result: T | null = null;
        try {
          const transaction = db.transaction(STORE, mode);
          const request = action(transaction.objectStore(STORE));
          if (request) request.onsuccess = () => (result = request.result);
          transaction.oncomplete = () => resolve(result);
          transaction.onerror = () => resolve(result);
          transaction.onabort = () => resolve(result);
        } catch {
          resolve(result);
        }
      }),
  );
}

/** Stores one imported file. Resolves false when the browser refuses the write. */
export async function storeMediaFile(file: StoredMediaFile): Promise<boolean> {
  const saved = await runTransaction("readwrite", (store) => store.put(file));
  return saved !== null;
}

/** Everything saved by this browser, oldest first so the library keeps its order. */
export async function loadStoredMedia(): Promise<StoredMediaFile[]> {
  const files = await runTransaction<StoredMediaFile[]>("readonly", (store) => store.getAll());
  return (files ?? []).sort((a, b) => a.createdAt - b.createdAt);
}

/** Drops one stored file; used when a library item is removed. */
export async function removeStoredMedia(id: string): Promise<void> {
  await runTransaction("readwrite", (store) => store.delete(id));
}

/** Asks the browser to keep this origin's storage instead of evicting it. */
export function requestPersistentStorage() {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
  void navigator.storage.persist().catch(() => undefined);
}
