// Layer 2 — Mode filter, in-place overlay skip, IntersectionObserver.
//
// What this module does:
//   1. Walks the host's tile list (host.enumeratePosts() if present, else
//      host.postSelector). Each new tile is classified once via the active
//      mode's allow/block lists.
//   2. For "blocked" tiles, instead of removing them or inserting a sibling
//      skip card (which jankifies Instagram's virtualized scroller), we
//      append an absolutely-positioned overlay INSIDE the tile and hide
//      its direct children via `visibility: hidden`. The tile keeps its
//      space in the layout flow, so Instagram never sees a height change,
//      so its mutation observers don't cascade. Any <video> inside the
//      tile is paused + muted while blocked.
//   3. Topics are extracted once per tile (host.topicsExtractor). They
//      feed the fixed Topic Trainer panel — one tile at a time, picked by
//      IntersectionObserver as the user scrolls. We do NOT inject chips
//      into the page anymore; that was the source of the scroll jank.
//   4. `IG.modeFilter.applyTopicAction(term, kind, action)` is exposed
//      so trainer.js's chip clicks call back into this module's write
//      logic.

(function () {
  'use strict';
  const IG = window.IntentGuard || (window.IntentGuard = {});

  const POST_TAG_ATTR = 'data-ig-post';
  const OVERLAY_CLASS = 'ig-tile-overlay';
  const BLOCKED_CLASS = 'ig-tile-blocked';

  let host = null;
  let observer = null;
  let lastScanAt = 0;
  let throttleTimer = null;
  const verdicts = new WeakMap();
  const allTaggedPosts = new Set();
  let observedRoot = null;
  let warnedNoMatch = false;

  // intersection bookkeeping
  let intersectObserver = null;
  const tileRatios = new Map();
  let mostVisibleTile = null;
  let pendingActiveSync = null;

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------

  function start(opts) {
    host = (opts && opts.host) || pickHost();
    if (!host) {
      console.info('[IntentGuard mode_filter] no matching host config');
      return;
    }
    setupIntersectionObserver();
    attachObserver();
    setTimeout(scheduleScan, 250);
  }

  function refresh() {
    (async () => {
      const settings = await IG.store.getSettings();
      const mode = await IG.store.getMode();
      const dict = activeDictFrom(settings, mode);
      if (!dict) return;
      for (const post of Array.from(allTaggedPosts)) {
        if (!post.isConnected) {
          allTaggedPosts.delete(post);
          verdicts.delete(post);
          tileRatios.delete(post);
          continue;
        }
        const v = classify(host, post, dict);
        applyVerdict(post, v, dict.__modeName);
      }
      // recolor chips on the trainer panel for the active tile
      if (IG.trainer && typeof IG.trainer.refresh === 'function') {
        IG.trainer.refresh(settings);
      }
      // and re-push verdict text in case the active tile's verdict flipped
      pushActiveTileToTrainer(settings);
      scheduleScan();
    })();
  }

  IG.modeFilter = { start, refresh, applyTopicAction };

  // ---------------------------------------------------------------------
  // observer + throttled scan
  // ---------------------------------------------------------------------

  function attachObserver() {
    const root = host.feedRoot ? host.feedRoot() : document.body;
    if (!root) {
      setTimeout(attachObserver, 250);
      return;
    }
    observedRoot = root;
    if (observer) observer.disconnect();
    observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });

    setInterval(() => {
      const fresh = host.feedRoot ? host.feedRoot() : document.body;
      if (fresh && fresh !== observedRoot) {
        observedRoot = fresh;
        observer.disconnect();
        observer.observe(fresh, { childList: true, subtree: true });
        scheduleScan();
      }
    }, 5000);
  }

  function scheduleScan() {
    if (throttleTimer) return;
    const since = Date.now() - lastScanAt;
    const wait = since >= 100 ? 0 : 100 - since;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      lastScanAt = Date.now();
      runScan().catch((e) => console.warn('[IntentGuard scan]', e));
    }, wait);
  }

  function listPosts() {
    if (!host) return [];
    if (typeof host.enumeratePosts === 'function') {
      try { return host.enumeratePosts() || []; }
      catch (e) { console.warn('[IntentGuard] enumeratePosts failed', e); return []; }
    }
    if (host.postSelector) {
      try { return Array.from(document.querySelectorAll(host.postSelector)); }
      catch (e) { console.warn('[IntentGuard] bad postSelector', e); return []; }
    }
    return [];
  }

  async function runScan() {
    if (!host) return;
    const settings = await IG.store.getSettings();
    const mode = await IG.store.getMode();
    const dict = activeDictFrom(settings, mode);
    if (!dict) return;
    const posts = listPosts();
    if (!posts || posts.length === 0) {
      if (!warnedNoMatch) {
        console.info('[IntentGuard] no posts found yet for', host.key);
        warnedNoMatch = true;
      }
      return;
    }
    warnedNoMatch = false;
    posts.forEach((raw) => {
      const p = liftToTile(raw);
      if (!p || verdicts.has(p)) return;
      try {
        p.setAttribute(POST_TAG_ATTR, '1');
        const topics = extractTopicsSafe(p);
        const v = classify(host, p, dict);
        applyVerdict(p, v, dict.__modeName);
        const cur = verdicts.get(p) || {};
        verdicts.set(p, Object.assign({}, cur, { topics }));
        allTaggedPosts.add(p);
        if (intersectObserver) intersectObserver.observe(p);
      } catch (e) {
        console.warn('[IntentGuard] classify failed', e);
      }
    });
    pushActiveTileToTrainer(settings);
  }

  function liftToTile(el) {
    if (!el) return null;
    // <article> is the canonical post container in the home feed.
    const article = el.closest && el.closest('article');
    if (article) return article;
    // <li> / [role=listitem] are single-tile cells in grids.
    const cell = el.closest && el.closest('li, [role="listitem"]');
    if (cell) return cell;
    // For everything else (rail anchors, /reels viewer sections, etc.)
    // use the matched element itself so we never over-collapse a parent.
    return el;
  }

  // ---------------------------------------------------------------------
  // classifier
  // ---------------------------------------------------------------------

  function classify(host, postEl, dict) {
    let text = '';
    let author = '';
    let hashtags = [];
    try { text = (host.textExtractor(postEl) || '').toLowerCase(); } catch (_e) { /* ignore */ }
    try { author = (host.authorExtractor(postEl) || '').toLowerCase(); } catch (_e) { /* ignore */ }
    try { hashtags = (host.hashtagExtractor(postEl) || []).map((h) => String(h).toLowerCase()); } catch (_e) { /* ignore */ }

    if (author) {
      const ba = (dict.blockAccounts || []).find((a) => String(a).toLowerCase() === author);
      if (ba) return { show: false, rule: 'blocked-account', matchedTerm: '@' + ba };
    }
    {
      const bh = (dict.blockHashtags || []).find((h) => hashtags.includes(String(h).toLowerCase()));
      if (bh) return { show: false, rule: 'blocked-hashtag', matchedTerm: '#' + bh };
    }
    {
      const bk = (dict.blockKeywords || []).find((k) => k && text.includes(String(k).toLowerCase()));
      if (bk) return { show: false, rule: 'blocked-keyword', matchedTerm: bk };
    }

    if (author) {
      const aa = (dict.allowAccounts || []).find((a) => String(a).toLowerCase() === author);
      if (aa) return { show: true, rule: 'allowed-account', matchedTerm: '@' + aa };
    }
    {
      const ah = (dict.allowHashtags || []).find((h) => hashtags.includes(String(h).toLowerCase()));
      if (ah) return { show: true, rule: 'allowed-hashtag', matchedTerm: '#' + ah };
    }
    {
      const ak = (dict.allowKeywords || []).find((k) => k && text.includes(String(k).toLowerCase()));
      if (ak) return { show: true, rule: 'allowed-keyword', matchedTerm: ak };
    }

    if (dict.requireAllowMatch) {
      const hasAnyAllow =
        (dict.allowKeywords && dict.allowKeywords.length > 0) ||
        (dict.allowHashtags && dict.allowHashtags.length > 0) ||
        (dict.allowAccounts && dict.allowAccounts.length > 0);
      if (hasAnyAllow) return { show: false, rule: 'off-topic', matchedTerm: null };
    }

    return { show: true, rule: 'default', matchedTerm: null };
  }

  // ---------------------------------------------------------------------
  // overlay-based hide (no layout shift)
  // ---------------------------------------------------------------------

  function applyVerdict(postEl, verdict, modeName) {
    const prior = verdicts.get(postEl);

    if (verdict.show) {
      if (prior && prior.show === false) {
        removeOverlay(postEl);
        unmuteVideos(postEl);
        postEl.classList.remove(BLOCKED_CLASS);
      }
      verdicts.set(postEl, Object.assign({}, prior || {}, {
        show: true, rule: verdict.rule, matchedTerm: verdict.matchedTerm,
      }));
      return;
    }

    // hidden: ensure positioning context, mark, mount overlay, pause media.
    ensurePositionContext(postEl);
    postEl.classList.add(BLOCKED_CLASS);
    ensureOverlay(postEl, verdict, modeName);
    muteVideos(postEl);

    verdicts.set(postEl, Object.assign({}, prior || {}, {
      show: false, rule: verdict.rule, matchedTerm: verdict.matchedTerm,
    }));
  }

  function ensurePositionContext(postEl) {
    // Only set position when the element is currently `static`. We use
    // inline style so this is easy to inspect / undo and doesn't fight a
    // higher-specificity host rule.
    try {
      const cs = getComputedStyle(postEl);
      if (cs && cs.position === 'static') postEl.style.position = 'relative';
    } catch (_e) { /* ignore */ }
  }

  function ensureOverlay(postEl, verdict, modeName) {
    const existing = postEl.querySelector(':scope > .' + OVERLAY_CLASS);
    if (existing) {
      const reason = existing.querySelector('.ig-tile-overlay__reason');
      if (reason) reason.textContent = reasonText(verdict, modeName);
      return existing;
    }
    const overlay = buildOverlay(postEl, verdict, modeName);
    postEl.appendChild(overlay);
    return overlay;
  }

  function buildOverlay(postEl, verdict, modeName) {
    const wrap = document.createElement('div');
    wrap.className = 'ig-root ' + OVERLAY_CLASS;

    const card = document.createElement('div');
    card.className = 'ig-tile-overlay__card';

    const reason = document.createElement('div');
    reason.className = 'ig-tile-overlay__reason';
    reason.textContent = reasonText(verdict, modeName);

    const sub = document.createElement('div');
    sub.className = 'ig-tile-overlay__sub';
    sub.textContent = verdict.matchedTerm
      ? 'Use the Trainer panel to unblock or pick a different topic.'
      : `Switch to chill mode or add allowed topics in the popup.`;

    const actions = document.createElement('div');
    actions.className = 'ig-tile-overlay__actions';

    const show = document.createElement('button');
    show.type = 'button';
    show.className = 'ig-tile-overlay__btn';
    show.textContent = 'Show anyway';
    show.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      // local-only override: lift the overlay for this tile without
      // changing settings. WeakMap entry is updated.
      removeOverlay(postEl);
      unmuteVideos(postEl);
      postEl.classList.remove(BLOCKED_CLASS);
      const prior = verdicts.get(postEl) || {};
      verdicts.set(postEl, Object.assign({}, prior, { show: true, rule: 'manual-show', matchedTerm: null }));
      // also ping trainer if this was the active tile
      if (postEl === mostVisibleTile) pushActiveTileToTrainer();
    });

    actions.appendChild(show);

    if (verdict.matchedTerm) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'ig-tile-overlay__btn ig-tile-overlay__btn--ghost';
      undo.textContent = `Unblock ${verdict.matchedTerm}`;
      undo.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        const term = String(verdict.matchedTerm || '').replace(/^[#@]/, '');
        const kind = verdict.matchedTerm.startsWith('#') ? 'hashtag'
          : verdict.matchedTerm.startsWith('@') ? 'account' : 'keyword';
        applyTopicAction(term, kind, 'unblock');
      });
      actions.appendChild(undo);
    }

    card.appendChild(reason);
    card.appendChild(sub);
    card.appendChild(actions);
    wrap.appendChild(card);
    return wrap;
  }

  function removeOverlay(postEl) {
    const existing = postEl.querySelector(':scope > .' + OVERLAY_CLASS);
    if (existing) {
      try { existing.remove(); } catch (_e) { /* ignore */ }
    }
  }

  function reasonText(verdict, modeName) {
    if (verdict.matchedTerm) return `blocked: ${verdict.matchedTerm}`;
    if (verdict.rule === 'off-topic') return `off-topic for ${modeName} mode`;
    return verdict.rule;
  }

  function muteVideos(postEl) {
    try {
      postEl.querySelectorAll('video').forEach((v) => {
        try { v.pause(); } catch (_e) { /* ignore */ }
        try { v.muted = true; } catch (_e) { /* ignore */ }
      });
    } catch (_e) { /* ignore */ }
  }

  function unmuteVideos(postEl) {
    // We deliberately don't auto-resume playback. Instagram will
    // re-trigger autoplay when the user scrolls; resuming ourselves can
    // un-mute videos the user didn't explicitly unmute.
    void postEl;
  }

  // ---------------------------------------------------------------------
  // topic extraction (delegated to host)
  // ---------------------------------------------------------------------

  function extractTopicsSafe(postEl) {
    if (!host || typeof host.topicsExtractor !== 'function') return [];
    try { return host.topicsExtractor(postEl) || []; }
    catch (e) { console.warn('[IntentGuard] topicsExtractor failed', e); return []; }
  }

  // ---------------------------------------------------------------------
  // training writes — chip clicks land here from trainer.js
  // ---------------------------------------------------------------------

  async function applyTopicAction(term, kind, action) {
    const lower = String(term || '').toLowerCase();
    if (!lower) return;
    const settings = await IG.store.getSettings();
    const isHashtag = kind === 'hashtag';
    const isAccount = kind === 'account';
    ['chill', 'insight'].forEach((modeName) => {
      const m = settings.modes && settings.modes[modeName];
      if (!m) return;
      const allowKey = isAccount ? 'allowAccounts' : (isHashtag ? 'allowHashtags' : 'allowKeywords');
      const blockKey = isAccount ? 'blockAccounts' : (isHashtag ? 'blockHashtags' : 'blockKeywords');
      const allow = new Set((m[allowKey] || []).map((s) => String(s).toLowerCase()));
      const block = new Set((m[blockKey] || []).map((s) => String(s).toLowerCase()));
      if (action === 'allow') {
        allow.add(lower); block.delete(lower);
      } else if (action === 'block') {
        block.add(lower); allow.delete(lower);
      } else if (action === 'unblock') {
        block.delete(lower);
      } else if (action === 'unallow') {
        allow.delete(lower);
      }
      m[allowKey] = Array.from(allow);
      m[blockKey] = Array.from(block);
    });
    await IG.store.saveSettings(settings);
    // storage.onChanged in content.js calls modeFilter.refresh(),
    // which re-classifies + recolors chips on the trainer panel.
  }

  // ---------------------------------------------------------------------
  // IntersectionObserver — feeds the fixed Trainer panel
  // ---------------------------------------------------------------------

  function setupIntersectionObserver() {
    if (intersectObserver) return;
    if (typeof IntersectionObserver !== 'function') return;
    intersectObserver = new IntersectionObserver(handleIntersect, {
      threshold: [0, 0.25, 0.5, 0.75, 1],
    });
  }

  function handleIntersect(entries) {
    entries.forEach((e) => {
      if (e.isIntersecting) tileRatios.set(e.target, e.intersectionRatio);
      else tileRatios.delete(e.target);
    });
    // pick the highest-ratio tile
    let best = null;
    let bestRatio = 0;
    for (const [tile, ratio] of tileRatios) {
      if (!tile.isConnected) { tileRatios.delete(tile); continue; }
      if (ratio > bestRatio) { best = tile; bestRatio = ratio; }
    }
    if (best && best !== mostVisibleTile) {
      mostVisibleTile = best;
      schedulePushActiveTile();
    }
  }

  function schedulePushActiveTile() {
    if (pendingActiveSync) return;
    pendingActiveSync = setTimeout(() => {
      pendingActiveSync = null;
      pushActiveTileToTrainer();
    }, 80);
  }

  async function pushActiveTileToTrainer(maybeSettings) {
    if (!IG.trainer || typeof IG.trainer.setActiveTile !== 'function') return;
    if (!mostVisibleTile || !mostVisibleTile.isConnected) return;
    const v = verdicts.get(mostVisibleTile);
    if (!v) return;
    const settings = maybeSettings || await IG.store.getSettings();
    const author = safeAuthor(mostVisibleTile);
    const meta = author ? `now: @${author}` : 'now viewing';
    IG.trainer.setActiveTile({
      topics: v.topics || [],
      verdict: { show: v.show, matchedTerm: v.matchedTerm },
      meta,
      settings,
    });
  }

  function safeAuthor(el) {
    if (!host || typeof host.authorExtractor !== 'function') return '';
    try { return (host.authorExtractor(el) || '').trim(); }
    catch (_e) { return ''; }
  }

  // ---------------------------------------------------------------------
  // dictionary lookup
  // ---------------------------------------------------------------------

  function activeDictFrom(settings, mode) {
    const m = settings && settings.modes && settings.modes[mode];
    if (!m) return null;
    return Object.assign({}, m, { __modeName: capitalize(mode) });
  }

  function capitalize(s) {
    s = String(s || '');
    return s.length ? s[0].toUpperCase() + s.slice(1) : s;
  }

  function pickHost() {
    const reg = window.IntentGuardHosts || {};
    const hostname = location.hostname;
    for (const k of Object.keys(reg)) {
      try {
        if (reg[k] && reg[k].matches && reg[k].matches(hostname)) {
          return Object.assign({ key: k }, reg[k]);
        }
      } catch (_e) { /* ignore */ }
    }
    return null;
  }
})();
