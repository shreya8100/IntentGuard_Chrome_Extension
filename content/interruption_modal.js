// Layer 3 — Interruption modal.
//
// Mounted by content.js but only shown on demand via a runtime message
// from background.js (alarm fired). Three actions:
//   * Continue          — dismiss; background re-arms the alarm.
//   * 60-sec breather   — calm countdown overlay, then dismiss.
//   * End session       — closes the active tab via background.

(function () {
  'use strict';
  const IG = window.IntentGuard || (window.IntentGuard = {});

  let activeOverlay = null;
  let installed = false;

  function install() {
    if (installed) return;
    installed = true;
    // Nothing to do at install time — content.js routes the show message.
  }

  function show({ thresholdMinutes = 20, breatherSeconds = 60 } = {}) {
    if (activeOverlay) return; // already shown

    const root = document.createElement('div');
    root.className = 'ig-root';
    root.setAttribute('data-ig', 'interruption');

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
    title.textContent = `You've been scrolling for ${thresholdMinutes} minutes — continue?`;

    const sub = document.createElement('div');
    sub.className = 'ig-card__sub';
    sub.textContent = 'Take a breath. Decide intentionally.';

    const actions = document.createElement('div');
    actions.className = 'ig-actions';

    const contBtn = document.createElement('button');
    contBtn.type = 'button';
    contBtn.className = 'ig-btn';
    contBtn.textContent = 'Continue';
    contBtn.addEventListener('click', () => {
      sendBg({ type: 'session:continue' });
      dismiss();
    });

    const breatherBtn = document.createElement('button');
    breatherBtn.type = 'button';
    breatherBtn.className = 'ig-btn ig-btn--cyan';
    breatherBtn.textContent = `Take a ${breatherSeconds}s breather`;
    breatherBtn.addEventListener('click', () => {
      dismiss();
      runBreather(breatherSeconds);
    });

    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.className = 'ig-btn ig-btn--amber';
    endBtn.textContent = 'End session';
    endBtn.addEventListener('click', () => {
      sendBg({ type: 'session:end-now' });
      dismiss();
    });

    actions.appendChild(contBtn);
    actions.appendChild(breatherBtn);
    actions.appendChild(endBtn);

    card.appendChild(brand);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(actions);
    overlay.appendChild(card);
    root.appendChild(overlay);

    (document.documentElement || document.body).appendChild(root);
    activeOverlay = root;
    contBtn.focus();
  }

  function dismiss() {
    if (!activeOverlay) return;
    try { activeOverlay.remove(); } catch (_e) { /* ignore */ }
    activeOverlay = null;
  }

  function runBreather(seconds) {
    seconds = Math.max(5, Number(seconds) || 60);

    const root = document.createElement('div');
    root.className = 'ig-root';
    root.setAttribute('data-ig', 'breather');
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
    title.textContent = 'Breathe.';

    const sub = document.createElement('div');
    sub.className = 'ig-card__sub';
    sub.textContent = 'In for four — out for six.';

    const breather = document.createElement('div');
    breather.className = 'ig-breather';

    const dial = document.createElement('div');
    dial.className = 'ig-breather__dial';
    dial.style.background =
      'radial-gradient(circle, #ffffff 60%, transparent 61%), conic-gradient(#4F46E5 0%, #E2E8F0 0)';
    dial.textContent = String(seconds);

    const hint = document.createElement('div');
    hint.className = 'ig-breather__hint';
    hint.textContent = 'Click to skip';

    breather.appendChild(dial);
    breather.appendChild(hint);

    card.appendChild(brand);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(breather);
    overlay.appendChild(card);
    root.appendChild(overlay);
    (document.documentElement || document.body).appendChild(root);

    let remaining = seconds;
    const total = seconds;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) {
        cleanup();
        sendBg({ type: 'session:continue' });
        return;
      }
      const elapsed = total - remaining;
      const pct = Math.round((elapsed / total) * 100);
      dial.style.background = `radial-gradient(circle, #ffffff 60%, transparent 61%), conic-gradient(#4F46E5 ${pct}%, #E2E8F0 0)`;
      dial.textContent = String(remaining);
    };
    const interval = setInterval(tick, 1000);

    const cleanup = () => {
      clearInterval(interval);
      try { root.remove(); } catch (_e) { /* ignore */ }
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target === card || e.target === hint) {
        cleanup();
        sendBg({ type: 'session:continue' });
      }
    });
  }

  function sendBg(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_e) { /* ignore */ }
  }

  IG.interruptionModal = { install, show, dismiss };
})();
