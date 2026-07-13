// outbox.js — IndexedDB-backed offline report queue, shared by the map page and
// the service worker.
//
// Why IndexedDB and not localStorage: the offline report queue used to live in
// localStorage (`bwr_map_reports`), but localStorage is main-thread only — a
// service worker cannot read it. For the Background Sync API to replay queued
// reports while the page is CLOSED, the queue has to live in a store both the
// page and the SW can reach. IndexedDB is that store.
//
// Loaded as a classic script on the map page AND via importScripts('/js/outbox.js')
// in sw.js, so it must not touch `window`/`document` — it attaches `bwrOutbox` to
// `self`, which is the window on the page and the global scope in the worker.
(function (global) {
  var DB_NAME = 'bwr-outbox';
  var DB_VERSION = 1;
  var STORE = 'reports';

  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: '_id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // Wrap a single IDBRequest on a fresh transaction as a promise.
  function run(mode, action) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = action(t.objectStore(STORE));
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  global.bwrOutbox = {
    // Append a record: { url, auth, payload, queuedAt }. Resolves to its _id.
    add: function (record) {
      return run('readwrite', function (store) { return store.add(record); });
    },
    // All queued records, each carrying its assigned _id.
    all: function () {
      return run('readonly', function (store) { return store.getAll(); })
        .then(function (rows) { return rows || []; });
    },
    // Remove one record by _id (call after a successful replay).
    delete: function (id) {
      return run('readwrite', function (store) { return store.delete(id); });
    },
    // Number of queued records.
    count: function () {
      return run('readonly', function (store) { return store.count(); })
        .then(function (n) { return n || 0; });
    },
  };
})(self);
