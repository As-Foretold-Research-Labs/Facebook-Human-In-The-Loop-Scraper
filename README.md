# Facebook Human-in-the-Loop Scraper

A browser extension that passively collects Facebook post data while you scroll through your feed, profile pages, groups, and search results — no automated crawling, no API keys required.

Inspired by the [X/Twitter Human-in-the-Loop Scraper](https://github.com/As-Foretold-Research-Labs/X-Human-in-the-Loop-Scraper).

---

## What it collects

For every Facebook post that appears in your browser the extension extracts:

| Field | Description |
|---|---|
| `url` | Canonical permalink of the post |
| `authorName` | Display name of the poster |
| `authorProfileUrl` | Facebook profile/page URL of the poster |
| `text` | Full text body of the post |
| `timestamp` | ISO-8601 datetime when the post was published |
| `mediaUrls` | Images and videos embedded in the post |
| `reactions` | Total reaction count (Like, Love, Haha, Wow, Sad, Angry, Care) |
| `comments` | Comment count |
| `shares` | Share count |
| `isShare` | `true` when the post is a reshare of another post |
| `pageContext` | Where the post was seen: `feed`, `profile`, `group`, `search`, `watch`, `event` |
| `collectedAt` | ISO-8601 datetime when the extension collected the post |

---

## Installation — Chrome / Chromium

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repository folder.
5. Navigate to `facebook.com` and scroll normally — the extension collects posts in the background.

## Installation — Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on** and select `manifest-firefox.json` from the repository folder.

> **Note:** For a permanent Firefox installation, the extension must be signed by Mozilla. Use the temporary load approach for testing.

---

## Usage

Click the extension icon in the toolbar to open the popup:

- **Total collected** — running count of unique posts saved to IndexedDB.
- **Active collection** — toggle collection on or off without uninstalling.
- **Export as JSON / CSV** — download all collected posts.
- **Clear Database** — wipe all stored posts.
- **Last 5 collected** — quick preview of recent posts.

### Options

Open **Options** (right-click the extension icon → *Options*) to configure:

| Option | Description |
|---|---|
| Webhook URL | POST collected posts as JSON to an n8n, Supabase, or custom endpoint |
| Enable webhook forwarding | Turn webhook delivery on or off |
| Auto-collect on page load | Start collecting as soon as a Facebook page loads |
| Page contexts | Choose which parts of Facebook to collect from (Feed, Profile, Group, Search, Watch, Events) |
| Author name filter | Comma-separated list of author display names; leave blank to collect from everyone |
| Keyword filter | Comma-separated keywords; only posts containing at least one are kept |
| Notion integration | Sync a list of author names from a Notion database and use it as the exclusive author filter |

### Notion integration

1. Create a Notion integration at <https://www.notion.so/my-integrations> and copy the **Internal Integration Key**.
2. Share your tracking database with the integration.
3. Paste the key and the **Database ID** into the Options page and enable Notion integration.
4. The extension will refresh the name list every 5 minutes and only collect posts from matching authors.

The extension looks for a property named **Name**, **Author**, or **Handle** in your Notion database rows.

---

## Webhook payload

```json
{
  "posts": [
    {
      "url": "https://www.facebook.com/examplepage/posts/123456",
      "authorName": "Example Page",
      "authorProfileUrl": "https://www.facebook.com/examplepage",
      "text": "Post body text here...",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "mediaUrls": ["https://..."],
      "reactions": 142,
      "comments": 17,
      "shares": 5,
      "isShare": false,
      "pageContext": "feed",
      "collectedAt": "2024-01-15T10:31:02.000Z"
    }
  ]
}
```

---

## Privacy & ethics

- All data is stored **locally** in the browser's IndexedDB. Nothing leaves your browser unless you enable webhook forwarding or export manually.
- The extension only runs on `facebook.com` and only while you are actively browsing.
- Use responsibly and in accordance with Facebook's Terms of Service and applicable law.