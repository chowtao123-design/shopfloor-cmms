const DB_NAME = 'maint-log';
// v4 (SPEC-v4.md sections 2 and 4.1): DB_VERSION 4 created purchaseRequests;
// 5 creates the libraryItems store for the repair library.
const DB_VERSION = 5;

// v3 (SPEC-v3.md section 5): coworkers and contractors sync like records,
// so the pull can store them offline (read by the service order form).
export const STORES = [
  'machines',
  'parts',
  'workOrders',
  'pmTasks',
  'coworkers',
  'contractors',
  'purchaseRequests',
  'libraryItems',
];
export const OUTBOX_STORE = 'outbox';
export const META_STORE = 'meta';

let dbPromise = null;

export function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
      // v2 sync stores (SPEC-v2.md section 8): pending writes + sync metadata.
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'opId' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('The database is blocked by another tab.'));
  });
  return dbPromise;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted.'));
  });
}

export async function getAll(store) {
  const db = await open();
  const tx = db.transaction(store, 'readonly');
  return requestPromise(tx.objectStore(store).getAll());
}

export async function get(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readonly');
  return requestPromise(tx.objectStore(store).get(id));
}

export async function put(store, record) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const result = requestPromise(tx.objectStore(store).put(record));
  await transactionDone(tx);
  return result;
}

export async function bulkPut(store, records) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const objectStore = tx.objectStore(store);
  for (const record of records) objectStore.put(record);
  await transactionDone(tx);
}

export async function del(store, id) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  await transactionDone(tx);
}

export async function clear(store) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await transactionDone(tx);
}

export async function clearAll() {
  const db = await open();
  const stores = [...STORES, OUTBOX_STORE, META_STORE];
  const tx = db.transaction(stores, 'readwrite');
  for (const store of stores) tx.objectStore(store).clear();
  await transactionDone(tx);
}

/** Read one sync metadata value ({key, value} rows in the `meta` store). */
export async function getMeta(key) {
  const row = await get(META_STORE, key);
  return row === undefined || row === null ? null : row.value;
}

/** Write one sync metadata value. */
export async function setMeta(key, value) {
  await put(META_STORE, { key, value });
}

export async function replaceAll(data) {
  const db = await open();
  const tx = db.transaction(STORES, 'readwrite');
  for (const store of STORES) {
    const objectStore = tx.objectStore(store);
    objectStore.clear();
    for (const record of data[store] || []) objectStore.put(record);
  }
  await transactionDone(tx);
}

export const db = {
  open,
  getAll,
  get,
  put,
  bulkPut,
  del,
  clear,
  clearAll,
  replaceAll,
  getMeta,
  setMeta,
  STORES,
  OUTBOX_STORE,
  META_STORE,
};
