// Layer 1 — Intention prompt.
//
// Mounts a full-page modal asking the user why they are opening the page.
// Resolves with { reason, mode } once the user picks one or types a custom
// reason. Once chosen, persists to chrome.storage.local and renders a small
// persistent chip in the top-right.
//
// Defensive notes:
//   * The overlay is appended to <html> not <body>, because <body> on some
//     SPA hosts (YouTube, Reddit) gets wholesale-replaced after document_start.
//   * If the user has chosen an intention for this tab in the last 30 min we
//     skip the prompt and just re-mount the chip.

(function () {
  'use strict';
  const IG = window.IntentGuard || (window.IntentGuard = {});

  const QUICK_PICKS = [
    { id: 'check', label: 'Check a specific update' },
    { id: 'break', label: 'Take a break / Chill' },
    { id: 'learn', label: 'Learn something new' },
    { id: 'message', label: 'Message someone' },
  ];

  const RECENT_INTENTION_TTL_MS = 30 * 60 * 1000;

  let chipEl = null;
  let overlayEl = null;

  async function run({ host }) {
    const store = IG.store;

    // Skip prompt if a recent intention exists for any tab on this hostname.
    const recent = await getRecentIntentionForHost(location.hostname);
    if (recent) {
      mountChip(recent.reason);
      return recent;
    }

    const choice = await showOverlay();
    const payload = {
      reason: choice.reason,
      mode: choice.mode,
      hostname: location.hostname,
      hostKey: host && host.key,
      chosenAt: Date.now(),
    };
    await persistIntention(payload);
    mountChip(payload.reason);
    return payload;
  }

  async function getRecentIntentionForHost(hostname) {
    try {
      const { recentIntentions } = await IG.store.get('recentIntentions');
      if (!recentIntentions || !recentIntentions[hostname]) return null;
      const entry = recentIntentions[hostname];
      if (!entry || !entry.chosenAt) return null;
      if (Date.now() - entry.chosenAt > RECENT_INTENTION_TTL_MS) return null;
      return entry;
    } catch (_e) {
      return null;
    }
  }

  async function persistIntention(payload) {
    const { recentIntentions } = await IG.store.get('recentIntentions');
    const next = Object.assign({}, recentIntentions || {});
    next[payload.hostname] = payload;
    await IG.store.set({ recentIntentions: next });
  }

  function showOverlay() {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'ig-root';
      root.setAttribute('data-ig', 'intention');

      const overlay = document.createElement('div');
      overlay.className = 'ig-overlay';

      const card = document.createElement('div');
      card.className = 'ig-card';

      const brand = document.createElement('div');
      brand.className = 'ig-card__brand';
      const logo = document.createElement('span');
      logo.className = 'ig-logo';
      brand.appendChild(logo);
      brand.appendChild(document.createTextNode('IntentGuard'));

      const title = document.createElement('div');
      title.className = 'ig-card__title';
      title.textContent = 'Why are you opening this?';

      const sub = document.createElement('div');
      sub.className = 'ig-card__sub';
      sub.textContent = 'Pick a reason — it sets your mode for this session.';

      const pickRow = document.createElement('div');
      pickRow.className = 'ig-pickrow';
      QUICK_PICKS.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ig-pick';
        btn.textContent = p.label;
        btn.addEventListener('click', () => finish({ reason: p.label, pickId: p.id }));
        pickRow.appendChild(btn);
      });

      const textRow = document.createElement('div');
      textRow.className = 'ig-textrow';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'ig-textinput';
      input.placeholder = 'or type your own reason…';
      input.maxLength = 140;
      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'ig-btn';
      goBtn.textContent = 'Continue';
      goBtn.addEventListener('click', () => {
        const v = (input.value || '').trim();
        if (v) finish({ reason: v, pickId: 'custom' });
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') goBtn.click();
      });
      textRow.appendChild(input);
      textRow.appendChild(goBtn);

      card.appendChild(brand);
      card.appendChild(title);
      card.appendChild(sub);
      card.appendChild(pickRow);
      card.appendChild(textRow);
      overlay.appendChild(card);
      root.appendChild(overlay);

      // Append to <html> rather than <body> for SPA-resilience.
      (document.documentElement || document.body).appendChild(root);
      overlayEl = root;

      // give focus to the first quick-pick after mount
      const firstPick = pickRow.querySelector('.ig-pick');
      if (firstPick) firstPick.focus();

      function finish(choice) {
        const mode = inferMode(choice);
        try { root.remove(); } catch (_e) { /* ignore */ }
        overlayEl = null;
        resolve({ reason: choice.reason, mode });
      }
    });
  }

  function inferMode(choice) {
    if (choice.pickId === 'break') return 'chill';
    return 'insight';
  }

  function mountChip(reason) {
    removeChip();
    const chip = document.createElement('div');
    chip.className = 'ig-root';
    chip.setAttribute('data-ig', 'chip');
    const inner = document.createElement('div');
    inner.className = 'ig-chip';
    const dot = document.createElement('span');
    dot.className = 'ig-chip__dot';
    const label = document.createElement('span');
    label.textContent = truncate(reason, 40);
    label.title = reason;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ig-chip__close';
    close.setAttribute('aria-label', 'Dismiss intention chip');
    close.textContent = '×';
    close.addEventListener('click', removeChip);
    inner.appendChild(dot);
    inner.appendChild(label);
    inner.appendChild(close);
    chip.appendChild(inner);
    (document.documentElement || document.body).appendChild(chip);
    chipEl = chip;
  }

  function removeChip() {
    if (chipEl) {
      try { chipEl.remove(); } catch (_e) { /* ignore */ }
      chipEl = null;
    }
  }

  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  IG.intentionPrompt = { run, mountChip, removeChip };
})();
