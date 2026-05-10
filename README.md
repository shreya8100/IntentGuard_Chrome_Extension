# IntentGuard (Instagram)

This project has been done by: Moumita Karmakar, Shreya Saha, Jeevesh Krishna Arigala


Mindful middleware for Instagram. Three small interventions in a single
popup, with no separate settings page.

Current build: v0.3.0. The companion design document for COMPSCI 627 lives
in [`overleaf/design_document.tex`](../overleaf/design_document.tex).

## What it does

The extension adds three layers of awareness to an Instagram session.

### Layer 1. Pre-use: intention prompt

When you open instagram.com, a full-page modal asks *"Why are you opening
this?"* You can pick one of four quick choices (*Check a specific update*,
*Take a break / Chill*, *Learn something new*, *Message someone*) or type
your own reason.

The pick decides the active mode for the session:

* *Take a break / Chill* sets **Chill** mode.
* Anything else (including custom reasons) sets **Insight** mode.

A small chip with the chosen reason stays pinned to the top-right while
you scroll. The chip has a `×` button if you want to dismiss it. The
prompt is cached per hostname for 30 minutes so SPA navigation does not
re-fire it on every Instagram page change.

### Layer 2. During use: Topic Trainer + classifier

A fixed **Topic Trainer panel** sits at the bottom-left of the page. As
you scroll, it follows whichever post or reel is most visible (via
`IntersectionObserver`) and shows that tile's detected topics as chips,
each with `+` and `−` buttons.

* `+` adds the topic to your **allow list**.
* `−` adds the topic to your **block list**.

Chips are green if allowed, red if blocked, grey otherwise. The panel
also shows a verdict pill for the current tile, so you always see why
the post is or is not visible. Possible verdicts:

* `showing` (or `showing — allowed: cooking` if a rule matched)
* `blocked: cooking` (the term that triggered the block)
* `off-topic for this mode` (insight mode, no allow rule matched)

The panel is collapsible via the `–` / `+` button on its header, so it
stays out of the way of the reels viewer's right-side controls. It hides
itself entirely until at least one tile has been classified, so you do
not see an empty floating shell on first load.

Blocked posts and reels keep their layout space (no scroll jank). They
are covered by an overlay reading `blocked: cooking` with *Show anyway*
and *Unblock cooking* buttons. Videos in blocked tiles are paused and
muted.

The popup mode toggle decides how the lists are used:

* **Chill**: show everything except posts whose topics are in the block
  list.
* **Insight**: show only posts whose topics are in the allow list. An
  empty allow list falls back to showing everything, so a fresh install
  is not a blank screen.

### Layer 3. Extended use: soft interruption

After your chosen threshold (default 20 minutes), a soft modal asks if
you want to continue, take a 60-second breather, or end the session.
The modal can be dismissed with one click. It is a moment of awareness,
not a wall.

## Privacy

Everything is in `chrome.storage.local`. There is no backend, no
analytics, and no network calls.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and pick this folder (the one with
   `manifest.json`).
3. Pin the IntentGuard icon (indigo pause glyph).

## Demo flow

1. Open `https://www.instagram.com/`. Pick a reason on the intention
   prompt. The mode is set automatically from your pick (Chill if you
   picked *Take a break*, Insight otherwise). The Topic Trainer panel
   appears at the bottom-left.
2. Scroll the feed. As each post centers, the panel updates with that
   tile's chips, e.g. `cooking +/−`, `#italianfood +/−`. The verdict
   pill at the top of the panel reflects the current rule.
3. Click `−` on a chip you do not want. The chip turns red, the current
   tile is covered by the `blocked: cooking` overlay, and any future
   tile mentioning that topic gets the same treatment. Click `+` on
   chips you like and they turn green.
4. Visit `https://www.instagram.com/reels/`. The Trainer panel still
   tracks the visible reel and surfaces its topics. You can train as
   you swipe.
5. Open the popup. Click **Chill** vs **Insight** to switch how your
   lists are used. The feed re-classifies in place. The textareas show
   the cumulative trained lists, which you can edit directly.
6. Set **Interrupt after** to `1 min` and wait. The soft interruption
   modal appears.

## Popup (everything is here)

* **Status**: current session minutes and your declared intention.
* **Mode**: segmented toggle between *Chill* (skip listed topics) and
  *Insight* (only listed topics). Switching takes effect immediately
  via a `chrome.storage.onChanged` listener that re-runs the classifier
  in place.
* **Topics to see**: comma-separated. Insight mode shows only posts
  matching these. Empty means show everything.
* **Topics to skip**: comma-separated. Always hidden in both modes.
  Block list wins over allow list.
* **Hide promos & sponsored**: adds `promo`, `sponsored`, `shop now`,
  `limited time`, `ad` to the skip list.
* **Interrupt after**: minutes before the soft interruption modal fires.
  Default 20.
* **End session now**: closes the active Instagram tab and finalises
  the session log entry.

There is no separate settings page. Everything you can change lives in
this popup.

## How matching works

For each post (article or tile) we collect text from `innerText`,
`<img alt>`, and any `aria-label` we find on the tile. The classifier
checks rules in this order:

1. **Block**: author, hashtag, or keyword in the skip list. The matched
   term flows into the skip card so you see `blocked: cooking` instead
   of just `blocked-keyword`.
2. **Allow**: author, hashtag, or keyword in the allow list.
3. **requireAllowMatch**: only used in Insight mode. If nothing matched
   and the allow list is non-empty, hide the post.
4. **Default**: show.

Block always beats allow. An empty allow list disables the
require-allow gate, so a fresh install is not a blank screen.

### Topic extraction (for the chip strip)

Per tile, we collect candidate topics from the same text we feed the
classifier:

1. **Hashtags first**: every `#word` of length at least 3.
2. **Then keywords**: caption words of length at least 4 that are not in
   a small English stop-word list.

We keep the first 8 unique topics in caption order (most relevant
first). Tiles with no caption (typical of bare reel rail thumbnails)
get no chips, since there is nothing to train on. This is the largest
known gap in the current prototype, and it is the focus of the
"topic guessing for media-only posts" item in the design document.

## Layout

```
intentguard/
├── manifest.json
├── README.md
├── background.js                 service worker: session timer + alarms
├── popup/                        the entire UI: 320px popup
├── content/
│   ├── content.js                orchestrates the layers
│   ├── intention_prompt.js       Layer 1: full-page modal + chip
│   ├── trainer.js                fixed Topic Trainer panel (chips + verdict)
│   ├── mode_filter.js            Layer 2: classifier + in-place overlay skip
│   ├── interruption_modal.js     Layer 3: soft modal + breather
│   ├── store.js                  chrome.storage.local adapter
│   ├── overlay.css               shared modal/panel/overlay styles
│   └── hosts/
│       └── instagram.js          tile enumeration + signal/topic extractors
├── icons/                        16/48/128 indigo pause-glyph PNGs
└── scripts/                      dev-only icon generators
```

## Why this design (anti-jank)

Instagram's feed and `/reels/` viewer use a virtualized scroller. Only a
small window of posts is in the DOM at any time, and they are recycled
as you scroll. Our first prototype injected sibling elements (chip
strips and skip cards) under each post. Instagram's MutationObservers
and resize listeners reacted to those injections and started recycling
content unpredictably. The page jumped around or went blank.

The current design solves this by never inserting siblings into
Instagram's flow:

* The Trainer panel is `position: fixed`, mounted on `document.body`,
  outside the feed.
* When a tile is blocked, we add an overlay inside the tile via
  `position: absolute; inset: 0` and hide its direct children with
  `visibility: hidden`. The tile keeps its layout space, so Instagram
  never sees a height delta.
* `IntersectionObserver` picks the most-visible classified tile and
  feeds the panel. There is no per-tile mounting in the document tree.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Persist toggles and session log. |
| `alarms`  | Fire the interruption check. |
| `tabs`    | Detect the active Instagram tab and close it on End. |
| `host_permissions` for instagram.com | Inject the prompt and filter. |

No `<all_urls>`, no remote scripts, no `eval`, no analytics.

## Re-prompting

The intention prompt is cached per hostname for 30 minutes (see
`recentIntentions` in `chrome.storage.local`). To force a re-prompt
sooner, clear extension storage from `chrome://extensions` →
IntentGuard → *Inspect views* → Application → Extension storage.

## Known limitations

These are tracked in more detail in the design document
(*Iteration → Limitations*).

* **Caption-less reels**. Reels with no caption, hashtags, alt text, or
  `aria-label` give the classifier nothing to read. The trainer falls
  back to "No topics detected" and the post is shown by default.
* **Instagram-only**. X, Reddit, and YouTube hosts are not wired up
  yet. The architecture (a per-host file under `content/hosts/`) is
  ready for them.
* **Keyword-based classifier**. Exact-word matching is simple and easy
  to debug, but it misses posts that are clearly about a topic but use
  different wording.
* **DOM drift**. Instagram occasionally restructures its feed markup,
  which can break the tile enumerator in `hosts/instagram.js`.

## Uninstall

`chrome://extensions` → IntentGuard → **Remove**. All local data is
purged with the extension.
