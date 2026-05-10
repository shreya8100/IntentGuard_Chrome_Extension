// IntentGuard content script entry point.
//
// Loaded at document_start on every supported host. Other content scripts
// register themselves on `window.IntentGuard.*` (intentionPrompt, modeFilter,
// interruptionModal) and hosts on `window.IntentGuardHosts`. This file
// sequences them and routes runtime messages from the popup and background.
//
// Layer 1 (intention prompt) blocks layer 2 (mode filter) until the user
// chooses an intention; layer 3 (interruption modal) is fired on demand by
// background.js via chrome.runtime messages.

(function () {
  'use strict';

  if (window.__intentGuardBooted) return;
  window.__intentGuardBooted = true;

  const IG = window.IntentGuard || (window.IntentGuard = {});
  const store = IG.store;

  function pickHost() {
    const hosts = window.IntentGuardHosts || {};
    const hostname = location.hostname;
    for (const key of Object.keys(hosts)) {
      try {
        if (hosts[key] && typeof hosts[key].matches === 'function' && hosts[key].matches(hostname)) {
          return Object.assign({ key }, hosts[key]);
        }
      } catch (_e) {
        // host config errored; skip and continue
      }
    }
    return null;
  }

  function inferModeFromIntention(reason) {
    if (!reason) return 'insight';
    if (/break|chill|relax|unwind/i.test(reason)) return 'chill';
    return 'insight';
  }

  async function notifyBackground(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
          // swallow lastError; background may be cold-starting
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  async function bootstrap() {
    const host = pickHost();
    if (!host) {
      console.info('[IntentGuard] no host config matched', location.hostname);
      return;
    }

    // Wait for DOM body so we can mount overlays.
    await waitForBody();

    // Step 1 — intention prompt. Resolves with { reason, mode } once chosen.
    let intention = null;
    try {
      intention = await IG.intentionPrompt.run({ host });
    } catch (e) {
      console.warn('[IntentGuard] intention prompt failed:', e);
    }

    if (intention) {
      const mode = inferModeFromIntention(intention.reason);
      await store.setMode(mode);
      // tell background to start a session timer for this tab
      await notifyBackground('session:start', {
        host: location.hostname,
        intention: intention.reason,
        mode,
      });
    }

    // Step 2 — mode filter starts watching the feed regardless. If no
    // intention was picked, it just uses the existing mode.
    try {
      IG.modeFilter.start({ host });
    } catch (e) {
      console.warn('[IntentGuard] mode filter failed to start:', e);
    }

    // Step 2b — fixed Topic Trainer panel. The panel is the user-facing
    // surface for the chip strip; mode_filter feeds it the most-visible
    // tile via IntersectionObserver. Mount it once per page.
    try {
      if (IG.trainer && typeof IG.trainer.install === 'function') IG.trainer.install();
    } catch (e) {
      console.warn('[IntentGuard] trainer failed to install:', e);
    }

    // Step 3 — interruption modal mounts a listener; background triggers it.
    try {
      IG.interruptionModal.install();
    } catch (e) {
      console.warn('[IntentGuard] interruption modal failed to install:', e);
    }
  }

  function waitForBody() {
    if (document.body) return Promise.resolve();
    return new Promise((resolve) => {
      const obs = new MutationObserver(() => {
        if (document.body) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      // safety timeout
      setTimeout(() => {
        obs.disconnect();
        resolve();
      }, 5000);
    });
  }

  // Listen for storage changes (e.g. mode toggled from the popup)
  // and re-run the filter so the change is visible immediately.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.activeMode || changes.settings) {
        if (IG.modeFilter && typeof IG.modeFilter.refresh === 'function') {
          IG.modeFilter.refresh();
        }
      }
    });
  } catch (_e) {
    // ignore — content script lifecycle weirdness
  }

  // Background → content message router
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.type) return false;
      if (msg.type === 'interruption:show') {
        if (IG.interruptionModal && typeof IG.interruptionModal.show === 'function') {
          IG.interruptionModal.show(msg);
        }
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  } catch (_e) {
    /* ignore */
  }

  bootstrap();
})();
