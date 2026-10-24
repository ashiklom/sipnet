// Minimal canvas line chart for overlaid SIPNET time series.
//
// - one y-axis, hairline grid, 2px lines
// - legend with line keys; series colors are CSS custom property names (e.g.
//   '--series-1') chosen by the caller so they follow the run, and are
//   resolved at draw time so light/dark changes apply immediately
// - crosshair + one tooltip listing every series at the hovered x
// - long series are decimated to min/max per pixel column

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MARGIN = { left: 64, right: 16, top: 12, bottom: 30 };

const numFmt = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 3 });
export const fmtValue = (v) => (Number.isFinite(v) ? numFmt.format(v) : '–');
const fmtTick = (v) => (Math.abs(v) >= 1000 ? compactFmt.format(v) : numFmt.format(v));

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

function ticks(min, max, target) {
  if (!(max > min)) return [min];
  const step = niceStep(max - min, target);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

// x is decimal year: yearly ticks for long spans, month ticks for short ones
function timeTicks(min, max, target) {
  const span = max - min;
  if (span > 3) {
    const step = Math.max(1, niceStep(span, target));
    return ticks(min, max, span / step).filter((v) => Number.isInteger(v))
      .map((v) => ({ v, label: String(v) }));
  }
  const months = [1, 2, 3, 6, 12].find((m) => (span * 12) / m <= target) || 12;
  const out = [];
  let m = Math.ceil(min * 12 / months) * months;
  for (; m / 12 <= max; m += months) {
    const year = Math.floor(m / 12);
    const mo = ((m % 12) + 12) % 12;
    out.push({ v: m / 12, label: mo === 0 ? String(year) : `${MONTHS[mo]}` });
  }
  return out;
}

function fmtTime(x, period) {
  const year = Math.floor(x);
  if (period === 'year') return String(year);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const doyF = (x - year) * (leap ? 366 : 365);
  const doy = Math.floor(doyF) + 1;
  if (period === 'month') return `${MONTHS[Math.min(11, Math.floor((x - year) * 12))]} ${year}`;
  if (period === 'day') return `${year} day ${doy}`;
  const hour = Math.round((doyF - Math.floor(doyF)) * 24 * 100) / 100;
  return `${year} day ${doy}, ${hour.toFixed(1)} h`;
}

// Index of the element of sorted array `xs` nearest to `x`
function nearest(xs, x) {
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid; else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

export class LineChart {
  constructor(root) {
    this.root = root;
    root.classList.add('chart');
    this.legend = document.createElement('ul');
    this.legend.className = 'chart-legend';
    this.frame = document.createElement('div');
    this.frame.className = 'chart-frame';
    this.canvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'chart-overlay';
    this.overlay.tabIndex = 0;
    this.overlay.setAttribute('role', 'img');
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    this.empty = document.createElement('div');
    this.empty.className = 'chart-empty';
    this.frame.append(this.canvas, this.overlay, this.tooltip, this.empty);
    root.append(this.legend, this.frame);

    this.series = [];
    this.hoverX = null;
    this.overlay.addEventListener('pointermove', (e) => this.onPointer(e));
    this.overlay.addEventListener('pointerleave', () => this.setHover(null));
    this.overlay.addEventListener('keydown', (e) => this.onKey(e));
    this.overlay.addEventListener('blur', () => this.setHover(null));
    new ResizeObserver(() => this.draw()).observe(this.frame);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
  }

  // series: [{ label, color: '--series-N', x: Float64Array, y: Float64Array }]
  setData({ series, yLabel = '', period = 'none', emptyText = '' }) {
    this.series = series.filter((s) => s.x.length > 0);
    this.yLabel = yLabel;
    this.period = period;
    this.empty.textContent = emptyText;
    this.empty.hidden = this.series.length > 0;
    this.overlay.setAttribute('aria-label', yLabel
      ? `Line chart of ${yLabel} for ${this.series.map((s) => s.label).join(', ')}` : 'Line chart');
    this.renderLegend();
    this.hoverX = null;
    this.draw();
  }

  renderLegend() {
    this.legend.replaceChildren(...(this.series.length > 1 ? this.series : []).map((s) => {
      const li = document.createElement('li');
      const key = document.createElement('span');
      key.className = 'line-key';
      key.style.background = `var(${s.color})`;
      li.append(key, document.createTextNode(s.label));
      return li;
    }));
  }

  colors() {
    const cs = getComputedStyle(this.root);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      surface: v('--surface-1'), grid: v('--grid'), axis: v('--axis'),
      muted: v('--text-muted'), ink: v('--text-secondary'),
      series: (name) => v(name),
    };
  }

  layout() {
    const w = this.frame.clientWidth;
    const h = this.frame.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.canvas, this.overlay]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    }
    let xmin = Infinity;
    let xmax = -Infinity;
    let ymin = Infinity;
    let ymax = -Infinity;
    for (const s of this.series) {
      xmin = Math.min(xmin, s.x[0]);
      xmax = Math.max(xmax, s.x[s.x.length - 1]);
      for (const v of s.y) {
        if (v < ymin) ymin = v;
        if (v > ymax) ymax = v;
      }
    }
    if (ymin === ymax) {
      ymin -= 1;
      ymax += 1;
    }
    const yt = ticks(ymin, ymax, Math.max(2, Math.floor(h / 60)));
    ymin = Math.min(ymin, yt[0]);
    ymax = Math.max(ymax, yt[yt.length - 1]);
    const pw = w - MARGIN.left - MARGIN.right;
    const ph = h - MARGIN.top - MARGIN.bottom;
    this.geo = {
      w, h, dpr, pw, ph, xmin, xmax, ymin, ymax, yt,
      sx: (x) => MARGIN.left + ((x - xmin) / (xmax - xmin || 1)) * pw,
      sy: (y) => MARGIN.top + (1 - (y - ymin) / (ymax - ymin)) * ph,
      ix: (px) => xmin + ((px - MARGIN.left) / pw) * (xmax - xmin),
    };
  }

  draw() {
    const ctx = this.canvas.getContext('2d');
    if (!this.series.length || this.frame.clientWidth === 0) {
      this.canvas.width = 0;
      this.overlay.width = 0;
      return;
    }
    this.layout();
    const g = this.geo;
    const col = this.colors();
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.fontVariantNumeric = 'tabular-nums';

    // Grid + y ticks
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of g.yt) {
      const y = Math.round(g.sy(t)) + 0.5;
      ctx.strokeStyle = t === 0 ? col.axis : col.grid;
      ctx.beginPath();
      ctx.moveTo(MARGIN.left, y);
      ctx.lineTo(g.w - MARGIN.right, y);
      ctx.stroke();
      ctx.fillStyle = col.muted;
      ctx.fillText(fmtTick(t), MARGIN.left - 8, y);
    }
    // x axis + ticks
    const base = g.h - MARGIN.bottom + 0.5;
    ctx.strokeStyle = col.axis;
    ctx.beginPath();
    ctx.moveTo(MARGIN.left, base);
    ctx.lineTo(g.w - MARGIN.right, base);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = col.muted;
    let lastRight = -Infinity;
    for (const t of timeTicks(g.xmin, g.xmax, Math.max(2, Math.floor(g.pw / 80)))) {
      const x = g.sx(t.v);
      const tw = ctx.measureText(t.label).width;
      if (x - tw / 2 < lastRight + 6) continue;
      ctx.fillText(t.label, x, base + 6);
      lastRight = x + tw / 2;
    }
    // y label
    if (this.yLabel) {
      ctx.save();
      ctx.translate(14, MARGIN.top + g.ph / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = col.ink;
      ctx.fillText(this.yLabel, 0, 0);
      ctx.restore();
    }

    // Series
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN.left, MARGIN.top - 2, g.pw, g.ph + 4);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of this.series) {
      ctx.strokeStyle = col.series(s.color);
      ctx.beginPath();
      const n = s.x.length;
      if (n > g.pw * 2) {
        // Decimate: one vertical min-max stroke per pixel column
        let col0 = Math.floor(g.sx(s.x[0]));
        let lo = s.y[0];
        let hi = s.y[0];
        ctx.moveTo(col0, g.sy(s.y[0]));
        for (let i = 1; i < n; i++) {
          const c = Math.floor(g.sx(s.x[i]));
          if (c !== col0) {
            ctx.lineTo(col0, g.sy(lo));
            ctx.lineTo(col0, g.sy(hi));
            col0 = c;
            lo = hi = s.y[i];
          } else {
            if (s.y[i] < lo) lo = s.y[i];
            if (s.y[i] > hi) hi = s.y[i];
          }
        }
        ctx.lineTo(col0, g.sy(lo));
        ctx.lineTo(col0, g.sy(hi));
      } else {
        ctx.moveTo(g.sx(s.x[0]), g.sy(s.y[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(g.sx(s.x[i]), g.sy(s.y[i]));
      }
      ctx.stroke();
    }
    ctx.restore();
    this.drawHover();
  }

  onPointer(e) {
    if (!this.geo) return;
    const rect = this.overlay.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (px < MARGIN.left || px > this.geo.w - MARGIN.right) {
      this.setHover(null);
      return;
    }
    this.setHover(this.geo.ix(px));
  }

  onKey(e) {
    if (!this.geo || !this.series.length) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const xs = this.series[0].x;
    const i = this.hoverX === null ? 0 : nearest(xs, this.hoverX);
    const step = Math.max(1, Math.round(xs.length / 100));
    const j = Math.min(xs.length - 1, Math.max(0, i + (e.key === 'ArrowRight' ? step : -step)));
    this.setHover(xs[j]);
  }

  setHover(x) {
    this.hoverX = x;
    this.drawHover();
  }

  drawHover() {
    const g = this.geo;
    if (!g) return;
    const ctx = this.overlay.getContext('2d');
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);
    if (this.hoverX === null || !this.series.length) {
      this.tooltip.hidden = true;
      return;
    }
    const col = this.colors();
    // Snap to the nearest data position of the first series
    const ref = this.series[0];
    const x = ref.x[nearest(ref.x, this.hoverX)];
    const px = Math.round(g.sx(x)) + 0.5;
    ctx.strokeStyle = col.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, MARGIN.top);
    ctx.lineTo(px, g.h - MARGIN.bottom);
    ctx.stroke();

    const rows = [];
    for (const s of this.series) {
      const i = nearest(s.x, x);
      const v = s.y[i];
      rows.push({ s, v });
      ctx.beginPath();
      ctx.arc(g.sx(s.x[i]), g.sy(v), 4, 0, 2 * Math.PI);
      ctx.fillStyle = col.series(s.color);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = col.surface;
      ctx.stroke();
    }

    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = fmtTime(x, this.period);
    const items = rows.map(({ s, v }) => {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('span');
      key.className = 'line-key';
      key.style.background = `var(${s.color})`;
      const val = document.createElement('strong');
      val.textContent = fmtValue(v);
      const lab = document.createElement('span');
      lab.className = 'tt-label';
      lab.textContent = s.label;
      row.append(key, val, lab);
      return row;
    });
    this.tooltip.replaceChildren(title, ...items);
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    const left = px + 12 + tw > g.w ? px - 12 - tw : px + 12;
    this.tooltip.style.left = `${Math.max(0, left)}px`;
    this.tooltip.style.top = `${MARGIN.top}px`;
  }
}
