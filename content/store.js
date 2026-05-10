// Thin chrome.storage.local adapter shared across content scripts, popup,
// options, and background. Exposes a single `IntentGuard.store` object on
// the global of whichever script context loads it.
//
// Keys we own:
//   settings        — dictionaries + thresholds (see DEFAULT_SETTINGS)
//   currentSession  — { host, startedAt, intention, mode } | null
//   todayLog        — [{ host, startedAt, endedAt, intention, mode,
//                        durationMs, interruptionsShown }]
//   sessionState    — per-tab transient data { tabId: { interruptionsShown } }
//
// Everything is async-safe: callers `await` the read/write helpers.

(function (root) {
  'use strict';

  const DEFAULT_SETTINGS = {
    modes: {
      chill: {
        // Permissive: show everything except matches in the block lists.
        blockKeywords: [],
        blockHashtags: [],
        blockAccounts: [],
        allowKeywords: [],
        allowHashtags: [],
        allowAccounts: [],
        requireAllowMatch: false,
      },
      insight: {
        // Restrictive: hide everything unless it matches an allow rule.
        // When all allow lists are empty we fall back to show-all so a fresh
        // install isn't a blank screen.
        blockKeywords: [],
        blockHashtags: [],
        blockAccounts: [],
        allowKeywords: [],
        allowHashtags: [],
        allowAccounts: [],
        requireAllowMatch: true,
      },
    },
    thresholds: {
      interruptionMinutes: 20,
      breatherSeconds: 60,
      quietHours: { start: null, end: null },
    },
    schemaVersion: 2,
  };

  function todayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  async function get(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (v) => resolve(v || {}));
      } catch (_e) {
        resolve({});
      }
    });
  }

  async function set(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (_e) {
        resolve();
      }
    });
  }

  async function remove(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(keys, () => resolve());
      } catch (_e) {
        resolve();
      }
    });
  }

  async function getSettings() {
    const { settings } = await get('settings');
    if (!settings) {
      await set({ settings: DEFAULT_SETTINGS });
      return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    }
    // shallow merge defaults so new keys appear after upgrades
    return mergeDefaults(settings, DEFAULT_SETTINGS);
  }

  function mergeDefaults(target, defaults) {
    if (target == null || typeof target !== 'object' || Array.isArray(target)) {
      return target == null ? defaults : target;
    }
    const out = Array.isArray(target) ? target.slice() : Object.assign({}, target);
    for (const k of Object.keys(defaults)) {
      if (!(k in out)) out[k] = defaults[k];
      else if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
        out[k] = mergeDefaults(out[k], defaults[k]);
      }
    }
    return out;
  }

  async function saveSettings(settings) {
    await set({ settings });
  }

  async function getCurrentSession() {
    const { currentSession } = await get('currentSession');
    return currentSession || null;
  }

  async function setCurrentSession(session) {
    await set({ currentSession: session });
  }

  async function clearCurrentSession() {
    await set({ currentSession: null });
  }

  async function getTodayLog() {
    const { todayLog, todayLogDate } = await get(['todayLog', 'todayLogDate']);
    const today = todayKey();
    if (todayLogDate !== today) {
      await set({ todayLog: [], todayLogDate: today });
      return [];
    }
    return todayLog || [];
  }

  async function appendTodayLog(entry) {
    const log = await getTodayLog();
    log.push(entry);
    await set({ todayLog: log, todayLogDate: todayKey() });
  }

  async function getMode() {
    const { activeMode } = await get('activeMode');
    return activeMode === 'chill' || activeMode === 'insight' ? activeMode : 'insight';
  }

  async function setMode(mode) {
    if (mode !== 'chill' && mode !== 'insight') return;
    await set({ activeMode: mode });
  }

  // Per-tab intention chosen for the current page load.
  // Keyed by tabId so multiple tabs don't clobber each other.
  async function getIntention(tabId) {
    const { intentions } = await get('intentions');
    if (!intentions || tabId == null) return null;
    return intentions[String(tabId)] || null;
  }

  async function setIntention(tabId, payload) {
    if (tabId == null) return;
    const { intentions } = await get('intentions');
    const next = Object.assign({}, intentions || {});
    next[String(tabId)] = payload;
    await set({ intentions: next });
  }

  async function clearIntention(tabId) {
    if (tabId == null) return;
    const { intentions } = await get('intentions');
    if (!intentions) return;
    const next = Object.assign({}, intentions);
    delete next[String(tabId)];
    await set({ intentions: next });
  }

  const api = {
    DEFAULT_SETTINGS,
    todayKey,
    get,
    set,
    remove,
    getSettings,
    saveSettings,
    getCurrentSession,
    setCurrentSession,
    clearCurrentSession,
    getTodayLog,
    appendTodayLog,
    getMode,
    setMode,
    getIntention,
    setIntention,
    clearIntention,
  };

  root.IntentGuard = root.IntentGuard || {};
  root.IntentGuard.store = api;
})(typeof self !== 'undefined' ? self : globalThis);
