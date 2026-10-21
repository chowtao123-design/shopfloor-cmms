const DB_NAME = 'maint-log';
const DB_VERSION = 1;

export const STORES = ['machines', 'parts', 'workOrders', 'pmTasks'];

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
  const tx = db.transaction(STORES, 'readwrite');
  for (const store of STORES) tx.objectStore(store).clear();
  await transactionDone(tx);
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
  STORES,
};
