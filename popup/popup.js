// Popup controller — single screen.
//
// Two text fields drive everything:
//   "Topics to see"  -> insight.allowKeywords + insight.allowHashtags
//   "Topics to skip" -> chill.blockKeywords + chill.blockHashtags AND
//                       insight.blockKeywords + insight.blockHashtags
//                       (block-list always wins, in both modes)
//
// Mode itself is auto-managed by the intention prompt — chill if the user
// picked "Take a break", insight otherwise. The popup just shows which is
// active so the user knows which list is in play.
//
// "Hide promos & sponsored" merges a small fixed seed list into the same
// block lists. We strip those seeds back out when reading the textarea so
// they don't pollute the user's own topics.

(function () {
  'use strict';
  const store = window.IntentGuard.store;

  const allowTa = document.getElementById('t-allow');
  const blockTa = document.getElementById('t-block');
  const promosCb = document.getElementById('t-promos');
  const minutesIn = document.getElementById('t-minutes');
  const statusLine = document.getElementById('status-line');
  const statusMeta = document.getElementById('status-meta');
  const modeChillBtn = document.getElementById('mode-chill');
  const modeInsightBtn = document.getElementById('mode-insight');
  const endBtn = document.getElementById('end-btn');
  const saved = document.getElementById('saved');

  const PROMO_KEYWORDS = ['promo', 'sponsored', 'shop now', 'limited time', 'ad'];
  const PROMO_HASHTAGS = ['shop', 'sale', 'ad', 'sponsored'];
  const PROMO_ALL = new Set([...PROMO_KEYWORDS, ...PROMO_HASHTAGS]);

  function flashSaved() {
    saved.textContent = 'Saved.';
    saved.classList.add('show');
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => saved.classList.remove('show'), 1200);
  }

  function parseTopics(s) {
    return Array.from(new Set(
      String(s || '')
        .split(/[,\n]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    ));
  }

  function joinTopics(arr) {
    return Array.from(new Set((arr || []).map((s) => String(s).toLowerCase()))).join(', ');
  }

  function renderMode(mode) {
    const isChill = mode === 'chill';
    modeChillBtn.setAttribute('aria-selected', isChill ? 'true' : 'false');
    modeInsightBtn.setAttribute('aria-selected', isChill ? 'false' : 'true');
  }

  function renderSession(currentSession, now) {
    if (!currentSession) {
      statusLine.textContent = 'Open Instagram to start a session.';
      statusMeta.textContent = '';
      endBtn.disabled = true;
      return;
    }
    endBtn.disabled = false;
    const minutes = Math.max(0, Math.floor(((now || Date.now()) - currentSession.startedAt) / 60000));
    statusLine.textContent = `${minutes} min on instagram.com`;
    statusMeta.textContent = currentSession.intention ? `intention: ${currentSession.intention}` : 'no intention recorded';
  }

  function setMode(mode) {
    renderMode(mode);
    chrome.runtime.sendMessage({ type: 'mode:set', mode }, () => {
      void chrome.runtime.lastError;
      flashSaved();
    });
  }

  modeChillBtn.addEventListener('click', () => setMode('chill'));
  modeInsightBtn.addEventListener('click', () => setMode('insight'));

  // --- read settings -> form -----------------------------------------------

  function readAllowTopics(settings) {
    const m = settings.modes && settings.modes.insight;
    if (!m) return '';
    const all = Array.from(new Set([
      ...(m.allowKeywords || []).map((s) => String(s).toLowerCase()),
      ...(m.allowHashtags || []).map((s) => String(s).toLowerCase()),
    ]));
    return joinTopics(all);
  }

  function readBlockTopics(settings) {
    // Read from chill (canonical). Strip promo seeds — they're owned by the
    // promo toggle.
    const m = settings.modes && settings.modes.chill;
    if (!m) return '';
    const all = Array.from(new Set([
      ...(m.blockKeywords || []).map((s) => String(s).toLowerCase()),
      ...(m.blockHashtags || []).map((s) => String(s).toLowerCase()),
    ]));
    return joinTopics(all.filter((k) => !PROMO_ALL.has(k)));
  }

  function readPromosFromSettings(settings) {
    const m = settings.modes && settings.modes.chill;
    if (!m) return false;
    const set = new Set((m.blockKeywords || []).map((s) => String(s).toLowerCase()));
    return PROMO_KEYWORDS.every((k) => set.has(k));
  }

  // --- form -> settings ----------------------------------------------------

  function applyAllowTopics(settings, topics) {
    const m = settings.modes.insight;
    m.allowKeywords = topics.slice();
    m.allowHashtags = topics.slice();
  }

  function applyBlockTopicsAndPromos(settings, topics, promosOn) {
    const kwSet = new Set(topics);
    const tagSet = new Set(topics);
    if (promosOn) {
      PROMO_KEYWORDS.forEach((k) => kwSet.add(k));
      PROMO_HASHTAGS.forEach((t) => tagSet.add(t));
    }
    ['chill', 'insight'].forEach((modeName) => {
      const m = settings.modes[modeName];
      if (!m) return;
      m.blockKeywords = Array.from(kwSet);
      m.blockHashtags = Array.from(tagSet);
    });
    // Reaffirm mode shape so requireAllowMatch is consistent.
    if (settings.modes.chill) settings.modes.chill.requireAllowMatch = false;
    if (settings.modes.insight) settings.modes.insight.requireAllowMatch = true;
  }

  async function save() {
    const settings = await store.getSettings();
    const allowTopics = parseTopics(allowTa.value);
    const blockTopics = parseTopics(blockTa.value);
    applyAllowTopics(settings, allowTopics);
    applyBlockTopicsAndPromos(settings, blockTopics, promosCb.checked);
    settings.thresholds = settings.thresholds || {};
    const minutes = Math.max(1, Math.min(240, parseInt(minutesIn.value, 10) || 20));
    settings.thresholds.interruptionMinutes = minutes;
    minutesIn.value = String(minutes);
    await store.saveSettings(settings);
    flashSaved();
  }

  // Save while typing in the textareas, but throttled so we don't write on
  // every keystroke.
  function debouncedSave() {
    clearTimeout(debouncedSave._t);
    debouncedSave._t = setTimeout(save, 350);
  }

  allowTa.addEventListener('input', debouncedSave);
  blockTa.addEventListener('input', debouncedSave);
  promosCb.addEventListener('change', save);
  minutesIn.addEventListener('change', save);

  endBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'session:end-now' }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  });

  async function load() {
    const settings = await store.getSettings();
    const mode = await store.getMode();
    renderMode(mode);
    allowTa.value = readAllowTopics(settings);
    blockTa.value = readBlockTopics(settings);
    promosCb.checked = readPromosFromSettings(settings);
    minutesIn.value = String((settings.thresholds && settings.thresholds.interruptionMinutes) || 20);

    chrome.runtime.sendMessage({ type: 'session:get' }, (resp) => {
      void chrome.runtime.lastError;
      if (!resp) { renderSession(null, Date.now()); return; }
      renderSession(resp.currentSession, resp.now);
    });
  }

  setInterval(load, 5000);
  load();
})();
