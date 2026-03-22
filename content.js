// Content script: watches for new div[role="article"] elements and extracts
// Facebook post data. Uses selectors from selectors.js (window.FBOSINT_SELECTORS)
// to remain maintainable when Facebook rotates class names.

(function () {
  const S = window.FBOSINT_SELECTORS || {};

  let running = true;
  let seen = new Set(); // deduplicate by normalized post URL within this session
  let batch = [];

  // Settings (synced from chrome.storage.sync)
  let settings = {
    webhookEnabled: false,
    webhookUrl: '',
    autoCollect: true,
    contexts: ['feed', 'profile', 'group', 'search', 'watch', 'event'],
    nameFilter: '',
    keywordFilter: ''
  };
  // Cached Notion names (fetched by background)
  settings.notionNames = [];

  function loadSettings() {
    chrome.storage.sync.get(settings, (items) => {
      settings = Object.assign(settings, items);
      chrome.storage.local.get({ active: !!settings.autoCollect, notionNames: [] }, (local) => {
        running = !!local.active;
        settings.notionNames = local.notionNames || [];
      });
    });
  }
  loadSettings();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      loadSettings();
    }
    if (area === 'local' && changes.active) {
      running = !!changes.active.newValue;
    }
  });

  // Debounced sender: flush batch every 5 seconds when there are pending posts
  setInterval(() => {
    if (batch.length > 0) {
      chrome.runtime.sendMessage({ type: 'postBatch', posts: batch }, () => {});
      batch = [];
    }
  }, 5000);

  // Allow background/popup to pause or resume collection
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'pause') {
      running = false;
      sendResponse({ ok: true });
    } else if (msg && msg.type === 'resume') {
      running = true;
      sendResponse({ ok: true });
    }
  });

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function pageContextFromUrl(url) {
    try {
      const u = new URL(url);
      const p = u.pathname;
      if (p === '/' || /^\/\?/.test(url) || p.startsWith('/home')) return 'feed';
      if (/^\/groups\//.test(p)) return 'group';
      if (/^\/events\//.test(p)) return 'event';
      if (/^\/search\//.test(p) || u.searchParams.has('q')) return 'search';
      if (/^\/watch/.test(p)) return 'watch';
      if (/^\/marketplace/.test(p)) return 'marketplace';
      return 'profile';
    } catch (e) {
      return 'unknown';
    }
  }

  function parseCountFromText(text) {
    if (!text) return 0;
    // strip commas/spaces, then match number with optional K/M/B suffix
    const t = text.replace(/,/g, '').replace(/\u00a0/g, '');
    const m = t.match(/([\d]+(?:\.[\d]+)?)\s*(K|M|B)?/i);
    if (!m) return 0;
    let val = parseFloat(m[1]);
    const suffix = (m[2] || '').toUpperCase();
    if (suffix === 'K') val *= 1000;
    if (suffix === 'M') val *= 1000000;
    if (suffix === 'B') val *= 1000000000;
    return Math.round(val);
  }

  function isFacebookHostname(hostname) {
    return hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
  }

  function isFacebookPostUrl(href) {
    try {
      const u = new URL(href, location.href);
      if (!isFacebookHostname(u.hostname)) return false;
      const p = u.pathname;
      return (
        /\/posts\//.test(p) ||
        u.searchParams.has('story_fbid') ||
        /\/permalink\.php/.test(p) ||
        u.searchParams.has('fbid') ||
        (/\/photos\//.test(p) && !/\/photos$/.test(p)) ||
        (/\/videos\//.test(p) && !/\/videos$/.test(p)) ||
        (u.searchParams.has('photo') && u.searchParams.get('photo').length > 0) ||
        /\/groups\/.+\/posts\//.test(p)
      );
    } catch (e) {
      return false;
    }
  }

  // Strip Facebook tracking parameters while preserving the identity of the post
  function normalizePostUrl(href) {
    try {
      const u = new URL(href, location.href);
      const keepParams = ['story_fbid', 'id', 'fbid', 'photo'];
      const params = new URLSearchParams();
      for (const k of keepParams) {
        if (u.searchParams.has(k)) params.set(k, u.searchParams.get(k));
      }
      const base = u.origin + u.pathname;
      const qs = params.toString();
      return qs ? base + '?' + qs : base;
    } catch (e) {
      return href;
    }
  }

  // Return true when a pathname looks like a user profile or page root
  // (not a sub-section like /posts, /videos, /groups, etc.)
  function isProfileRoot(pathname) {
    return /^\/[^/?#]+\/?$/.test(pathname) && !/^\/(groups|events|pages|watch|marketplace|search|hashtag|home)/.test(pathname);
  }

  // ------------------------------------------------------------------
  // Core extraction
  // ------------------------------------------------------------------

  function extractFromArticle(article) {
    // 1. Find a post permalink link
    let postUrl = null;
    const allLinks = Array.from(article.querySelectorAll('a[href]'));
    for (const a of allLinks) {
      if (isFacebookPostUrl(a.href)) {
        postUrl = normalizePostUrl(a.href);
        break;
      }
    }
    if (!postUrl) return null;
    if (seen.has(postUrl)) return null;

    // 2. Timestamp — scan link aria-labels for date/time hints; fall back to now
    let timestamp = null;
    for (const a of allLinks) {
      // Check for an abbr[data-utime] inside the link (legacy Facebook)
      const abbr = a.querySelector('abbr[data-utime]');
      if (abbr) {
        const utime = abbr.getAttribute('data-utime');
        if (utime) {
          timestamp = new Date(parseInt(utime, 10) * 1000).toISOString();
          break;
        }
      }
      // Check for <time datetime="..."> inside the link
      const timeEl = a.querySelector('time[datetime]');
      if (timeEl) {
        const dt = timeEl.getAttribute('datetime');
        if (dt) {
          timestamp = new Date(dt).toISOString();
          break;
        }
      }
      // aria-label on the link itself sometimes contains a parseable date
      const lab = a.getAttribute('aria-label') || '';
      if (lab && /\d{4}/.test(lab)) {
        const parsed = Date.parse(lab);
        if (!isNaN(parsed)) {
          timestamp = new Date(parsed).toISOString();
          break;
        }
      }
    }
    if (!timestamp) timestamp = new Date().toISOString();

    // 3. Author — first profile-root link whose visible text looks like a name
    let authorName = '';
    let authorProfileUrl = '';
    for (const a of allLinks) {
      if (!a.href) continue;
      try {
        const u = new URL(a.href);
        if (!isFacebookHostname(u.hostname)) continue;
        const p = u.pathname;
        // Skip post/group/event/special-section links
        if (isFacebookPostUrl(a.href)) continue;
        if (/\/(events|pages|watch|marketplace|search|hashtag)\//.test(p)) continue;
        // profile.php?id=... is valid
        const isProfilePhp = p === '/profile.php' && u.searchParams.has('id');
        const isRoot = isProfileRoot(p);
        if (!isRoot && !isProfilePhp) continue;
        const txt = (a.innerText || '').trim();
        if (txt && txt.length > 0 && txt.length < 80 && !/\n/.test(txt)) {
          authorName = txt;
          authorProfileUrl = isProfilePhp ? u.origin + u.pathname + '?id=' + u.searchParams.get('id') : u.origin + u.pathname.replace(/\/$/, '');
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // 4. Post text — collect unique innerText from all div[dir="auto"] elements
    const textDivs = article.querySelectorAll(S.postText || 'div[dir="auto"]');
    const textParts = [];
    for (const div of textDivs) {
      const t = (div.innerText || '').trim();
      if (t && !textParts.includes(t)) textParts.push(t);
    }
    let text = textParts.join(' ').trim();

    // Fallback: use full article text with author name stripped
    if (!text) {
      text = (article.innerText || '');
      if (authorName) text = text.replace(authorName, '');
      text = text.replace(/\n+/g, ' ').trim();
    }

    // 5. Media URLs
    const mediaUrls = [];
    article.querySelectorAll('img').forEach((img) => {
      const src = img.src || img.getAttribute('data-src');
      // Skip tiny tracker pixels and emoji images
      if (src && !/emoji|static\.xx\.fbcdn|rsrc\.php/.test(src)) mediaUrls.push(src);
    });
    article.querySelectorAll('video, video source').forEach((v) => {
      const src = v.src || v.getAttribute('src') || v.getAttribute('poster');
      if (src) mediaUrls.push(src);
    });

    // 6. Engagement counts: reactions, comments, shares
    let reactions = 0;
    let comments = 0;
    let shares = 0;
    article.querySelectorAll('[aria-label]').forEach((el) => {
      const lab = el.getAttribute('aria-label') || '';
      if (!/\d/.test(lab)) return;
      const L = lab.toLowerCase();
      if (
        L.includes('reaction') ||
        L.includes('like') ||
        L.includes('love') ||
        L.includes('haha') ||
        L.includes('wow') ||
        L.includes('sad') ||
        L.includes('angry') ||
        L.includes('care')
      ) {
        reactions = Math.max(reactions, parseCountFromText(lab));
      } else if (L.includes('comment')) {
        comments = Math.max(comments, parseCountFromText(lab));
      } else if (L.includes('share')) {
        shares = Math.max(shares, parseCountFromText(lab));
      }
    });

    // 7. isShare — post is a reshare when the word "shared" appears or there is
    //    a nested article element within the outer article
    const articleText = article.innerText || '';
    const isShare =
      /\bshared\b/i.test(articleText) ||
      !!article.querySelector((S.postArticle || 'div[role="article"]') + ' ' + (S.postArticle || 'div[role="article"]'));

    const pageContext = pageContextFromUrl(location.href);

    // ------------------------------------------------------------------
    // Filter checks
    // ------------------------------------------------------------------

    // Context filter: only collect from the selected page contexts
    if (settings.contexts && settings.contexts.length) {
      if (!settings.contexts.includes(pageContext)) return null;
    }

    // Name filter: Notion list takes priority over manual nameFilter
    if (settings.notionNames && settings.notionNames.length) {
      if (!authorName) return null;
      const n = authorName.toLowerCase();
      const ok = settings.notionNames.some((x) => x.toLowerCase() === n);
      if (!ok) return null;
    } else if (settings.nameFilter && settings.nameFilter.trim()) {
      const allowed = settings.nameFilter
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (allowed.length) {
        if (!authorName) return null;
        const n = authorName.toLowerCase();
        const ok = allowed.some((a) => n.includes(a) || a.includes(n));
        if (!ok) return null;
      }
    }

    // Keyword filter: at least one keyword must appear in the post text
    if (settings.keywordFilter && settings.keywordFilter.trim()) {
      const kws = settings.keywordFilter
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      if (kws.length) {
        const found = kws.some((k) => (text || '').toLowerCase().includes(k));
        if (!found) return null;
      }
    }

    const result = {
      url: postUrl,
      authorName: authorName || '',
      authorProfileUrl: authorProfileUrl || '',
      text: (text || '').trim(),
      timestamp,
      mediaUrls,
      reactions,
      comments,
      shares,
      isShare,
      pageContext
    };

    seen.add(postUrl);
    return result;
  }

  // ------------------------------------------------------------------
  // DOM observation
  // ------------------------------------------------------------------

  function processAddedNode(node) {
    if (!running) return;
    try {
      if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
      const articles = [];
      const articleSel = S.postArticle || 'div[role="article"]';
      if (node.matches && node.matches(articleSel)) articles.push(node);
      if (node.querySelectorAll) {
        node.querySelectorAll(articleSel).forEach((a) => articles.push(a));
      }
      for (const art of articles) {
        const p = extractFromArticle(art);
        if (p) batch.push(p);
      }
    } catch (e) {
      // ignore individual extraction errors silently
    }
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) {
        m.addedNodes.forEach((n) => processAddedNode(n));
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan for posts already present when the script loads
  window.addEventListener('load', () => {
    const initial = document.querySelectorAll(S.postArticle || 'div[role="article"]');
    initial.forEach((a) => {
      const p = extractFromArticle(a);
      if (p) batch.push(p);
    });
  });

  // Small debug API exposed on the window for manual testing
  window.__FBOSINT = {
    seen,
    getBatch: () => batch.slice(),
    flush: () => {
      if (batch.length) {
        chrome.runtime.sendMessage({ type: 'postBatch', posts: batch }, () => {});
        batch = [];
      }
    }
  };
})();
