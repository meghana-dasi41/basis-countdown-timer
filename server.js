const express = require("express");
const { GifWriter } = require("omggif");
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");

const PORT = Number(process.env.PORT) || 8080;
const FONT_PATH = process.env.TIMER_FONT_PATH;
const FRAMES = 60;
const WIDTH = 768;
const HEIGHT = 192;
const GAP = 16;
const BOX_W = (WIDTH - GAP * 3) / 4;
const MAX_HORIZON_SECONDS = 366 * 24 * 3600;
const CACHE_TTL_MS = 1500;
const SHADES = 32;

let fontFamily = "sans-serif";
if (FONT_PATH && GlobalFonts.registerFromPath(FONT_PATH, "TimerFont")) {
  fontFamily = "TimerFont";
}

const cache = new Map();

function hexColor(value, fallback) {
  return /^[0-9a-fA-F]{6}$/.test(value || "") ? `#${value}` : fallback;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function split(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  return [
    String(Math.floor(s / 86400)),
    String(Math.floor((s % 86400) / 3600)),
    String(Math.floor((s % 3600) / 60)),
    String(s % 60).padStart(2, "0"),
  ];
}

function drawFrame(ctx, values, theme) {
  const labels = ["DAYS", "HOURS", "MINUTES", "SECONDS"];
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  values.forEach((value, i) => {
    const x = i * (BOX_W + GAP) + 3;
    const w = BOX_W - 6;
    roundRect(ctx, x, 3, w, HEIGHT - 6, 18);
    ctx.lineWidth = 5;
    ctx.strokeStyle = theme.fg;
    ctx.stroke();
    const cx = x + w / 2;
    ctx.fillStyle = theme.fg;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = `400 78px ${fontFamily}`;
    ctx.fillText(value, cx, 100);
    ctx.fillRect(cx - 62, 116, 124, 2);
    ctx.font = `400 22px ${fontFamily}`;
    ctx.fillText(labels[i], cx, 158);
  });
}

function toRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildPalette(theme) {
  const bg = toRgb(theme.bg);
  const fg = toRgb(theme.fg);
  const palette = [];
  for (let i = 0; i < SHADES; i++) {
    const t = i / (SHADES - 1);
    const c = bg.map((b, k) => Math.round(b + (fg[k] - b) * t));
    palette.push((c[0] << 16) | (c[1] << 8) | c[2]);
  }
  return { palette, bg, fg };
}

function indexFrame(ctx, bg, fg) {
  const { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const d = [fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  const out = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const t = ((data[p] - bg[0]) * d[0] + (data[p + 1] - bg[1]) * d[1] + (data[p + 2] - bg[2]) * d[2]) / len2;
    out[i] = Math.max(0, Math.min(SHADES - 1, Math.round(t * (SHADES - 1))));
  }
  return out;
}

function diffBox(prev, cur) {
  let x0 = WIDTH, y0 = HEIGHT, x1 = -1, y1 = -1;
  for (let y = 0; y < HEIGHT; y++) {
    const row = y * WIDTH;
    for (let x = 0; x < WIDTH; x++) {
      if (prev[row + x] !== cur[row + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { x: 0, y: 0, w: 1, h: 1 };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(pixels, box) {
  const out = new Uint8Array(box.w * box.h);
  for (let y = 0; y < box.h; y++) {
    const src = (box.y + y) * WIDTH + box.x;
    out.set(pixels.subarray(src, src + box.w), y * box.w);
  }
  return out;
}

function render(endEpoch, nowEpoch, theme) {
  const { palette, bg, fg } = buildPalette(theme);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const remaining = endEpoch - nowEpoch;
  const frameCount = remaining <= 0 ? 1 : Math.min(FRAMES, remaining + 1);
  const frames = [];
  let prev = null;
  for (let f = 0; f < frameCount; f++) {
    drawFrame(ctx, split(remaining - f), theme);
    const cur = indexFrame(ctx, bg, fg);
    const box = prev ? diffBox(prev, cur) : { x: 0, y: 0, w: WIDTH, h: HEIGHT };
    frames.push({ box, pixels: crop(cur, box) });
    prev = cur;
  }
  const capacity = frames.reduce((sum, fr) => sum + fr.pixels.length * 2 + 64, 2048);
  const buf = Buffer.alloc(capacity);
  const gif = new GifWriter(buf, WIDTH, HEIGHT, frameCount > 1 ? { palette, loop: 0 } : { palette });
  for (const fr of frames) {
    gif.addFrame(fr.box.x, fr.box.y, fr.box.w, fr.box.h, fr.pixels, { delay: 100, disposal: 1 });
  }
  return buf.subarray(0, gif.end());
}

const app = express();
app.disable("x-powered-by");

app.get("/health", (req, res) => res.send("ok"));

app.get("/timer.gif", (req, res) => {
  const endEpoch = Number(req.query.end);
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(endEpoch) || Math.abs(endEpoch - nowEpoch) > MAX_HORIZON_SECONDS) {
    return res.status(400).send("Invalid end parameter");
  }
  const theme = {
    fg: hexColor(req.query.fg, "#062889"),
    bg: hexColor(req.query.bg, "#ffffff"),
  };
  const key = `${endEpoch}|${nowEpoch}|${theme.fg}|${theme.bg}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = { buf: render(endEpoch, nowEpoch, theme), at: Date.now() };
    cache.set(key, entry);
    for (const [k, v] of cache) {
      if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    }
  }
  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.send(entry.buf);
});

app.listen(PORT, () => console.log(`Countdown timer listening on ${PORT}`));
