// Background service worker: stores Facebook posts in IndexedDB and forwards
// them to a webhook if configured.

const DB_NAME = 'fbosint_db';
const DB_VERSION = 1;
const STORE_NAME = 'posts';

let sessionCount = 0;

// Notion sync: cache of author names pulled from a Notion database
let notionNames = [];

async function fetchNotionNamesOnce() {
  try {
    const cfg = await new Promise((res) =>
      chrome.storage.sync.get(
        { notionEnabled: false, notionApiKey: '', notionDatabaseId: '' },
        res
      )
    );
    if (!cfg.notionEnabled || !cfg.notionApiKey || !cfg.notionDatabaseId) return;

    const url = `https://api.notion.com/v1/databases/${cfg.notionDatabaseId}/query`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.notionApiKey,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ page_size: 100 })
    });
    if (!resp.ok) throw new Error('Notion fetch failed ' + resp.status);
    const data = await resp.json();
    const pages = data.results || [];
    const names = [];

    for (const p of pages) {
      const props = p.properties || {};
      // Try "Name" property first, then "Handle", then any title/rich_text
      const candidates = ['Name', 'Handle', 'Author'];
      let found = false;
      for (const key of candidates) {
        if (!props[key]) continue;
        const prop = props[key];
        let val = '';
        if (prop.type === 'rich_text' && prop.rich_text && prop.rich_text.length) {
          val = prop.rich_text.map((t) => t.plain_text).join('');
        } else if (prop.type === 'title' && prop.title && prop.title.length) {
          val = prop.title.map((t) => t.plain_text).join('');
        }
        if (val.trim()) {
          names.push(val.trim());
          found = true;
          break;
        }
      }
      // Fallback: scan all properties for a title-type field
      if (!found) {
        for (const k of Object.keys(props)) {
          const prop = props[k];
          if (prop && prop.type === 'title' && prop.title && prop.title.length) {
            const val = prop.title.map((t) => t.plain_text).join('').trim();
            if (val) {
              names.push(val);
              break;
            }
          }
        }
      }
    }

    const uniq = Array.from(new Set(names));
    notionNames = uniq;
    chrome.storage.local.set({ notionNames: uniq });
  } catch (e) {
    console.error('Notion sync error', e);
  }
}

// Refresh Notion names every 5 minutes
setInterval(() => {
  fetchNotionNamesOnce();
}, 5 * 60 * 1000);
fetchNotionNamesOnce();

// ------------------------------------------------------------------
// IndexedDB helpers
// ------------------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
        store.createIndex('collectedAt', 'collectedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storePosts(posts) {
  if (!posts || !posts.length) return { inserted: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    let inserted = 0;
    tx.oncomplete = () => resolve({ inserted });
    tx.onerror = () => reject(tx.error);
    for (const post of posts) {
      const getReq = store.get(post.url);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          const rec = Object.assign({}, post, {
            collectedAt: new Date().toISOString()
          });
          store.add(rec);
          inserted++;
        }
      };
      getReq.onerror = () => {
        // ignore individual get errors
      };
    }
  });
}

// ------------------------------------------------------------------
// Webhook forwarding
// ------------------------------------------------------------------

async function forwardToWebhook(posts) {
  try {
    const settings = await new Promise((res) =>
      chrome.storage.sync.get({ webhookEnabled: false, webhookUrl: '' }, res)
    );
    if (!settings.webhookEnabled || !settings.webhookUrl) {
      return { ok: false, reason: 'disabled' };
    }
    const payload = JSON.stringify({ posts });
    const doPost = async () => {
      const resp = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!resp.ok) throw new Error('bad resp ' + resp.status);
      return { ok: true };
    };
    try {
      return await doPost();
    } catch (e) {
      // Retry once on transient failure
      try {
        return await doPost();
      } catch (e2) {
        return { ok: false, reason: e2.message };
      }
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ------------------------------------------------------------------
// Counters and badge
// ------------------------------------------------------------------

function addToTotalCount(n) {
  chrome.storage.local.get({ totalCollected: 0 }, (items) => {
    const total = (items.totalCollected || 0) + n;
    chrome.storage.local.set({ totalCollected: total });
  });
}

function setBadge(count) {
  const text = count > 0 ? String(count) : '';
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      chrome.action.setBadgeText({ text });
    }
  } catch (e) {}
  // Firefox / Chrome MV2 fallback
  try {
    if (chrome.browserAction && chrome.browserAction.setBadgeText) {
      chrome.browserAction.setBadgeText({ text });
    }
  } catch (e) {}
}

// ------------------------------------------------------------------
// Message listeners
// ------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'postBatch') {
    const posts = Array.isArray(msg.posts) ? msg.posts : [];
    (async () => {
      try {
        const res = await storePosts(posts);
        if (res.inserted && res.inserted > 0) {
          sessionCount += res.inserted;
          addToTotalCount(res.inserted);
          setBadge(sessionCount);
          try {
            await forwardToWebhook(posts);
          } catch (e) {
            // webhook errors are non-fatal
          }
        }
      } catch (e) {
        console.error('storePosts error', e);
      }
    })();
    sendResponse({ received: true });
    return true; // indicate async response possible
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'resetSessionCount') {
    sessionCount = 0;
    setBadge(0);
    sendResponse({ ok: true });
  }
  if (msg.type === 'getSessionCount') {
    sendResponse({ sessionCount });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ totalCollected: 0 }, (items) => {
    if (typeof items.totalCollected === 'undefined') {
      chrome.storage.local.set({ totalCollected: 0 });
    }
  });
});
