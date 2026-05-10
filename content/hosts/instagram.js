// Per-host config for instagram.com.
//
// We classify by topic only. The post selector covers home-feed articles,
// reels-tray tiles, and explore tiles uniformly — once a tile matches, the
// classifier looks at its text/hashtags to decide. There's no reel-specific
// branch.

(function () {
  'use strict';
  const reg = (window.IntentGuardHosts = window.IntentGuardHosts || {});

  // Stop-word list for topic extraction. Small and English-only — enough to
  // strip out the generic filler that pollutes captions ("just", "really",
  // "going", etc.) without cutting words a user might actually want to act
  // on. Length-4 minimum below this list does most of the heavy lifting.
  const STOPWORDS = new Set([
    'about','above','after','again','against','also','always','among','around',
    'because','been','before','being','below','between','both','came','come',
    'comes','coming','could','does','doing','done','down','dont','during',
    'each','either','enough','even','ever','every','everyone','everything',
    'first','five','four','from','given','gives','goes','going','gone',
    'gotta','hadnt','hardly','have','having','here','heres','herself','himself',
    'into','isnt','itself','just','keep','kept','kind','knew','know','known',
    'last','latest','least','less','like','liked','likes','line','lines','little',
    'long','look','looked','looking','looks','made','make','makes','making',
    'many','maybe','more','most','much','must','myself','need','needed','needs',
    'never','nevertheless','next','nine','none','nothing','nowhere','often',
    'once','only','onto','other','others','ours','ourselves','over','overly',
    'people','perhaps','quite','rather','really','said','same','says','seem',
    'seems','seven','several','shall','shouldnt','since','some','someone',
    'something','sometimes','somewhere','soon','still','such','take','taken',
    'takes','taking','tell','tells','than','thank','thanks','that','thats',
    'their','theirs','them','themselves','then','there','theres','these','they',
    'theyre','thing','things','think','thinks','third','this','those','three',
    'through','today','together','tomorrow','tonight','took','toward','towards',
    'tried','tries','trying','turn','turned','turns','twice','under','until',
    'upon','used','uses','using','very','want','wanted','wants','wasnt','watch',
    'watched','watches','watching','well','went','were','werent','what','whats',
    'when','where','which','while','whilst','whoever','whole','whom','whose',
    'will','with','within','without','wont','would','wouldnt','your','youre',
    'yours','yourself','yourselves',
  ]);

  // Tiles are often thin (an image + handle, no caption). Pull every signal
  // we can — innerText, image alt, and aria-labels — so the topic classifier
  // has something to match against.
  function extractText(el) {
    if (!el) return '';
    const parts = [];
    if (el.innerText) parts.push(el.innerText);
    if (el.getAttribute) {
      const lab = el.getAttribute('aria-label');
      if (lab) parts.push(lab);
    }
    try {
      const imgs = el.querySelectorAll ? el.querySelectorAll('img[alt]') : [];
      imgs.forEach((img) => {
        const a = img.getAttribute('alt');
        if (a) parts.push(a);
      });
      const labs = el.querySelectorAll ? el.querySelectorAll('[aria-label]') : [];
      labs.forEach((n) => {
        const lab = n.getAttribute('aria-label');
        if (lab) parts.push(lab);
      });
    } catch (_e) { /* ignore */ }
    return parts.join(' ');
  }

  function isReelsViewerRoute() {
    return /^\/reels?\//.test(location.pathname) || /^\/explore\/reels\//.test(location.pathname);
  }

  // Lift a video element up to a tile ancestor that's safe to overlay. We
  // avoid lifting all the way to <main> — too coarse — and prefer
  // section/region wrappers that bound a single reel.
  function liftVideoToReelTile(v) {
    if (!v) return null;
    return (
      v.closest('section[aria-labelledby]') ||
      v.closest('section') ||
      v.closest('[role="region"]') ||
      v.closest('div[role="dialog"]') ||
      v.closest('div[data-visualcompletion="ignore-dynamic"]') ||
      v.closest('article') ||
      v.parentElement ||
      null
    );
  }

  reg.instagram = {
    key: 'instagram',
    matches: (hostname) => /(^|\.)instagram\.com$/.test(hostname),

    feedRoot: () =>
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body,

    // Walk the current DOM and return every classifiable tile. We use a
    // function rather than a static CSS selector because the /reels viewer
    // doesn't expose tiles via simple selectors — each reel is a <section>
    // around a <video>, with no anchor or article.
    enumeratePosts: () => {
      const out = new Set();
      document.querySelectorAll('article').forEach((el) => out.add(el));
      document.querySelectorAll('a[href*="/reel/"]').forEach((el) => out.add(el));
      if (isReelsViewerRoute()) {
        document.querySelectorAll('video[playsinline]').forEach((v) => {
          const tile = liftVideoToReelTile(v);
          if (tile) out.add(tile);
        });
      }
      return Array.from(out);
    },

    textExtractor: extractText,
    authorExtractor: (el) => {
      const a =
        el.querySelector('header a[role="link"]') ||
        el.querySelector('a[role="link"]');
      return a ? (a.textContent || '').trim() : '';
    },
    hashtagExtractor: (el) =>
      Array.from(extractText(el).matchAll(/#(\w+)/g)).map((m) => m[1].toLowerCase()),

    // Pull a small list of candidate topics from a tile so the chip strip has
    // something to render. Hashtags first (highest signal), then significant
    // caption words. Returns [{ kind: 'hashtag' | 'keyword', term }].
    topicsExtractor: (el) => {
      const text = extractText(el).toLowerCase();
      const out = [];
      const seen = new Set();

      const tags = Array.from(text.matchAll(/#([a-z][a-z0-9_]{2,})/g)).map((m) => m[1]);
      for (const t of tags) {
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({ kind: 'hashtag', term: t });
        if (out.length >= 8) return out;
      }

      const stripped = text.replace(/#[a-z0-9_]+/g, ' ').replace(/https?:\/\/\S+/g, ' ');
      const tokens = stripped.split(/[^a-z]+/g);
      for (const tok of tokens) {
        if (!tok || tok.length < 4) continue;
        if (STOPWORDS.has(tok)) continue;
        if (seen.has(tok)) continue;
        seen.add(tok);
        out.push({ kind: 'keyword', term: tok });
        if (out.length >= 8) break;
      }
      return out;
    },
  };
})();
