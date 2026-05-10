// Topic Trainer panel — single fixed-position UI mounted bottom-left.
//
// We previously injected a chip strip as a sibling under every classified
// tile. That tripped Instagram's virtualized scroller and resize observers
// — content disappeared and the page jumped on every mutation. The fix is
// to stop touching Instagram's layout flow at all. Instead, mount one
// panel via `position: fixed`, and have mode_filter feed it the
// most-visible tile via IntersectionObserver. The panel shows that tile's
// topics with the same +/- chips. Chip clicks call back into
// `IG.modeFilter.applyTopicAction` so the write logic isn't duplicated.
//
// The panel is collapsible (header `–`/`+` button) so it doesn't block the
// reels viewer's right-side controls. It hides itself entirely while no
// tile has been classified yet, to avoid an empty floating shell.

(function () {
  'use strict';
  const IG = window.IntentGuard || (window.IntentGuard = {});

  let root = null;
  let chipsEl = null;
  let verdictEl = null;
  let metaEl = null;
  let collapseBtn = null;
  let activeTopics = [];
  let activeVerdict = null;
  let activeMeta = '';
  let collapsed = false;

  function install() {
    if (root && root.isConnected) return;
    build();
    (document.body || document.documentElement).appendChild(root);
  }

  function build() {
    root = document.createElement('div');
    root.className = 'ig-root ig-trainer ig-trainer--empty';

    const header = document.createElement('div');
    header.className = 'ig-trainer__header';

    const title = document.createElement('div');
    title.className = 'ig-trainer__title';
    const dot = document.createElement('span');
    dot.className = 'ig-trainer__brand-dot';
    title.appendChild(dot);
    title.appendChild(document.createTextNode('Topic Trainer'));

    collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'ig-trainer__collapse';
    collapseBtn.title = 'Collapse';
    collapseBtn.textContent = '–';
    collapseBtn.addEventListener('click', toggleCollapse);

    header.appendChild(title);
    header.appendChild(collapseBtn);

    metaEl = document.createElement('div');
    metaEl.className = 'ig-trainer__meta';

    verdictEl = document.createElement('div');
    verdictEl.className = 'ig-trainer__verdict';

    chipsEl = document.createElement('div');
    chipsEl.className = 'ig-trainer__chips';

    root.appendChild(header);
    root.appendChild(metaEl);
    root.appendChild(verdictEl);
    root.appendChild(chipsEl);
  }

  function toggleCollapse() {
    collapsed = !collapsed;
    if (root) root.classList.toggle('ig-trainer--collapsed', collapsed);
    if (collapseBtn) {
      collapseBtn.textContent = collapsed ? '+' : '–';
      collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
    }
  }

  function setActiveTile(payload) {
    if (!root) return;
    if (!payload) return;
    activeTopics = payload.topics || [];
    activeVerdict = payload.verdict || null;
    activeMeta = payload.meta || '';
    root.classList.remove('ig-trainer--empty');
    renderMeta();
    renderVerdict();
    renderChips(payload.settings);
  }

  function renderMeta() {
    if (!metaEl) return;
    metaEl.textContent = activeMeta || 'Now viewing';
  }

  function renderVerdict() {
    if (!verdictEl || !activeVerdict) return;
    let cls = 'ig-trainer__verdict';
    let text = '';
    if (activeVerdict.show) {
      cls += ' ig-trainer__verdict--ok';
      text = activeVerdict.matchedTerm
        ? `showing — allowed: ${activeVerdict.matchedTerm}`
        : 'showing';
    } else {
      cls += ' ig-trainer__verdict--block';
      text = activeVerdict.matchedTerm
        ? `blocked: ${activeVerdict.matchedTerm}`
        : 'off-topic for this mode';
    }
    verdictEl.className = cls;
    verdictEl.textContent = text;
  }

  function renderChips(settings) {
    if (!chipsEl) return;
    chipsEl.innerHTML = '';
    if (!activeTopics.length) {
      const empty = document.createElement('div');
      empty.className = 'ig-trainer__empty-msg';
      empty.textContent = 'No topics detected on this post.';
      chipsEl.appendChild(empty);
      return;
    }
    activeTopics.forEach((t) => chipsEl.appendChild(buildChip(t, settings)));
  }

  function buildChip(t, settings) {
    const chip = document.createElement('span');
    chip.className = 'ig-topic';
    chip.setAttribute('data-term', t.term);
    chip.setAttribute('data-kind', t.kind);
    chip.classList.add('ig-topic--' + getState(t.term, settings));

    const name = document.createElement('span');
    name.className = 'ig-topic__name';
    name.textContent = (t.kind === 'hashtag' ? '#' : '') + t.term;
    chip.appendChild(name);

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'ig-topic__btn ig-topic__btn--allow';
    plus.title = 'Allow this topic';
    plus.textContent = '+';
    plus.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (IG.modeFilter && IG.modeFilter.applyTopicAction) {
        IG.modeFilter.applyTopicAction(t.term, t.kind, 'allow');
      }
    });

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'ig-topic__btn ig-topic__btn--block';
    minus.title = 'Block this topic';
    minus.textContent = '−';
    minus.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (IG.modeFilter && IG.modeFilter.applyTopicAction) {
        IG.modeFilter.applyTopicAction(t.term, t.kind, 'block');
      }
    });

    chip.appendChild(plus);
    chip.appendChild(minus);
    return chip;
  }

  function refresh(settings) {
    // Recolor chips against the new settings without rebuilding them.
    if (!chipsEl) return;
    chipsEl.querySelectorAll('.ig-topic').forEach((chip) => {
      const term = chip.getAttribute('data-term') || '';
      chip.classList.remove('ig-topic--allow', 'ig-topic--block', 'ig-topic--neutral');
      chip.classList.add('ig-topic--' + getState(term, settings));
    });
    // verdict copy doesn't change here — mode_filter calls setActiveTile when
    // a re-classification flips show/matchedTerm.
  }

  function getState(term, settings) {
    const lower = String(term || '').toLowerCase();
    const m = (settings && settings.modes && settings.modes.chill) || {};
    const inAllow =
      (m.allowKeywords || []).some((s) => String(s).toLowerCase() === lower) ||
      (m.allowHashtags || []).some((s) => String(s).toLowerCase() === lower);
    const inBlock =
      (m.blockKeywords || []).some((s) => String(s).toLowerCase() === lower) ||
      (m.blockHashtags || []).some((s) => String(s).toLowerCase() === lower);
    if (inBlock) return 'block';
    if (inAllow) return 'allow';
    return 'neutral';
  }

  IG.trainer = { install, setActiveTile, refresh };
})();
