/**
 * The preview's idle board.
 *
 * The engine paints the board inside its own iframe, but the preview also needs
 * one when no scene is under the playhead (before the first clip, between clips
 * and after the last one). Painting the same presets here keeps the empty board
 * identical to the animated one, so changing the Background setting visibly
 * changes the whole preview instead of leaving a white panel behind.
 */

type BoardPaint = (ctx: CanvasRenderingContext2D, w: number, h: number, scale: number) => void;

const PRESET_PAINTS: Record<string, BoardPaint> = {
  notebook: (c, w, h, s) => {
    c.fillStyle = "#f4f8fc";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#c8d8e8";
    c.lineWidth = Math.max(0.5, s);
    for (let y = 22 * s; y < h; y += 22 * s) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    c.strokeStyle = "#d0dae4";
    c.lineWidth = Math.max(0.4, 0.5 * s);
    c.beginPath();
    c.moveTo(60 * s, 0);
    c.lineTo(60 * s, h);
    c.stroke();
  },
  graph: (c, w, h, s) => {
    c.fillStyle = "#f0f6fa";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "#dde8ef";
    c.lineWidth = Math.max(0.4, 0.5 * s);
    for (let x = 0; x < w; x += 20 * s) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    for (let y = 0; y < h; y += 20 * s) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    c.strokeStyle = "#c8d8e4";
    c.lineWidth = Math.max(0.5, s);
    for (let x = 0; x < w; x += 100 * s) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    for (let y = 0; y < h; y += 100 * s) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
  },
  cream: (c, w, h) => {
    const g = c.createRadialGradient(w * 0.3, h * 0.2, 0, w * 0.5, h * 0.5, w * 0.7);
    g.addColorStop(0, "#ede0c4");
    g.addColorStop(0.4, "#e8d5a0");
    g.addColorStop(1, "#d4b87a");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  },
  chalk: (c, w, h) => {
    const g = c.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, w * 0.7);
    g.addColorStop(0, "#2d4a3e");
    g.addColorStop(0.6, "#1a3328");
    g.addColorStop(1, "#0f2318");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  },
  softgrad: (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, "#f5f0ff");
    g.addColorStop(0.5, "#e8f4ff");
    g.addColorStop(1, "#f0fff4");
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  },
  warmwhite: (c, w, h) => {
    c.fillStyle = "#fafaf7";
    c.fillRect(0, 0, w, h);
  },
  blueprint: (c, w, h, s) => {
    c.fillStyle = "#1a3a5c";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(26, 82, 118, 0.6)";
    c.lineWidth = Math.max(0.5, s);
    for (let x = 0; x < w; x += 20 * s) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
    for (let y = 0; y < h; y += 20 * s) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
  },
  kraft: (c, w, h, s) => {
    c.fillStyle = "#c8973a";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(196, 151, 58, 0.25)";
    c.lineWidth = Math.max(0.4, s);
    for (let i = -h; i < w + h; i += 6 * s) {
      c.beginPath();
      c.moveTo(i, 0);
      c.lineTo(i + h, h);
      c.stroke();
    }
  },
  dark: (c, w, h) => {
    c.fillStyle = "#0f0f11";
    c.fillRect(0, 0, w, h);
  },
  linen: (c, w, h, s) => {
    c.fillStyle = "#f5ede0";
    c.fillRect(0, 0, w, h);
    c.strokeStyle = "rgba(0, 0, 0, 0.04)";
    c.lineWidth = Math.max(0.3, s);
    for (let y = 0; y < h; y += 4 * s) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    for (let x = 0; x < w; x += 4 * s) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, h);
      c.stroke();
    }
  },
};

/** Paint one background preset onto a board canvas (CSS pixels, already scaled). */
export function paintWhiteboardBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  background: string | undefined,
) {
  ctx.clearRect(0, 0, width, height);
  if (!width || !height) return;
  const key = background || "white";
  if (key === "transparent" || key === "none") return;
  if (key === "white" || key === "#ffffff") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  if (key === "black" || key === "#000000") {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, width, height);
    return;
  }
  const paint = PRESET_PAINTS[key];
  if (paint) {
    ctx.save();
    // Presets are authored against the engine's 1280 × 720 board.
    paint(ctx, width, height, width / 1280);
    ctx.restore();
    return;
  }
  ctx.fillStyle = key;
  ctx.fillRect(0, 0, width, height);
}
