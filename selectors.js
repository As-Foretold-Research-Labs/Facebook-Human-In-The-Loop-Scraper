// Centralized DOM selectors for Facebook scraping.
// Keep selectors semantic and resilient: prefer role, aria-label, dir, and
// data attributes over generated class names which Facebook rotates frequently.

(function () {
  window.FBOSINT_SELECTORS = {
    // Facebook feed posts and page posts are rendered as div[role="article"].
    postArticle: 'div[role="article"]',

    // Post permalink link patterns — any of these href patterns indicates a
    // specific post rather than a profile/group homepage.
    postLink: [
      'a[href*="/posts/"]',
      'a[href*="story_fbid"]',
      'a[href*="/permalink/"]',
      'a[href*="?fbid="]',
      'a[href*="photo?fbid"]',
      'a[href*="/videos/"]',
      'a[href*="/photos/"]',
      'a[href*="/groups/"][href*="/posts/"]'
    ].join(', '),

    // Timestamp links: Facebook renders post timestamps as <a> elements whose
    // aria-label contains a human-readable date/time string.
    timeLink: 'a[role="link"]',

    // Post text content: Facebook wraps the author-written body in divs with
    // dir="auto" to support bidirectional text.
    postText: 'div[dir="auto"]',

    // Media inside a post.
    image: 'img',
    video: 'video, video source',

    // Any element carrying an aria-label that may encode engagement counts
    // (reactions, comments, shares).
    engagementLabel: '[aria-label]'
  };
})();
