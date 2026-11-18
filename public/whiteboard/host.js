/**
 * Inkplainer engine host for Cutline.
 *
 * The drawing engine in animations.js was written for Inkplainer's monolithic
 * index.html. This host recreates the small set of globals and DOM controls it
 * expects, then exposes a tiny frame-driven API so the Cutline preview can seek
 * a whiteboard animation to any point on the timeline.
 */
(function () {
  "use strict";

  var WIDTH = 1280;
  var HEIGHT = 720;
  var FPS = 30;
  var MAX_FRAMES = FPS * 120;

  // ── Canvas surfaces ───────────────────────────────────────────────────────
  var canvas = document.getElementById("main-canvas");
  var handCanvas = document.getElementById("hand-canvas");
  var mainCtx = canvas.getContext("2d", { willReadFrequently: true });
  var hctx = handCanvas.getContext("2d");
  var scratchCanvas = document.createElement("canvas");
  scratchCanvas.width = 1;
  scratchCanvas.height = 1;
  var sctx = scratchCanvas.getContext("2d");

  // ── Settings controls the engine reads by id ─────────────────────────────
  function control(tag, id, props) {
    var el = document.createElement(tag);
    el.id = id;
    Object.keys(props || {}).forEach(function (key) {
      if (key === "checked" || key === "value") el[key] = props[key];
      else el.setAttribute(key, props[key]);
    });
    document.getElementById("engine-controls").appendChild(el);
    return el;
  }

  control("input", "speed-slider", { type: "range", min: "1", max: "100", value: "40" });
  control("input", "hand-speed-slider", { type: "range", min: "1", max: "20", value: "6" });
  control("input", "tile-slider", { type: "range", min: "6", max: "80", value: "30" });
  control("input", "spec-tile-slider", { type: "range", min: "6", max: "80", value: "35" });
  control("input", "outline-detect-slider", { type: "range", min: "0", max: "100", value: "50" });
  control("input", "reveal-duration-slider", { type: "range", min: "0.3", max: "4", step: "0.1", value: "1.2" });
  control("input", "image-reveal", { type: "checkbox", checked: true });
  control("input", "of-outline-color", { type: "color", value: "#000000" });
  control("input", "of-outline-autocolor", { type: "checkbox", checked: true });
  control("input", "of-outline-thickness", { type: "range", min: "0.5", max: "8", step: "0.5", value: "2" });
  control("input", "outlineonly-color", { type: "color", value: "#000000" });
  control("input", "outlineonly-autocolor", { type: "checkbox", checked: false });
  control("input", "outlineonly-thickness", { type: "range", min: "0.5", max: "8", step: "0.5", value: "2" });
  control("input", "outlineonly-colorregion", { type: "checkbox", checked: false });
  control("input", "outlineonly-realimage", { type: "checkbox", checked: false });
  control("input", "text-outline-color", { type: "color", value: "#000000" });
  control("input", "text-outline-autocolor", { type: "checkbox", checked: true });
  control("input", "text-outline-thickness", { type: "range", min: "0.5", max: "8", step: "0.5", value: "2" });
  control("input", "outline-visible", { type: "checkbox", checked: true });
  control("input", "outline-opacity", { type: "range", min: "0", max: "100", value: "100" });

  var outlineOverlay = document.createElement("canvas");
  outlineOverlay.id = "outline-overlay";
  outlineOverlay.width = WIDTH;
  outlineOverlay.height = HEIGHT;
  outlineOverlay.style.display = "none";
  document.getElementById("engine-controls").appendChild(outlineOverlay);

  var doneBadge = document.createElement("div");
  doneBadge.id = "done-badge";
  document.getElementById("engine-controls").appendChild(doneBadge);

  var playIcon = document.createElement("span");
  playIcon.id = "play-icon";
  document.getElementById("engine-controls").appendChild(playIcon);
  var pauseIcon = document.createElement("span");
  pauseIcon.id = "pause-icon";
  document.getElementById("engine-controls").appendChild(pauseIcon);
  control("button", "play-pause-btn", { type: "button" });
  var progressFill = document.createElement("div");
  progressFill.id = "progress-fill";
  document.getElementById("engine-controls").appendChild(progressFill);
  var timeDisplay = document.createElement("span");
  timeDisplay.id = "time-display";
  document.getElementById("engine-controls").appendChild(timeDisplay);

  // ── Engine state ─────────────────────────────────────────────────────────
  var state = {
    mode: "image",
    canvasBg: { type: "solid", val: "#ffffff" },
    color: "#1a1a1a",
    hand: "custom1",
    animStyle: "chunkjump",
    zigzag: true,
    textAnimDir: "ltr",
    textDrawStyle: "reveal",
    outlineDetect: 50,
    outlineAlgorithm: "classic",
    outlineStrokeStyle: "default",
    colorStyle: "filled",
    canvasW: WIDTH,
    canvasH: HEIGHT,
    playing: false,
    isPlaying: false,
    handGlideEnabled: true,
    writingSound: true,
    _handGX: null,
    _handGY: null,
    _lastWriteTip: null,
    animFrame: null,
    done: false,
    curX: 0,
    curY: 0,
    scanDir: 1,
    strokeList: [],
    strokeIdx: 0,
    contentBounds: { x: 0, y: 0, w: WIDTH, h: HEIGHT },
    layers: [],
    selectedLayerId: null,
    activeLayerIndex: 0,
    groups: [],
    _groupIdCounter: 0,
    bgCanvas: null,
    _animProgress: 0,
    _animQueue: null,
    _queuePos: 0,
    _animGroups: null,
    _groupPos: 0,
    _activeSlots: [],
    _currentSlot: null,
    _slotMode: false,
    _revealFinalCanvas: null,
    _dissolveMap: null,
    noFlashFinish: false,
  };

  window.state = state;
  window.ctx = mainCtx;
  window._mainCtx = mainCtx;
  window.hctx = hctx;
  window.sctx = sctx;
  window.offscreen = null;
  window._revealStyle = "fade";

  function resScale() {
    return Math.sqrt((state.canvasW * state.canvasH) / (1280 * 720));
  }
  function resPointScale() {
    return Math.pow(resScale(), 0.6);
  }
  function resSoftBlur() {
    return Math.max(0, (resScale() - 1) * 1.5);
  }
  window.resScale = resScale;
  window.resPointScale = resPointScale;
  window.resSoftBlur = resSoftBlur;

  window.setProgress = function (ratio) {
    state._animProgress = Math.min(1, Math.max(0, ratio));
    progressFill.style.width = Math.round(state._animProgress * 100) + "%";
    timeDisplay.textContent = Math.round(state._animProgress * 100) + "%";
  };

  window.drawSelectionHandles = function () {};

  // ── Background ───────────────────────────────────────────────────────────
  var BG_GRADIENTS = {
    notebook: function (c) {
      c.fillStyle = "#f4f8fc";
      c.fillRect(0, 0, state.canvasW, state.canvasH);
      c.strokeStyle = "#c8d8e8";
      c.lineWidth = 1;
      for (var y = 22; y < state.canvasH; y += 22) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(state.canvasW, y); c.stroke();
      }
      c.strokeStyle = "#d0dae4";
      c.lineWidth = 0.5;
      c.beginPath(); c.moveTo(60, 0); c.lineTo(60, state.canvasH); c.stroke();
    },
    graph: function (c) {
      c.fillStyle = "#f0f6fa";
      c.fillRect(0, 0, state.canvasW, state.canvasH);
      c.strokeStyle = "#dde8ef";
      c.lineWidth = 0.5;
      for (var x = 0; x < state.canvasW; x += 20) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, state.canvasH); c.stroke();
      }
      for (var y = 0; y < state.canvasH; y += 20) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(state.canvasW, y); c.stroke();
      }
      c.strokeStyle = "#c8d8e4";
      c.lineWidth = 1;
      for (var x2 = 0; x2 < state.canvasW; x2 += 100) {
        c.beginPath(); c.moveTo(x2, 0); c.lineTo(x2, state.canvasH); c.stroke();
      }
      for (var y2 = 0; y2 < state.canvasH; y2 += 100) {
        c.beginPath(); c.moveTo(0, y2); c.lineTo(state.canvasW, y2); c.stroke();
      }
    },
    cream: function (c) {
      var g = c.createRadialGradient(state.canvasW * 0.3, state.canvasH * 0.2, 0, state.canvasW * 0.5, state.canvasH * 0.5, state.canvasW * 0.7);
      g.addColorStop(0, "#ede0c4"); g.addColorStop(0.4, "#e8d5a0"); g.addColorStop(1, "#d4b87a");
      c.fillStyle = g; c.fillRect(0, 0, state.canvasW, state.canvasH);
    },
    chalk: function (c) {
      var g = c.createRadialGradient(state.canvasW * 0.5, state.canvasH * 0.5, 0, state.canvasW * 0.5, state.canvasH * 0.5, state.canvasW * 0.7);
      g.addColorStop(0, "#2d4a3e"); g.addColorStop(0.6, "#1a3328"); g.addColorStop(1, "#0f2318");
      c.fillStyle = g; c.fillRect(0, 0, state.canvasW, state.canvasH);
    },
    softgrad: function (c) {
      var g = c.createLinearGradient(0, 0, state.canvasW, state.canvasH);
      g.addColorStop(0, "#f5f0ff"); g.addColorStop(0.5, "#e8f4ff"); g.addColorStop(1, "#f0fff4");
      c.fillStyle = g; c.fillRect(0, 0, state.canvasW, state.canvasH);
    },
    warmwhite: function (c) { c.fillStyle = "#fafaf7"; c.fillRect(0, 0, state.canvasW, state.canvasH); },
    blueprint: function (c) {
      c.fillStyle = "#1a3a5c";
      c.fillRect(0, 0, state.canvasW, state.canvasH);
      c.strokeStyle = "rgba(26,82,118,0.6)";
      c.lineWidth = 1;
      for (var x = 0; x < state.canvasW; x += 20) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, state.canvasH); c.stroke();
      }
      for (var y = 0; y < state.canvasH; y += 20) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(state.canvasW, y); c.stroke();
      }
    },
    kraft: function (c) {
      c.fillStyle = "#c8973a";
      c.fillRect(0, 0, state.canvasW, state.canvasH);
      c.strokeStyle = "rgba(196,151,58,0.25)";
      c.lineWidth = 1;
      for (var i = -state.canvasH; i < state.canvasW + state.canvasH; i += 6) {
        c.beginPath(); c.moveTo(i, 0); c.lineTo(i + state.canvasH, state.canvasH); c.stroke();
      }
    },
    dark: function (c) { c.fillStyle = "#0f0f11"; c.fillRect(0, 0, state.canvasW, state.canvasH); },
    linen: function (c) {
      c.fillStyle = "#f5ede0";
      c.fillRect(0, 0, state.canvasW, state.canvasH);
      c.strokeStyle = "rgba(0,0,0,0.04)";
      c.lineWidth = 1;
      for (var y = 0; y < state.canvasH; y += 4) {
        c.beginPath(); c.moveTo(0, y); c.lineTo(state.canvasW, y); c.stroke();
      }
      for (var x = 0; x < state.canvasW; x += 4) {
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, state.canvasH); c.stroke();
      }
    },
  };

  function paintBackground(c) {
    var bg = state.canvasBg || { type: "solid", val: "#ffffff" };
    if (bg.type === "solid") {
      if (bg.val === "transparent") c.clearRect(0, 0, state.canvasW, state.canvasH);
      else {
        c.fillStyle = bg.val === "white" ? "#ffffff" : bg.val;
        c.fillRect(0, 0, state.canvasW, state.canvasH);
      }
    } else if (bg.type === "gradient" && BG_GRADIENTS[bg.key]) {
      c.save(); BG_GRADIENTS[bg.key](c); c.restore();
    } else if (bg.type === "custom") {
      c.fillStyle = bg.val;
      c.fillRect(0, 0, state.canvasW, state.canvasH);
    } else {
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, state.canvasW, state.canvasH);
    }
  }

  window.fillBg = function (c) {
    if (state._slotMode) {
      c.clearRect(0, 0, state.canvasW, state.canvasH);
      return;
    }
    paintBackground(c);
    if (state.bgCanvas) c.drawImage(state.bgCanvas, 0, 0);
  };
  window.fillBgOnCtx = window.fillBg;

  // ── Content bounds / pre-render (ported from Inkplainer index.html) ───────
  function detectContentBounds(oc) {
    var w = oc.width;
    var h = oc.height;
    var d = oc.getContext("2d").getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = 0, maxY = 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var a = d[i + 3];
        var notWhite = d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240;
        var hasTrans = a < 250;
        if (a > 20 && (notWhite || hasTrans)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return { x: 0, y: 0, w: w, h: h };
    var pad = 28;
    var bx = Math.max(0, minX - pad);
    var by = Math.max(0, minY - pad);
    return {
      x: bx,
      y: by,
      w: Math.min(w, maxX + pad) - bx,
      h: Math.min(h, maxY + pad) - by,
    };
  }

  function preRender() {
    state.bgCanvas = document.createElement("canvas");
    state.bgCanvas.width = state.canvasW;
    state.bgCanvas.height = state.canvasH;
    paintBackground(state.bgCanvas.getContext("2d"));

    var off = document.createElement("canvas");
    off.width = state.canvasW;
    off.height = state.canvasH;
    var oc = off.getContext("2d", { willReadFrequently: true });
    var layer = state.layers[state.activeLayerIndex];
    if (layer) {
      oc.save();
      oc.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1;
      oc.drawImage(layer.img, layer.x, layer.y, layer.w, layer.h);
      oc.restore();
    }

    window.offscreen = off;
    state.contentBounds = detectContentBounds(off);
  }

  // ── Hands ────────────────────────────────────────────────────────────────
  var HAND_CONFIG = {
    custom1: { width: 432, height: 768, tipX: 229, tipY: 0 },
    custom2: { width: 432, height: 768, tipX: 166, tipY: 0 },
    custom3: { width: 432, height: 768, tipX: 117, tipY: 0 },
    custom4: { width: 432, height: 768, tipX: 81, tipY: 628 },
  };
  var handImages = {};
  var handsReady = false;

  function loadHands() {
    var ids = Object.keys(HAND_CONFIG);
    var left = ids.length;
    ids.forEach(function (id) {
      var img = new Image();
      img.onload = function () {
        handImages[id] = img;
        left -= 1;
        if (left === 0) handsReady = true;
      };
      img.onerror = function () {
        handImages[id] = null;
        left -= 1;
        if (left === 0) handsReady = true;
      };
      img.src = "./hands/hand" + id.slice(-1) + "-720p.png";
    });
  }
  loadHands();

  // ── Board writing sound ─────────────────────────────────────────────────
  // The sound only runs while the editor is actually playing (seeks while
  // scrubbing stay silent), and only while the pen tip is moving.
  var writingAudio = null;
  var writingTimer = 0;
  function ensureWritingAudio() {
    if (!writingAudio) {
      writingAudio = new Audio("./sounds/writing-on-paper.mp3");
      writingAudio.loop = true;
      writingAudio.volume = 0.5;
      writingAudio.preload = "auto";
    }
    return writingAudio;
  }
  function scribbleHand(active) {
    if (!state.writingSound || !state.isPlaying) active = false;
    if (!active) {
      if (writingTimer) {
        clearTimeout(writingTimer);
        writingTimer = 0;
      }
      if (writingAudio && !writingAudio.paused) {
        try { writingAudio.pause(); } catch (e) { /* ignore */ }
      }
      return;
    }
    var audio = ensureWritingAudio();
    if (audio.paused) {
      var played = audio.play();
      if (played && played.catch) played.catch(function () { /* autoplay blocked */ });
    }
    // A short tail keeps the loop smooth while the pen pauses between strokes.
    if (writingTimer) clearTimeout(writingTimer);
    writingTimer = setTimeout(function () {
      writingTimer = 0;
      if (writingAudio && !writingAudio.paused) {
        try { writingAudio.pause(); } catch (e) { /* ignore */ }
      }
    }, 150);
  }

  window.drawHand = function (c, tipX, tipY, dir, style) {
    if (style === "ghost") {
      scribbleHand(false);
      return;
    }

    // Board-writing sound follows the raw tip; invisible hands are silent.
    var lastTip = state._lastWriteTip;
    var moved = lastTip ? Math.abs(tipX - lastTip.x) + Math.abs(tipY - lastTip.y) : 0;
    state._lastWriteTip = { x: tipX, y: tipY };
    scribbleHand(moved > 0.4);

    // Smooth hand movement: glide the rendered hand toward the engine's target
    // instead of snapping to it when a fast reveal jumps several pixels.
    var drawX = tipX, drawY = tipY;
    if (state.handGlideEnabled) {
      var MAX_GLIDE_PX = 34;
      if (state._handGX == null) {
        state._handGX = tipX;
        state._handGY = tipY;
      } else {
        var dx = tipX - state._handGX;
        var dy = tipY - state._handGY;
        var dist = Math.hypot(dx, dy);
        if (dist <= MAX_GLIDE_PX) {
          state._handGX = tipX;
          state._handGY = tipY;
        } else {
          var t = MAX_GLIDE_PX / dist;
          state._handGX += dx * t;
          state._handGY += dy * t;
        }
      }
      drawX = state._handGX;
      drawY = state._handGY;
    }

    var id = HAND_CONFIG[style] ? style : "custom1";
    var conf = HAND_CONFIG[id];
    var img = handImages[id];
    // A hand asset can still be loading, or can have failed to load if the
    // development server restarts mid-scene. Skip it rather than throwing.
    if (!img || !img.complete || img.naturalWidth === 0) return;
    c.save();
    c.drawImage(img, drawX - conf.tipX, drawY - conf.tipY, conf.width, conf.height);
    c.restore();
  };

  // ── Config ───────────────────────────────────────────────────────────────
  var DEFAULT_CONFIG = {
    style: "chunkjump",
    speed: 40,
    handSpeed: 6,
    hand: "custom1",
    chunks: 30,
    specChunks: 35,
    // User-drawn closed borders. Non-empty means the slicer paints them in
    // their numbered order, whatever base style the clip has.
    slices: [],
    zigzag: true,
    background: "#ffffff",
    reveal: true,
    revealStyle: "fade",
    revealDuration: 1.2,
    colorStyle: "filled",
    outlineDetect: 50,
    outlineAlgorithm: "classic",
    outlineStrokeStyle: "default",
    textAnimDir: "ltr",
    textDrawStyle: "reveal",
  };

  function setRange(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  function applyConfig(config) {
    var cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    state.slices = Array.isArray(cfg.slices) ? cfg.slices : [];
    // Length of the editor's solved slice schedule. When present the scene runs
    // for exactly this long, so one engine frame equals one timeline frame and
    // lag/hold gaps survive seeking.
    state.timingSeconds = Number(cfg.timingSeconds) || 0;
    // Slices take over the scene: they are the user's own cuts, so the base
    // style only matters once the slice list is cleared.
    state.animStyle = state.slices.length ? "slicer" : cfg.style;
    // The Hand switch is the default. Turning it off exposes two fallbacks:
    // pencil only (the pen asset) and invisible (no hand at all).
    var offMode = cfg.handOffMode || "pencil";
    state.hand = cfg.handVisible === false
      ? (offMode === "invisible" ? "ghost" : "custom4")
      : (cfg.hand || "custom1");
    state.handSpeed = cfg.handSpeed;
    state.handGlideEnabled = cfg.smoothHand !== false;
    state.writingSound = cfg.writingSound !== false;
    state.zigzag = cfg.zigzag;
    state.colorStyle = cfg.colorStyle;
    state.outlineDetect = cfg.outlineDetect;
    state.outlineAlgorithm = cfg.outlineAlgorithm;
    state.outlineStrokeStyle = cfg.outlineStrokeStyle;
    state.textAnimDir = cfg.textAnimDir;
    state.textDrawStyle = cfg.textDrawStyle;
    // Background values are either an Inkplainer gradient key or a solid colour.
    var bg = cfg.background || "white";
    state.canvasBg = BG_GRADIENTS[bg]
      ? { type: "gradient", val: bg, key: bg }
      : { type: "solid", val: bg === "none" ? "transparent" : bg };
    window._revealStyle = cfg.revealStyle || "fade";

    setRange("speed-slider", cfg.speed);
    setRange("hand-speed-slider", cfg.handSpeed);
    setRange("tile-slider", cfg.chunks);
    setRange("spec-tile-slider", cfg.specChunks);
    setRange("reveal-duration-slider", cfg.revealDuration);
    setRange("outline-detect-slider", cfg.outlineDetect);

    var reveal = document.getElementById("image-reveal");
    if (reveal) reveal.checked = cfg.reveal !== false;
    return cfg;
  }

  // ── Frame driving ────────────────────────────────────────────────────────
  var FALLBACK_LAYER = null;
  var currentFrame = 0;
  var naturalFrames = 0;
  var prepared = false;
  var config = DEFAULT_CONFIG;
  var imageVersion = 0;

  function tickOnce() {
    var speed = parseInt(document.getElementById("speed-slider").value, 10) || 40;
    var style = state.animStyle;
    if (state.slices && state.slices.length) window.AnimationEngine.tickSlicer(speed);
    else if (style === "contour") window.AnimationEngine.tickContour(speed);
    else if (style === "outlinechunks") window.AnimationEngine.tickOutlineChunks(speed);
    else if (style === "outlinefill") window.AnimationEngine.tickOutlineFill(speed);
    else if (style === "illustfill") window.AnimationEngine.tickIllustFill(speed);
    else if (style === "outlineonly") window.AnimationEngine.tickOutlineOnly(speed);
    else if (style === "chunkjump") window.AnimationEngine.tickChunkJump(speed);
    else if (style === "slicer") window.AnimationEngine.tickSlicer(speed);
    else if (style === "scribble") window.AnimationEngine.tickScribble(speed);
    else if (style === "spec-text") window.AnimationEngine.tickSpecText(speed);
    else if (style === "spec-human" || style === "spec-animal" || style === "spec-portrait" ||
      style === "spec-vehicle" || style === "spec-building" || style === "spec-landscape" ||
      style === "spec-spiral" || style === "spec-nature") window.AnimationEngine.tickSpecialized(speed);
    else window.AnimationEngine.tickScanner(speed);
  }

  function prepare() {
    preRender();
    window.AnimationEngine.resetAnim();
    window.AnimationEngine.setupStyle();
    fillBg(mainCtx);
    hctx.clearRect(0, 0, state.canvasW, state.canvasH);
    currentFrame = 0;
    state._handGX = null;
    state._handGY = null;
    state._lastWriteTip = null;
    prepared = true;
  }

  function ensurePrepared() {
    if (!prepared) prepare();
  }

  function measureNaturalFrames() {
    prepare();
    // The editor already solved lag/animation/hold against the clip duration,
    // so the scene length is known up front — no need to tick to discover it.
    if (state.timingSeconds > 0 && state.slices.length) {
      return Math.max(1, Math.min(MAX_FRAMES, Math.round(state.timingSeconds * FPS)));
    }
    var frames = 0;
    while (!state.done && frames < MAX_FRAMES) {
      tickOnce();
      frames += 1;
    }
    return frames;
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("Could not load the image for the whiteboard engine")); };
      img.src = src;
    });
  }

  function fitLayer(img) {
    var scale = Math.min(state.canvasW / img.naturalWidth, state.canvasH / img.naturalHeight) * 0.82;
    var w = Math.round(img.naturalWidth * scale);
    var h = Math.round(img.naturalHeight * scale);
    return {
      id: 1,
      name: "photo",
      img: img,
      x: Math.round((state.canvasW - w) / 2),
      y: Math.round((state.canvasH - h) / 2),
      w: w,
      h: h,
      opacity: 1,
      visible: true,
      animStyle: state.animStyle,
      hand: state.hand,
      handSpeed: config.handSpeed,
      speed: config.speed,
      chunks: config.chunks,
      specChunks: config.specChunks,
      zigzag: config.zigzag,
      outlineDetect: config.outlineDetect,
      outlineAlgorithm: config.outlineAlgorithm,
      outlineStrokeStyle: config.outlineStrokeStyle,
    };
  }

  var api = {
    ready: false,
    load: function (src, nextConfig) {
      config = applyConfig(nextConfig);
      var version = ++imageVersion;
      prepared = false;
      currentFrame = 0;
      naturalFrames = 0;
      return loadImage(src).then(function (img) {
        if (version !== imageVersion) return { stale: true };
        FALLBACK_LAYER = fitLayer(img);
        state.layers = [FALLBACK_LAYER];
        state.activeLayerIndex = 0;
        state._animQueue = [FALLBACK_LAYER];
        state._queuePos = 0;
        state._animGroups = [[FALLBACK_LAYER]];
        state._groupPos = 0;
        naturalFrames = measureNaturalFrames();
        prepare();
        return { stale: false, frames: naturalFrames, duration: naturalFrames / FPS };
      });
    },
    configure: function (nextConfig) {
      config = applyConfig(nextConfig);
      prepared = false;
      naturalFrames = 0;
      if (state.layers.length) {
        state.layers[0].animStyle = state.animStyle;
        state.layers[0].hand = state.hand;
        state.layers[0].handSpeed = config.handSpeed;
        state.layers[0].chunks = config.chunks;
        state.layers[0].specChunks = config.specChunks;
        naturalFrames = measureNaturalFrames();
        prepare();
      }
      return { frames: naturalFrames, duration: naturalFrames / FPS };
    },
    seek: function (localSeconds, clipDuration) {
      ensurePrepared();
      var seconds = Math.max(0, Number(localSeconds) || 0);
      var target;
      if (clipDuration && clipDuration > 0 && naturalFrames > 0 && naturalFrames > clipDuration * FPS) {
        target = Math.round((seconds / clipDuration) * naturalFrames);
      } else {
        target = Math.round(seconds * FPS);
      }
      if (naturalFrames > 0) target = Math.min(target, naturalFrames);
      if (target < currentFrame || !prepared) {
        prepare();
      }
      try {
        while (currentFrame < target && !state.done) {
          tickOnce();
          currentFrame += 1;
        }
      } catch (error) {
        // A failed draw must never take down the editor's React tree.
        console.error("Whiteboard engine frame failed", error);
        state.done = true;
      }
      return {
        frame: currentFrame,
        done: state.done,
        naturalFrames: naturalFrames,
      };
    },
    getNaturalFrames: function () { return naturalFrames; },
    setPlaying: function (playing) {
      state.isPlaying = !!playing;
      state.playing = !!playing;
      if (!playing) scribbleHand(false);
    },
    finished: function () { return !!state.done; },
  };

  window.InkplainerHost = api;

  // Signal readiness once the hand assets settle (or immediately if they fail).
  var readyTimer = setInterval(function () {
    if (handsReady) {
      clearInterval(readyTimer);
      api.ready = true;
      document.body.setAttribute("data-ready", "true");
    }
  }, 30);
})();
