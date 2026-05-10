// IntentGuard background service worker.
//
// Responsibilities:
//   * Track which tab is currently a "supported host session" — i.e. the
//     active tab is on instagram/x/reddit/youtube.
//   * Maintain { currentSession, todayLog } in chrome.storage.local.
//   * Schedule chrome.alarms to fire the interruption modal after
//     `interruptionMinutes`.
//   * Listen to messages from content scripts and the popup.
//
// MV3 service workers may be torn down between events, so all state lives
// in chrome.storage.local. This file holds zero in-memory state across
// event boundaries (besides the constants below).
//
// Defaults are duplicated here (small surface) so we don't have to import
// content/store.js — service workers can't share script context with the
// document. The options/popup pages also use store.js directly.

const SUPPORTED_HOST_RE = /(^|\.)(instagram|x|twitter|reddit|youtube)\.com$/;
const ALARM_INTERRUPTION = 'interruption-check';

const DEFAULT_THRESHOLDS = {
  interruptionMinutes: 20,
  breatherSeconds: 60,
  quietHours: { start: null, end: null },
};

// ----------------------------------------------------------------------
// storage helpers (mirrors of content/store.js — the SW can't import it)
// ----------------------------------------------------------------------

function get(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, (v) => resolve(v || {})));
}
function set(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
}

function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function getThresholds() {
  const { settings } = await get('settings');
  return Object.assign({}, DEFAULT_THRESHOLDS, (settings && settings.thresholds) || {});
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

// ----------------------------------------------------------------------
// session lifecycle
// ----------------------------------------------------------------------

function isSupportedHostname(hostname) {
  return !!hostname && SUPPORTED_HOST_RE.test(hostname);
}

function hostnameFromUrl(url) {
  try { return new URL(url).hostname; } catch (_e) { return null; }
}

async function startSession({ tabId, host, intention, mode }) {
  const startedAt = Date.now();
  const session = {
    tabId,
    host,
    startedAt,
    intention: intention || null,
    mode: mode || null,
    interruptionsShown: 0,
  };
  await set({ currentSession: session });
  await scheduleInterruptionAlarm();
}

async function endSession(reason = 'unknown') {
  const { currentSession } = await get('currentSession');
  if (!currentSession) return;
  const endedAt = Date.now();
  const entry = {
    host: currentSession.host,
    startedAt: currentSession.startedAt,
    endedAt,
    durationMs: endedAt - currentSession.startedAt,
    intention: currentSession.intention,
    mode: currentSession.mode,
    interruptionsShown: currentSession.interruptionsShown || 0,
    endReason: reason,
  };
  await appendTodayLog(entry);
  await set({ currentSession: null });
  await chrome.alarms.clear(ALARM_INTERRUPTION).catch(() => {});
}

async function scheduleInterruptionAlarm() {
  const { interruptionMinutes } = await getThresholds();
  const minutes = Math.max(0.5, Number(interruptionMinutes) || 20);
  await chrome.alarms.clear(ALARM_INTERRUPTION).catch(() => {});
  await chrome.alarms.create(ALARM_INTERRUPTION, { delayInMinutes: minutes });
}

async function bumpInterruptionCount() {
  const { currentSession } = await get('currentSession');
  if (!currentSession) return;
  currentSession.interruptionsShown = (currentSession.interruptionsShown || 0) + 1;
  await set({ currentSession });
}

// ----------------------------------------------------------------------
// tab tracking
// ----------------------------------------------------------------------

async function syncToActiveTab(tab) {
  if (!tab) return;
  const hostname = hostnameFromUrl(tab.url || tab.pendingUrl || '');
  const { currentSession } = await get('currentSession');

  if (isSupportedHostname(hostname)) {
    if (currentSession && currentSession.tabId === tab.id && currentSession.host === hostname) {
      return; // already tracking this tab/host
    }
    if (currentSession) {
      // tab/host changed — close the old session first
      await endSession('switched-tab');
    }
    // Start a placeholder session; the content script will follow up with
    // its intention/mode via a session:start message.
    await startSession({ tabId: tab.id, host: hostname });
  } else if (currentSession) {
    await endSession('left-supported-host');
  }
}

async function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
  });
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await new Promise((r) => chrome.tabs.get(tabId, (t) => r(t)));
    await syncToActiveTab(tab);
  } catch (_e) { /* tab may be gone */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url || changeInfo.status === 'complete') {
    await syncToActiveTab(tab);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { currentSession } = await get('currentSession');
  if (currentSession && currentSession.tabId === tabId) {
    await endSession('tab-closed');
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // browser lost focus — leave session as-is (we'll just under-count)
    return;
  }
  const tab = await getActiveTab();
  if (tab) await syncToActiveTab(tab);
});

// ----------------------------------------------------------------------
// alarm handler — fires the interruption modal in the active session tab
// ----------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_INTERRUPTION) return;
  const { currentSession } = await get('currentSession');
  if (!currentSession || currentSession.tabId == null) return;
  const { breatherSeconds, interruptionMinutes } = await getThresholds();
  const tabId = currentSession.tabId;
  await bumpInterruptionCount();
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'interruption:show',
      thresholdMinutes: interruptionMinutes,
      breatherSeconds,
    });
  } catch (_e) {
    // content script may not be loaded — just bail; alarm will fire again
    // if the user re-arms.
  }
});

// ----------------------------------------------------------------------
// runtime messages from content scripts and popup
// ----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'session:start': {
          // Content script signals the chosen intention/mode for the live
          // session in the active tab.
          const tabId = sender && sender.tab && sender.tab.id;
          const host = hostnameFromUrl((sender && sender.tab && sender.tab.url) || '') || msg.host;
          if (tabId == null || !isSupportedHostname(host)) {
            sendResponse({ ok: false });
            return;
          }
          const { currentSession } = await get('currentSession');
          if (currentSession && currentSession.tabId === tabId && currentSession.host === host) {
            // patch the existing session
            currentSession.intention = msg.intention || currentSession.intention;
            currentSession.mode = msg.mode || currentSession.mode;
            await set({ currentSession });
          } else {
            await startSession({ tabId, host, intention: msg.intention, mode: msg.mode });
          }
          await scheduleInterruptionAlarm();
          sendResponse({ ok: true });
          return;
        }

        case 'session:continue': {
          // user clicked "Continue" on the interruption modal
          await scheduleInterruptionAlarm();
          sendResponse({ ok: true });
          return;
        }

        case 'session:end-now': {
          // popup or modal asked to end the session and close the tab
          const { currentSession } = await get('currentSession');
          const tabId = (currentSession && currentSession.tabId) || (msg.tabId);
          await endSession('user-ended');
          if (tabId != null) {
            try { await chrome.tabs.remove(tabId); } catch (_e) { /* tab gone */ }
          }
          sendResponse({ ok: true });
          return;
        }

        case 'session:get': {
          const { currentSession } = await get('currentSession');
          const log = await getTodayLog();
          sendResponse({
            currentSession: currentSession || null,
            todayLog: log,
            now: Date.now(),
          });
          return;
        }

        case 'mode:set': {
          if (msg.mode === 'chill' || msg.mode === 'insight') {
            await set({ activeMode: msg.mode });
            const { currentSession } = await get('currentSession');
            if (currentSession) {
              currentSession.mode = msg.mode;
              await set({ currentSession });
            }
          }
          sendResponse({ ok: true });
          return;
        }

        default:
          sendResponse({ ok: false, error: 'unknown-message' });
      }
    } catch (e) {
      console.warn('[IntentGuard bg]', e);
      sendResponse({ ok: false, error: String(e) });
    }
  })();

  return true; // async sendResponse
});

// ----------------------------------------------------------------------
// install / startup — seed defaults
// ----------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await get('settings');
  if (!settings) {
    await set({
      settings: {
        modes: {
          chill: {
            blockKeywords: [],
            blockHashtags: [],
            blockAccounts: [],
            allowKeywords: [],
            allowHashtags: [],
            allowAccounts: [],
            requireAllowMatch: false,
          },
          insight: {
            blockKeywords: [],
            blockHashtags: [],
            blockAccounts: [],
            allowKeywords: [],
            allowHashtags: [],
            allowAccounts: [],
            requireAllowMatch: true,
          },
        },
        thresholds: Object.assign({}, DEFAULT_THRESHOLDS),
        schemaVersion: 2,
      },
    });
  }
  const { activeMode } = await get('activeMode');
  if (!activeMode) await set({ activeMode: 'insight' });
});

// On every SW startup: if a session is dangling from a previous SW
// lifecycle, validate its tab still exists.
chrome.runtime.onStartup.addListener(async () => {
  const { currentSession } = await get('currentSession');
  if (!currentSession) return;
  try {
    await new Promise((r, rj) =>
      chrome.tabs.get(currentSession.tabId, (t) =>
        chrome.runtime.lastError ? rj(chrome.runtime.lastError) : r(t)
      )
    );
  } catch (_e) {
    await endSession('orphaned');
  }
});
