"use strict";

// Terminal Workbench Pet — a small floating ghost companion for Obsidian.
// Ported from the pet on the Terminal Workbench notes site (site-assets/pet.js).
// Plain JavaScript, no build step: Obsidian loads this main.js directly.

const obsidian = require("obsidian");

const MODES = ["off", "cursor", "float"];
const COLORS = ["Green", "Cyan", "Amber", "Violet", "Orange", "Red"];
const DEFAULT_SETTINGS = {
  mode: "float",
  size: 28,        // px, 16–48
  opacity: 70,     // percent, 20–100
  color: 0,        // starting palette index, 0–5
  quips: true,     // occasional speech bubbles
  reactions: true, // react to your writing
  napping: true,   // doze off when idle
  spookiness: true,// flee from the cursor
  readAlong: true, // follow along paragraphs
  tricks: true,    // bored spins / barrel rolls
};

const PET_SVG =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">' +
  '<path class="pet-body" d="M2 16 V7 Q2 1 8 1 Q14 1 14 7 V16 ' +
  'L12 14.4 L10 16 L8 14.4 L6 16 L4 14.4 Z"/>' +
  '<g class="pet-eyes-open"><rect x="5" y="6" width="2" height="3"/>' +
  '<rect x="9" y="6" width="2" height="3"/></g>' +
  '<g class="pet-eyes-closed"><rect x="5" y="8" width="2" height="1"/>' +
  '<rect x="9" y="8" width="2" height="1"/></g>' +
  '<g class="pet-eyes-happy"><path d="M4.6 8 L6 6.6 L7.4 8"/>' +
  '<path d="M8.6 8 L10 6.6 L11.4 8"/></g>' +
  "</svg>";

// Terminal-flavored things the ghost says, grouped by what it's doing.
const QUIPS = {
  idle:   ["> idle", "$ _", "hi", "just vibing", "boop me?", "^_^", "> uptime"],
  peek:   ["whatcha writing?", "ooh", "> peek", "nice note"],
  read:   ["reading...", "go on", "> tail -f", "good line"],
  nap:    ["zzz", "> sleep 60", "afk", "5 more min"],
  boop:   ["boop!", "yay", "<3", "again!", ":D"],
  good:   ["nice!", "keep going", "wordcount++", "> git commit"],
  streak: ["on a roll!", "typing fast!", "flow state", "brrrrt"],
  spook:  ["!", "eek", "> ^C", "yikes"],
  fling:  ["wheee", "whoa", "> yeet"],
};

function parseSvg(str) {
  const doc = new DOMParser().parseFromString(str, "image/svg+xml");
  return doc.documentElement;
}

// The ghost's behavior engine. Returns a small handle the plugin drives.
// `getSettings` reads the live settings object; the engine owns all listeners
// and the animation frame, and tears them down on destroy(). `hooks.onColorChange`
// (optional) is called when a boop changes the color, so the host can persist it.
function createPetEngine(pet, getSettings, hooks) {
  hooks = hooks || {};
  function S() { return getSettings() || {}; }
  function getMode() {
    const m = S().mode;
    return m === "off" || m === "cursor" ? m : "float";
  }

  const tilt = pet.querySelector(".pet-tilt");
  const sprite = pet.querySelector(".pet-sprite");
  const reduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const MARGIN = 8, TOP_CLAMP = 80;
  const TRAIL = 44;
  const EASE = 0.06;
  const NAP_AFTER = 60000;
  const BORED_AFTER = 22000;
  const SPOOK_DIST = 50;
  const SPOOK_COOLDOWN = 2600;

  const SIZE_MIN = 16, SIZE_MAX = 64, SIZE_DEFAULT = 28;
  function readSize() {
    const s = S().size;
    const n = typeof s === "number" ? s : SIZE_DEFAULT;
    return Math.max(SIZE_MIN, Math.min(SIZE_MAX, n));
  }
  let SIZE = readSize();

  let x = window.innerWidth - SIZE - 16;
  let y = window.innerHeight - SIZE - 16;
  let mx = null, my = null;
  let lean = 0;
  let raf = null;
  let dead = false;

  let lastMove = Date.now();
  let lastZ = 0;
  let napping = false;
  let petting = false;

  let roamPhase = "drift";
  let phaseUntil = 0;
  let tgt = { x: x, y: y };
  let tgtEase = 0.02;
  let bobT = Math.random() * 6.28;
  let lastActive = Date.now();
  let lastStartle = Date.now();
  let lastRead = 0;
  let readEl = null;
  let spinning = false;
  let holdUntil = 0;
  const DRIFT_EASE = 0.013, PEEK_EASE = 0.09, READ_EASE = 0.08, SPOOK_EASE = 0.22;
  const VANISH_EASE = 0.06, ARRIVE_EASE = 0.05;

  const COLOR_COUNT = 6;
  let petColor = 0;
  (function initColor() {
    const c = S().color;
    if (typeof c === "number" && c >= 0 && c < COLOR_COUNT) petColor = c | 0;
  })();

  // speech + reaction bookkeeping
  let lastQuip = 0;
  const QUIP_GAP = 12000;
  let keyStreak = 0, lastKeyT = 0, lastCheerT = 0, lastStreakT = 0;

  // drag + fling state
  let drag = null;
  let flingVX = 0, flingVY = 0;

  // listener bookkeeping for clean teardown
  const handlers = [];
  let blinkTimer = null;
  function on(target, type, fn, opt) {
    target.addEventListener(type, fn, opt);
    handlers.push([target, type, fn, opt]);
  }

  function petOn() { return getMode() !== "off"; }
  function petMode() {
    const m = getMode();
    return m === "off" ? "off" : (m === "float" ? "float" : "cursor");
  }

  // The reading content of the active note (reading or editing view).
  function noteEl() {
    return (
      document.querySelector(".workspace-leaf.mod-active .markdown-preview-view") ||
      document.querySelector(".workspace-leaf.mod-active .markdown-source-view .cm-content") ||
      document.querySelector(".workspace-leaf.mod-active .view-content") ||
      document.querySelector(".markdown-preview-view")
    );
  }

  function applyPetColor() {
    if (petColor) pet.setAttribute("data-color", petColor);
    else pet.removeAttribute("data-color");
  }
  function setPetColor(c) {
    if (typeof c === "number" && c >= 0 && c < COLOR_COUNT) { petColor = c | 0; applyPetColor(); }
  }
  function cyclePetColor() {
    petColor = (petColor + 1) % COLOR_COUNT;
    applyPetColor();
    if (hooks.onColorChange) hooks.onColorChange(petColor);
  }

  function applySize() {
    SIZE = readSize();
    pet.style.setProperty("--pet-size", SIZE + "px");
    clampCore();
    apply();
  }
  function applyOpacity() {
    let o = S().opacity;
    if (typeof o !== "number") o = 70;
    o = Math.max(15, Math.min(100, o));
    pet.style.setProperty("--pet-base-opacity", (o / 100).toFixed(3));
  }

  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  // Show a small speech bubble. Rate-limited unless `force` (boops, flings).
  function say(text, kind, force) {
    if (!S().quips) return;
    if (reduced && !force) return;
    const now = Date.now();
    if (!force && now - lastQuip < QUIP_GAP) return;
    lastQuip = now;
    const old = pet.querySelector(".pet-bubble");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    const b = document.createElement("div");
    b.className = "pet-bubble" + (kind ? " pet-bubble-" + kind : "");
    b.textContent = text;
    pet.appendChild(b);
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 2600);
  }

  function maxX() { return window.innerWidth - SIZE - MARGIN; }
  function maxY() { return window.innerHeight - SIZE - MARGIN; }
  function clampX(v) { return Math.max(MARGIN, Math.min(maxX(), v)); }
  function clampY(v) { return Math.max(TOP_CLAMP, Math.min(maxY(), v)); }
  function dist(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function clampCore() {
    if (x < MARGIN) x = MARGIN;
    if (y < TOP_CLAMP) y = TOP_CLAMP;
    if (x > maxX()) x = maxX();
    if (y > maxY()) y = maxY();
  }
  function renderAt(px, py) {
    pet.style.transform = "translate(" + px.toFixed(1) + "px," + py.toFixed(1) + "px)";
    tilt.style.transform = "rotate(" + lean.toFixed(1) + "deg)";
  }
  function apply() { renderAt(x, y); }
  function ease() {
    const vx = (tgt.x - x) * tgtEase, vy = (tgt.y - y) * tgtEase;
    x += vx; y += vy;
    lean += (vx * 1.5 - lean) * 0.12;
    if (lean > 12) lean = 12;
    if (lean < -12) lean = -12;
  }

  function spawnParticle(ch, cls) {
    const s = document.createElement("span");
    s.className = "pet-particle " + cls;
    s.textContent = ch;
    pet.appendChild(s);
    setTimeout(function () {
      if (s.parentNode) s.parentNode.removeChild(s);
    }, 1400);
  }
  function setBoopable(o) { sprite.style.pointerEvents = o ? "auto" : "none"; }

  function setNap(o) {
    if (napping === o) return;
    napping = o;
    pet.className = o ? "pet-nap" : "";
  }

  function scheduleBlink() {
    blinkTimer = setTimeout(function () {
      if (dead) return;
      if (!napping && !petting && !spinning && roamPhase !== "nap") {
        sprite.className = "pet-sprite pet-blink";
        setTimeout(function () {
          if (!petting && !spinning) sprite.className = "pet-sprite";
        }, 160);
      }
      scheduleBlink();
    }, 4000 + Math.random() * 3000);
  }

  function markActivity() {
    lastActive = Date.now();
    if (petMode() === "float" && roamPhase === "nap") wakeFromNap();
  }
  on(document, "mousemove", function (e) {
    mx = e.clientX; my = e.clientY;
    lastMove = Date.now();
    markActivity();
    if (napping) setNap(false);
    if (petMode() === "float") maybeSpook();
    schedule();
  });
  on(document, "scroll", function () {
    markActivity();
    if (petMode() === "float") maybeRead();
    schedule();
  }, true);
  on(document, "keydown", onKey);
  on(document, "click", markActivity, true);
  on(document, "touchstart", markActivity, true);

  // React to writing: a cheer on paragraph breaks and on typing streaks.
  function onKey(e) {
    markActivity();
    if (reduced) return;
    const s = S();
    if (!s.reactions || petMode() !== "float") return;
    const now = Date.now();
    if (now - lastKeyT > 4000) keyStreak = 0;
    lastKeyT = now;
    if (e.key && e.key.length === 1) keyStreak++;
    if (e.key === "Enter" && now - lastCheerT > 7000 && Math.random() < 0.6) {
      lastCheerT = now;
      cheer(pick(QUIPS.good));
    } else if (keyStreak >= 34 && now - lastStreakT > 22000) {
      lastStreakT = now;
      keyStreak = 0;
      cheer(pick(QUIPS.streak));
    }
  }
  function cheer(text) {
    if (dead || petting || spinning || roamPhase === "spook") return;
    sprite.className = "pet-sprite pet-happy";
    setTimeout(function () {
      if (!petting && !spinning) sprite.className = "pet-sprite";
    }, 500);
    if (text) say(text, "good", true);
  }

  // --- boop / drag / fling ------------------------------------------------
  function boop() {
    markActivity();
    cyclePetColor();
    if (petting) return;
    petting = true;
    setNap(false);
    sprite.className = "pet-sprite pet-happy";
    if (Math.random() < 0.5) spawnParticle("♥", "pet-heart");
    else spawnParticle("!", "pet-bang");
    say(pick(QUIPS.boop), "boop", true);
    if (petMode() === "float") { wakeFromNap(); zipAway(false); }
    setTimeout(function () {
      if (!spinning) sprite.className = "pet-sprite";
      petting = false;
    }, 1100);
  }

  function beginDrag() {
    clearPeek();
    pet.style.opacity = "";
    pet.className = "";
    napping = false;
    readEl = null;
    roamPhase = "drag";
    sprite.style.cursor = "grabbing";
    setBoopable(true);
  }
  function endDrag(vx, vy) {
    sprite.style.cursor = "";
    markActivity();
    if (petMode() === "float" && !reduced) {
      flingVX = Math.max(-42, Math.min(42, vx));
      flingVY = Math.max(-42, Math.min(42, vy));
      if (Math.abs(flingVX) + Math.abs(flingVY) > 6) say(pick(QUIPS.fling), "good", true);
      roamPhase = "fling";
    } else if (petMode() === "float") {
      enterDrift(Date.now());
    } else {
      lastMove = Date.now(); // cursor mode: trailing simply resumes
    }
    schedule();
  }
  function flingStep(now) {
    x += flingVX; y += flingVY;
    flingVX *= 0.90; flingVY *= 0.90;
    if (x < MARGIN) { x = MARGIN; flingVX = -flingVX * 0.5; }
    if (x > maxX()) { x = maxX(); flingVX = -flingVX * 0.5; }
    if (y < TOP_CLAMP) { y = TOP_CLAMP; flingVY = -flingVY * 0.5; }
    if (y > maxY()) { y = maxY(); flingVY = -flingVY * 0.5; }
    lean += (flingVX * 1.2 - lean) * 0.2;
    if (lean > 16) lean = 16;
    if (lean < -16) lean = -16;
    renderAt(x, y);
    if (Math.abs(flingVX) + Math.abs(flingVY) < 1.2) { lean = 0; enterDrift(now); }
  }

  on(sprite, "pointerdown", function (e) {
    if (e.button != null && e.button !== 0) return;
    markActivity();
    drag = {
      sx: e.clientX, sy: e.clientY, moved: false,
      gx: e.clientX - x, gy: e.clientY - y,
      lx: e.clientX, ly: e.clientY,
      lt: (window.performance ? performance.now() : Date.now()),
      vx: 0, vy: 0,
    };
    try { sprite.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
  });
  on(window, "pointermove", function (e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && (dx * dx + dy * dy) > 25) { drag.moved = true; beginDrag(); }
    if (!drag.moved) return;
    x = clampX(e.clientX - drag.gx);
    y = clampY(e.clientY - drag.gy);
    const t = (window.performance ? performance.now() : Date.now());
    const dt = Math.max(1, t - drag.lt);
    drag.vx = (e.clientX - drag.lx) / dt * 16;
    drag.vy = (e.clientY - drag.ly) / dt * 16;
    drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = t;
    lean = Math.max(-16, Math.min(16, drag.vx * 0.5));
    renderAt(x, y);
    schedule();
  });
  function endPointer(e) {
    if (!drag) return;
    const moved = drag.moved, vx = drag.vx, vy = drag.vy;
    try { sprite.releasePointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
    drag = null;
    if (moved) endDrag(vx, vy);
    else boop();
  }
  on(window, "pointerup", endPointer);
  on(window, "pointercancel", endPointer);

  function opposite() {
    const cx = x + SIZE / 2;
    const farX = cx < window.innerWidth / 2
      ? maxX() - Math.random() * 90
      : MARGIN + Math.random() * 90;
    tgt = { x: clampX(farX), y: clampY(TOP_CLAMP + Math.random() * (maxY() - TOP_CLAMP)) };
  }
  function zipAway(scared) {
    clearPeek();
    pet.style.opacity = "";
    opposite();
    tgtEase = SPOOK_EASE;
    roamPhase = "spook";
    phaseUntil = Date.now() + 750;
    lastStartle = Date.now();
    readEl = null;
    setBoopable(false);
    if (scared) {
      sprite.className = "pet-sprite pet-spook";
      pet.className = "pet-startled";
      say(pick(QUIPS.spook), "boop");
    }
  }
  function maybeSpook() {
    if (reduced || mx === null || !S().spookiness) return;
    if (roamPhase === "spook" || roamPhase === "nap" || roamPhase === "drag" || roamPhase === "fling") return;
    if (Date.now() - lastStartle < SPOOK_COOLDOWN) return;
    if (dist(x + SIZE / 2, y + SIZE / 2, mx, my) <= SPOOK_DIST) zipAway(true);
  }
  function spookStep(now) {
    ease();
    renderAt(x, y);
    if ((now > phaseUntil && dist(x, y, tgt.x, tgt.y) < 8) || now > phaseUntil + 1200)
      endSpook(now);
  }
  function endSpook(now) {
    sprite.className = petting ? "pet-sprite pet-happy" : "pet-sprite";
    pet.className = "";
    enterDrift(now);
  }

  let peekEdge = 0, peekHome = null, peekAmt = 1, peekGoal = 0, peekFlipAt = 0, peekSpoke = false;
  function clearPeek() {
    sprite.style.clipPath = "";
    sprite.style.webkitClipPath = "";
    sprite.classList.remove("pet-sneak");
    peekHome = null;
  }
  function peekCandidates() {
    const note = noteEl();
    if (!note) return [];
    const els = note.querySelectorAll("h1,h2,h3,h4,pre,blockquote,table,img");
    const out = [];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.width > SIZE && r.height > SIZE &&
          r.bottom > TOP_CLAMP + SIZE && r.top < window.innerHeight - SIZE) {
        out.push(els[i]);
      }
    }
    return out;
  }
  function enterPeek(now) {
    const pool = peekCandidates();
    if (!pool.length) { enterDrift(now); return; }
    const r = pool[Math.floor(Math.random() * pool.length)].getBoundingClientRect();
    const edge = Math.floor(Math.random() * 3);
    let clip;
    if (edge === 0) {
      tgt = { x: clampX(r.left + Math.random() * Math.max(1, r.width - SIZE)),
              y: clampY(r.top - SIZE / 2) };
      clip = "inset(0 0 46% 0)";
    } else if (edge === 1) {
      tgt = { x: clampX(r.left - SIZE / 2),
              y: clampY(r.top + Math.random() * Math.max(1, r.height - SIZE)) };
      clip = "inset(0 50% 0 0)";
    } else {
      tgt = { x: clampX(r.right - SIZE / 2),
              y: clampY(r.top + Math.random() * Math.max(1, r.height - SIZE)) };
      clip = "inset(0 0 0 50%)";
    }
    tgtEase = PEEK_EASE;
    roamPhase = "peek";
    peekEdge = edge;
    peekHome = null;
    peekAmt = 1; peekGoal = 0; peekFlipAt = 0; peekSpoke = false;
    phaseUntil = now + 5200 + Math.random() * 3200;
    sprite.style.clipPath = clip;
    sprite.style.webkitClipPath = clip;
    setBoopable(true);
  }
  // Hiding is played sneaky: on arrival the wander stops and the bob pauses,
  // the ghost tucks almost fully behind the edge and holds its breath, then
  // slowly peeps out -- ducking straight back down if the pointer comes near.
  function peekStep(now) {
    if (!peekHome) {
      ease();
      renderAt(x, y);
      if (dist(x, y, tgt.x, tgt.y) < 6 || now > phaseUntil - 2600) {
        peekHome = { x: x, y: y };
        lean = 0;
        sprite.classList.add("pet-sneak");
        peekFlipAt = now + 1200 + Math.random() * 900;
      }
      if (now > phaseUntil) { clearPeek(); enterDrift(now); }
      return;
    }
    let nearPointer = mx !== null &&
      dist(peekHome.x + SIZE / 2, peekHome.y + SIZE / 2, mx, my) < SIZE * 3;
    if (nearPointer && peekGoal !== 0) {
      peekGoal = 0;
      peekFlipAt = Math.max(peekFlipAt, now + 1600);
    } else if (now >= peekFlipAt) {
      if (peekGoal === 0 && !nearPointer) {
        peekGoal = 1;
        peekFlipAt = now + 1500 + Math.random() * 1500;
        if (!peekSpoke) { peekSpoke = true; say(pick(QUIPS.peek)); }
      } else {
        peekGoal = 0;
        peekFlipAt = now + 900 + Math.random() * 1100;
      }
    }
    peekAmt += (peekGoal - peekAmt) * 0.055;
    bobT += 0.012;
    let duck = (1 - peekAmt) * SIZE * 0.4;
    let sway = Math.sin(bobT) * 0.7;
    let px = peekHome.x, py = peekHome.y, ins;
    if (peekEdge === 0) {
      px += sway; py += duck;
      ins = "inset(0 0 " + (46 + (duck / SIZE) * 100).toFixed(1) + "% 0)";
    } else if (peekEdge === 1) {
      px += duck; py += sway;
      ins = "inset(0 " + (50 + (duck / SIZE) * 100).toFixed(1) + "% 0 0)";
    } else {
      px -= duck; py += sway;
      ins = "inset(0 0 0 " + (50 + (duck / SIZE) * 100).toFixed(1) + "%)";
    }
    sprite.style.clipPath = ins;
    sprite.style.webkitClipPath = ins;
    x = px; y = py;
    renderAt(px, py);
    if (now > phaseUntil) { clearPeek(); enterDrift(now); }
  }

  function paragraphNearCenter() {
    const note = noteEl();
    if (!note) return null;
    const ps = note.querySelectorAll("p,li,h2,h3,blockquote");
    const mid = window.innerHeight / 2;
    let best = null, bestD = 1e9;
    for (let i = 0; i < ps.length; i++) {
      const r = ps[i].getBoundingClientRect();
      if (r.height < 10 || r.bottom < TOP_CLAMP || r.top > window.innerHeight) continue;
      const d = Math.abs((r.top + r.height / 2) - mid);
      if (d < bestD) { bestD = d; best = ps[i]; }
    }
    return best;
  }
  function readAnchor() {
    if (!readEl || !document.contains(readEl)) return null;
    const r = readEl.getBoundingClientRect();
    if (r.bottom < TOP_CLAMP || r.top > window.innerHeight) return null;
    const rightX = r.right + 18, leftX = r.left - SIZE - 18;
    const x0 = rightX <= maxX() ? rightX : (leftX >= MARGIN ? leftX : rightX);
    return { x: clampX(x0), y: clampY(r.top + r.height / 2 - SIZE / 2) };
  }
  function maybeRead() {
    if (reduced || petMode() !== "float" || roamPhase !== "drift" || !S().readAlong) return;
    const now = Date.now();
    if (now - lastRead < 9000 || Math.random() > 0.5) return;
    const p = paragraphNearCenter();
    if (!p) return;
    readEl = p;
    lastRead = now;
    roamPhase = "read";
    phaseUntil = now + 4500 + Math.random() * 3500;
    tgtEase = READ_EASE;
    setBoopable(true);
    say(pick(QUIPS.read));
  }
  function readStep(now) {
    const a = readAnchor();
    if (!a) { enterDrift(now); return; }
    tgt = a;
    ease();
    bobT += 0.04;
    renderAt(clampX(x), clampY(y + Math.sin(bobT) * 4));
    if (now > phaseUntil) enterDrift(now);
  }

  function pickWaypoint() {
    tgt = { x: MARGIN + Math.random() * (maxX() - MARGIN),
            y: TOP_CLAMP + Math.random() * (maxY() - TOP_CLAMP) };
    tgtEase = DRIFT_EASE;
  }
  function enterDrift(now) {
    roamPhase = "drift";
    pickWaypoint();
    holdUntil = now + 1500 + Math.random() * 2500;
    clearPeek();
    setBoopable(true);
    readEl = null;
    pet.style.opacity = "";
  }
  function nextDriftAction(now) {
    const r = Math.random();
    if (r < 0.22) enterVanish(now);
    else if (r < 0.40) enterPeek(now);
    else if (r < 0.72) holdUntil = now + 2600 + Math.random() * 3800;
    else pickWaypoint();
  }
  function doSpin(now) {
    spinning = true;
    lastStartle = now;
    sprite.className = "pet-sprite " + (Math.random() < 0.5 ? "pet-spin" : "pet-flip");
    setTimeout(function () {
      spinning = false;
      if (!petting) sprite.className = "pet-sprite";
    }, 740);
  }
  function driftStep(now) {
    const resting = holdUntil && now < holdUntil;
    if (resting) {
      if (Math.random() < 0.02) say(pick(QUIPS.idle));
    } else {
      holdUntil = 0;
      if (dist(x, y, tgt.x, tgt.y) < 20) nextDriftAction(now);
      else ease();
    }
    bobT += resting ? 0.014 : 0.024;
    const amp = resting ? 2.2 : 4.2;
    renderAt(clampX(x + Math.sin(bobT * 0.7) * amp),
             clampY(y + Math.sin(bobT * 1.0 + 1.3) * amp * 0.8));
    if (S().tricks && !spinning && now - lastStartle > BORED_AFTER) doSpin(now);
  }

  function edgePoint(ax, ay) {
    const W = window.innerWidth, H = window.innerHeight;
    const off = SIZE + 40;
    switch (Math.floor(Math.random() * 4)) {
      case 0: return { x: ax, y: -off };
      case 1: return { x: ax, y: H + off };
      case 2: return { x: -off, y: ay };
      default: return { x: W + off, y: ay };
    }
  }
  function enterVanish(now) {
    roamPhase = "vanish";
    tgt = edgePoint(x, y);
    tgtEase = VANISH_EASE;
    pet.style.opacity = "0";
    phaseUntil = now + 1200;
    clearPeek();
    setBoopable(false);
    readEl = null;
  }
  function vanishStep(now) {
    ease();
    renderAt(x, y);
    if (dist(x, y, tgt.x, tgt.y) < 10 || now > phaseUntil) {
      roamPhase = "gone";
      phaseUntil = now + 600 + Math.random() * 1700;
    }
  }
  function goneStep(now) {
    if (now > phaseUntil) beginArrive(now);
  }
  function beginArrive(now) {
    const w = { x: MARGIN + Math.random() * (maxX() - MARGIN),
                y: TOP_CLAMP + Math.random() * (maxY() - TOP_CLAMP) };
    const s = edgePoint(w.x, w.y);
    x = s.x; y = s.y; lean = 0;
    renderAt(x, y);
    pet.style.opacity = "";
    tgt = w;
    tgtEase = ARRIVE_EASE;
    roamPhase = "arrive";
    phaseUntil = now + 4500;
    setBoopable(true);
  }
  function arriveStep(now) {
    ease();
    bobT += 0.03;
    renderAt(clampX(x + Math.sin(bobT * 0.8) * 4), clampY(y + Math.sin(bobT * 1.1) * 3));
    if (dist(x, y, tgt.x, tgt.y) < 16 || now > phaseUntil) enterDrift(now);
  }

  function enterNap(now) {
    roamPhase = "nap";
    clearPeek();
    pet.style.opacity = "";
    tgt = { x: maxX(), y: maxY() };
    tgtEase = 0.06;
    pet.className = "pet-nap";
    setBoopable(true);
    say(pick(QUIPS.nap));
  }
  function napStep(now) {
    ease();
    renderAt(x, y);
    if (dist(x, y, tgt.x, tgt.y) < 3) {
      pet.style.opacity = "0.2";
      if (now - lastZ > 3200) { lastZ = now; spawnParticle("z", "pet-z"); }
    }
  }
  function wakeFromNap() {
    if (roamPhase !== "nap") return;
    pet.style.opacity = "";
    pet.className = "";
    lastStartle = Date.now();
    enterDrift(Date.now());
  }

  function stepRoam(now) {
    if (S().napping &&
        (roamPhase === "drift" || roamPhase === "peek" || roamPhase === "read") &&
        now - lastActive > NAP_AFTER)
      enterNap(now);
    switch (roamPhase) {
      case "drift":  driftStep(now);  break;
      case "peek":   peekStep(now);   break;
      case "read":   readStep(now);   break;
      case "spook":  spookStep(now);  break;
      case "nap":    napStep(now);    break;
      case "vanish": vanishStep(now); break;
      case "gone":   goneStep(now);   break;
      case "arrive": arriveStep(now); break;
      case "fling":  flingStep(now);  break;
      case "drag":   /* positioned by pointermove */ break;
    }
  }

  function tick() {
    raf = null;
    if (dead) return;
    const now = Date.now();
    if (drag && drag.moved) { schedule(); return; }
    if (petMode() === "float") {
      if (reduced) renderAt(x, y);
      else stepRoam(now);
      schedule();
      return;
    }
    if (S().napping && !napping && now - lastMove > NAP_AFTER) setNap(true);
    if (napping && now - lastZ > 3000) { lastZ = now; spawnParticle("z", "pet-z"); }
    if (!reduced && !napping && mx !== null) {
      const cx = x + SIZE / 2, cy = y + SIZE / 2;
      const dx = cx - mx, dy = cy - my;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const txp = mx + (dx / d) * TRAIL - SIZE / 2;
      const typ = my + (dy / d) * TRAIL - SIZE / 2;
      const vx = (txp - x) * EASE, vy = (typ - y) * EASE;
      if (Math.abs(vx) > 0.05 || Math.abs(vy) > 0.05) { x += vx; y += vy; }
      lean += (vx * 1.6 - lean) * 0.1;
      if (lean > 10) lean = 10;
      if (lean < -10) lean = -10;
      clampCore();
      apply();
    }
    schedule();
  }
  function schedule() {
    if (!dead && !document.hidden && petOn() && raf === null) {
      raf = window.requestAnimationFrame(tick);
    }
  }

  function enterRoam() {
    pet.className = "";
    pet.style.opacity = "";
    lastActive = Date.now();
    lastStartle = Date.now();
    if (reduced) { x = maxX(); y = maxY(); renderAt(x, y); return; }
    enterDrift(Date.now());
  }
  function leaveRoam() {
    clearPeek();
    pet.style.opacity = "";
    pet.className = napping ? "pet-nap" : "";
    sprite.style.pointerEvents = "";
  }

  on(document, "visibilitychange", function () {
    if (!document.hidden) { lastMove = Date.now(); markActivity(); schedule(); }
  });
  on(window, "resize", function () { clampCore(); apply(); });

  // Re-read settings after any change: apply appearance live, and only reset the
  // state machine when the mode itself changed (so tweaking a slider won't teleport).
  let lastMode = getMode();
  function notifySettingsChanged() {
    applySize();
    applyOpacity();
    setPetColor(S().color);
    const m = getMode();
    pet.style.display = m === "off" ? "none" : "";
    if (m === "off") {
      if (raf) { window.cancelAnimationFrame(raf); raf = null; }
      lastMode = m;
      return;
    }
    if (!S().napping && (napping || roamPhase === "nap")) {
      setNap(false);
      if (roamPhase === "nap") wakeFromNap();
    }
    if (m !== lastMode) {
      setNap(false);
      if (m === "float") enterRoam();
      else { leaveRoam(); lastMove = Date.now(); }
    }
    lastMode = m;
    schedule();
  }
  function notifyModeChanged() { notifySettingsChanged(); }

  function destroy() {
    dead = true;
    if (raf) { window.cancelAnimationFrame(raf); raf = null; }
    if (blinkTimer) { clearTimeout(blinkTimer); blinkTimer = null; }
    for (let i = 0; i < handlers.length; i++) {
      const h = handlers[i];
      h[0].removeEventListener(h[1], h[2], h[3]);
    }
    handlers.length = 0;
  }

  // start
  applySize();
  applyOpacity();
  applyPetColor();
  scheduleBlink();
  pet.style.display = getMode() === "off" ? "none" : "";
  if (petMode() === "float") enterRoam();
  else apply();
  schedule();

  return {
    destroy: destroy,
    notifyModeChanged: notifyModeChanged,
    notifySettingsChanged: notifySettingsChanged,
    cyclePetColor: cyclePetColor,
  };
}

module.exports = class TerminalWorkbenchPet extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.normalizeSettings();

    this.addSettingTab(new PetSettingTab(this.app, this));

    this.addCommand({
      id: "toggle",
      name: "Toggle pet on or off",
      callback: () => {
        this.setMode(this.settings.mode === "off" ? "float" : "off");
      },
    });
    this.addCommand({
      id: "cycle-mode",
      name: "Cycle pet mode (off, cursor, float)",
      callback: () => {
        const next = MODES[(MODES.indexOf(this.settings.mode) + 1) % MODES.length];
        this.setMode(next);
      },
    });
    this.addCommand({
      id: "cycle-color",
      name: "Recolor the pet",
      callback: () => {
        if (this.engine) this.engine.cyclePetColor();
      },
    });

    this.app.workspace.onLayoutReady(() => this.mount());
  }

  onunload() {
    this.unmount();
  }

  normalizeSettings() {
    const s = this.settings;
    if (MODES.indexOf(s.mode) === -1) s.mode = "float";
    s.size = clampNum(s.size, 16, 48, 28);
    s.opacity = clampNum(s.opacity, 20, 100, 70);
    s.color = (typeof s.color === "number" && s.color >= 0 && s.color < COLORS.length) ? (s.color | 0) : 0;
    ["quips", "reactions", "napping", "spookiness", "readAlong", "tricks"].forEach((k) => {
      if (typeof s[k] !== "boolean") s[k] = DEFAULT_SETTINGS[k];
    });
  }

  mount() {
    if (this.petEl) return;
    const el = document.body.createDiv({ attr: { id: "tw-pet", "aria-hidden": "true" } });
    const tilt = el.createDiv({ cls: "pet-tilt" });
    const sprite = tilt.createDiv({ cls: "pet-sprite", attr: { title: "boop to recolor · drag to move" } });
    sprite.appendChild(parseSvg(PET_SVG));
    this.petEl = el;
    this.engine = createPetEngine(
      el,
      () => this.settings,
      { onColorChange: (c) => { this.settings.color = c; this.saveData(this.settings); } }
    );
  }

  unmount() {
    if (this.engine) { this.engine.destroy(); this.engine = null; }
    if (this.petEl) { this.petEl.remove(); this.petEl = null; }
  }

  async saveAndApply() {
    await this.saveData(this.settings);
    if (this.engine) this.engine.notifySettingsChanged();
  }

  async setMode(mode) {
    if (MODES.indexOf(mode) === -1) return;
    this.settings.mode = mode;
    await this.saveAndApply();
  }
};

function clampNum(v, min, max, dflt) {
  const n = typeof v === "number" ? v : dflt;
  return Math.max(min, Math.min(max, n));
}

class PetSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    // --- Appearance -------------------------------------------------------
    new obsidian.Setting(containerEl).setName("Appearance").setHeading();

    new obsidian.Setting(containerEl)
      .setName("Size")
      .setDesc("How big the ghost is, in pixels.")
      .addSlider((sl) => {
        sl.setLimits(16, 48, 2).setValue(s.size).setDynamicTooltip();
        sl.onChange((v) => { s.size = v; this.plugin.saveAndApply(); });
      });

    new obsidian.Setting(containerEl)
      .setName("Opacity")
      .setDesc("How solid the ghost looks when it's active.")
      .addSlider((sl) => {
        sl.setLimits(20, 100, 5).setValue(s.opacity).setDynamicTooltip();
        sl.onChange((v) => { s.opacity = v; this.plugin.saveAndApply(); });
      });

    new obsidian.Setting(containerEl)
      .setName("Color")
      .setDesc("Starting body color from the theme palette. Booping the ghost also cycles it.")
      .addDropdown((d) => {
        COLORS.forEach((name, i) => d.addOption(String(i), name));
        d.setValue(String(s.color));
        d.onChange((v) => { s.color = parseInt(v, 10) || 0; this.plugin.saveAndApply(); });
      })
      .addExtraButton((b) => {
        b.setIcon("rotate-ccw").setTooltip("Reset to Green");
        b.onClick(() => { s.color = 0; this.plugin.saveAndApply(); this.display(); });
      });

    // --- Behavior ---------------------------------------------------------
    new obsidian.Setting(containerEl).setName("Behavior").setHeading();

    new obsidian.Setting(containerEl)
      .setName("Mode")
      .setDesc("Off hides the ghost. Follow cursor trails it behind your pointer. Float lets it roam the workspace on its own.")
      .addDropdown((d) => {
        d.addOption("off", "Off");
        d.addOption("cursor", "Follow cursor");
        d.addOption("float", "Float freely");
        d.setValue(s.mode);
        d.onChange((v) => this.plugin.setMode(v));
      });

    this.toggle(containerEl, "quips", "Speech bubbles",
      "Let the ghost pipe up now and then with a little terminal quip.");
    this.toggle(containerEl, "reactions", "React to writing",
      "Cheer when you finish a line or hit a typing streak.");
    this.toggle(containerEl, "napping", "Nap when idle",
      "Doze off in the corner after a minute of no activity.");
    this.toggle(containerEl, "spookiness", "Flee from cursor",
      "Dart away when your pointer gets too close (float mode).");
    this.toggle(containerEl, "readAlong", "Read along",
      "Drift over to the paragraph near the middle of the note (float mode).");
    this.toggle(containerEl, "tricks", "Do tricks",
      "The occasional bored spin or barrel roll (float mode).");

    const tip = containerEl.createEl("p", {
      text: "Tip: click the ghost to recolor it, or drag it anywhere — in float mode you can fling it. It matches the Terminal Workbench palette and respects your reduced-motion setting.",
    });
    tip.style.color = "var(--text-muted)";
    tip.style.fontSize = "13px";
  }

  toggle(containerEl, key, name, desc) {
    const s = this.plugin.settings;
    new obsidian.Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addToggle((t) => {
        t.setValue(!!s[key]);
        t.onChange((v) => { s[key] = v; this.plugin.saveAndApply(); });
      });
  }
}
