import type { GraphNode, GraphRelationship } from 'gitnexus-shared';
import type { BackendRepo } from './backend-client';

const DB_NAME = 'gitnexus-web-cache';
const DB_VERSION = 1;
const GRAPH_STORE = 'graphs';
const CACHE_SCHEMA_VERSION = 1;

export interface GraphPayload {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
}

export interface GraphCacheKey {
  baseUrl: string;
  repoName: string;
  indexedAt: string;
  lastCommit?: string;
}

interface CachedGraphEntry {
  id: string;
  schemaVersion: number;
  savedAt: number;
  key: GraphCacheKey;
  graph: GraphPayload;
}

export interface GraphCacheProvider {
  read(key: GraphCacheKey): Promise<GraphPayload | null>;
  write(key: GraphCacheKey, graph: GraphPayload): Promise<void>;
}

export const buildGraphCacheKey = (baseUrl: string, repoInfo: BackendRepo): GraphCacheKey => ({
  baseUrl,
  repoName: repoInfo.name,
  indexedAt: repoInfo.indexedAt || '',
  lastCommit: repoInfo.lastCommit,
});

const cacheId = (key: GraphCacheKey): string =>
  [`v${CACHE_SCHEMA_VERSION}`, key.baseUrl, key.repoName, key.indexedAt, key.lastCommit ?? ''].join(
    '|',
  );

const repoPrefix = (key: GraphCacheKey): string =>
  [`v${CACHE_SCHEMA_VERSION}`, key.baseUrl, key.repoName].join('|');

const canUseIndexedDb = (): boolean => typeof indexedDB !== 'undefined';

const requestToPromise = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (!canUseIndexedDb()) {
    return Promise.reject(new Error('IndexedDB is not available'));
  }

  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(GRAPH_STORE)) {
        db.createObjectStore(GRAPH_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open graph cache'));
    };
  });

  return dbPromise;
};

const waitForTransaction = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

const readCachedGraph = async (key: GraphCacheKey): Promise<GraphPayload | null> => {
  const db = await openDb();
  const tx = db.transaction(GRAPH_STORE, 'readonly');
  const entry = await requestToPromise<CachedGraphEntry | undefined>(
    tx.objectStore(GRAPH_STORE).get(cacheId(key)),
  );

  if (!entry || entry.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
  return entry.graph;
};

const writeCachedGraph = async (key: GraphCacheKey, graph: GraphPayload): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(GRAPH_STORE, 'readwrite');
  const store = tx.objectStore(GRAPH_STORE);
  const entry: CachedGraphEntry = {
    id: cacheId(key),
    schemaVersion: CACHE_SCHEMA_VERSION,
    savedAt: Date.now(),
    key,
    graph,
  };

  store.put(entry);
  await waitForTransaction(tx);
  await deleteStaleGraphs(db, key);
};

const deleteStaleGraphs = async (db: IDBDatabase, key: GraphCacheKey): Promise<void> => {
  const tx = db.transaction(GRAPH_STORE, 'readwrite');
  const store = tx.objectStore(GRAPH_STORE);
  const prefix = repoPrefix(key);
  const currentId = cacheId(key);
  const request = store.getAllKeys();

  request.onsuccess = () => {
    for (const existingKey of request.result) {
      if (
        typeof existingKey === 'string' &&
        existingKey.startsWith(prefix) &&
        existingKey !== currentId
      ) {
        store.delete(existingKey);
      }
    }
  };

  request.onerror = () => {
    tx.abort();
  };

  await waitForTransaction(tx);
};

export const browserGraphCache: GraphCacheProvider = {
  async read(key) {
    if (!canUseIndexedDb()) return null;

    try {
      return await readCachedGraph(key);
    } catch (error) {
      console.warn('Failed to read graph cache:', error);
      return null;
    }
  },

  async write(key, graph) {
    if (!canUseIndexedDb()) return;

    try {
      await writeCachedGraph(key, graph);
    } catch (error) {
      console.warn('Failed to write graph cache:', error);
    }
  },
};
