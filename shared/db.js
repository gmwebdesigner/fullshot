import { DB_NAME, DB_STORE, DB_VERSION } from './constants.js';

/**
 * Tiny IndexedDB wrapper.
 *
 * The finished screenshot is a multi-megabyte Blob. chrome.runtime messages are
 * JSON, so sending it that way means base64 (+33% size) through a single
 * channel; chrome.storage.local has a quota and also stores strings only.
 * IndexedDB stores the Blob natively and is reachable from both the service
 * worker and the extension pages, so it is the cheapest handoff available.
 */
function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, mode);
    const store = transaction.objectStore(DB_STORE);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function putCapture(record) {
  const db = await open();
  try {
    await tx(db, 'readwrite', (store) => store.put(record));
  } finally {
    db.close();
  }
  return record.id;
}

export async function getCapture(id) {
  const db = await open();
  try {
    return await tx(db, 'readonly', (store) => store.get(id));
  } finally {
    db.close();
  }
}

export async function deleteCapture(id) {
  const db = await open();
  try {
    await tx(db, 'readwrite', (store) => store.delete(id));
  } finally {
    db.close();
  }
}

/**
 * Drop captures older than `maxAgeMs`. Called on every new capture so the
 * database never grows without bound — the result page only ever needs the
 * capture it was opened with.
 */
export async function pruneCaptures(maxAgeMs = 30 * 60 * 1000, keepId = null) {
  const db = await open();
  try {
    const cutoff = Date.now() - maxAgeMs;
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readwrite');
      const store = transaction.objectStore(DB_STORE);
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const value = cursor.value;
        if (value.id !== keepId && (value.createdAt || 0) < cutoff) cursor.delete();
        cursor.continue();
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
