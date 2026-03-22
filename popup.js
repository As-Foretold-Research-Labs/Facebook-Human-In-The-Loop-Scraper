// Popup logic: shows totals, active toggle, exports, and last 5 posts

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('fbosint_db', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllPosts() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('posts', 'readonly');
    const store = tx.objectStore('posts');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function download(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCSV(rows) {
  const headers = [
    'url', 'authorName', 'authorProfileUrl', 'text', 'timestamp',
    'mediaUrls', 'reactions', 'comments', 'shares', 'isShare',
    'collectedAt', 'pageContext'
  ];
  const csv = [headers.join(',')];
  for (const r of rows) {
    const vals = headers.map((h) => {
      let v = r[h];
      if (Array.isArray(v)) v = v.join('|');
      if (v === null || typeof v === 'undefined') v = '';
      return '"' + String(v).replace(/"/g, '""') + '"';
    });
    csv.push(vals.join(','));
  }
  return csv.join('\n');
}

document.addEventListener('DOMContentLoaded', async () => {
  const totalEl = document.getElementById('total');
  const activeToggle = document.getElementById('activeToggle');
  const last5 = document.getElementById('last5');

  function refreshTotal() {
    chrome.storage.local.get({ totalCollected: 0, active: true }, (items) => {
      totalEl.textContent = items.totalCollected || 0;
      activeToggle.checked = !!items.active;
    });
  }

  refreshTotal();

  activeToggle.addEventListener('change', () => {
    const active = activeToggle.checked;
    chrome.storage.local.set({ active });
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(
          t.id,
          { type: active ? 'resume' : 'pause' },
          () => {}
        );
      }
    });
  });

  document.getElementById('exportJson').addEventListener('click', async () => {
    const rows = await getAllPosts();
    download('fbosint_posts.json', JSON.stringify(rows, null, 2), 'application/json');
  });

  document.getElementById('exportCsv').addEventListener('click', async () => {
    const rows = await getAllPosts();
    download('fbosint_posts.csv', toCSV(rows), 'text/csv');
  });

  document.getElementById('clearDb').addEventListener('click', async () => {
    if (!confirm('Clear all collected posts? This cannot be undone.')) return;
    const db = await openDB();
    const tx = db.transaction('posts', 'readwrite');
    tx.objectStore('posts').clear();
    tx.oncomplete = () => {
      chrome.storage.local.set({ totalCollected: 0 });
      chrome.runtime.sendMessage({ type: 'resetSessionCount' });
      refreshTotal();
      last5.innerHTML = '';
      alert('Database cleared');
    };
  });

  // Show last 5 collected posts
  try {
    const rows = await getAllPosts();
    rows.sort((a, b) => new Date(b.collectedAt) - new Date(a.collectedAt));
    const top = rows.slice(0, 5);
    last5.innerHTML = '';
    for (const r of top) {
      const d = document.createElement('div');
      d.className = 'post-preview';
      const time = new Date(r.collectedAt).toLocaleString();
      d.innerHTML =
        `<div><strong>${r.authorName || r.authorProfileUrl || '(unknown)'}</strong> <span class="muted">${time}</span></div>` +
        `<div>${(r.text || '').slice(0, 80)}${(r.text || '').length > 80 ? '…' : ''}</div>`;
      last5.appendChild(d);
    }
    if (!top.length) last5.textContent = 'No posts yet';
  } catch (e) {
    last5.textContent = 'No posts yet';
  }
});
