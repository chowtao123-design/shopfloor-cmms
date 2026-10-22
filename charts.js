/* Hand-written SVG chart helpers for the Statistics page (SPEC-v3.md
   section 7). Pure functions only: they return SVG markup strings so the
   tests can inspect ticks, titles and empty states with no DOM. app.js
   mounts the markup with DOMParser + document.importNode (never innerHTML,
   SPEC-v3.md section 11). Every colour comes from a CSS variable
   (--chart-c1…c6, --chart-text, --chart-grid) defined for light and dark
   themes in styles.css. All label text goes through escapeSVGText. */

export function escapeSVGText(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Trim a number for display: 3 -> "3", 2.5 -> "2.5", 0.25 -> "0.25". */
export function formatTickValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.round(number * 100) / 100);
}

/**
 * Tick maths: tick values from 0 up to (and including) a "nice" ceiling of
 * `max`, spread over at most `targetCount` steps. The step is the smallest
 * ladder value (1 / 2 / 2.5 / 5 / 10 x 10^k) at or above max / targetCount,
 * so every axis gets round, readable tick labels. Returns [0] for a missing
 * or non-positive max.
 */
export function niceTicks(max, targetCount = 4) {
  const value = Number(max);
  if (!Number.isFinite(value) || value <= 0) return [0];
  const count = Math.max(1, Math.floor(targetCount) || 4);
  const LADDER = [1, 2, 2.5, 5, 10];
  const raw = value / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const err = raw / power;
  const index = Math.max(0, LADDER.findIndex((step) => step >= err - 1e-9));
  const step = LADDER[index] * power;
  const steps = Math.ceil(value / step - 1e-9);
  const ticks = [];
  for (let tick = 0; tick <= steps; tick += 1) {
    ticks.push(Math.round(tick * step * 1e6) / 1e6);
  }
  return ticks;
}

/* ----- shared bits ----- */

const FONT_AXIS = 'font-size="11" fill="var(--chart-text)"';
const FONT_LABEL = 'font-size="12" font-weight="650" fill="var(--chart-text)"';
const FONT_EMPTY = 'font-size="14" fill="var(--chart-text)"';

function textNode(x, y, content, attrs = `${FONT_AXIS} text-anchor="start"`) {
  return `<text x="${x}" y="${y}" ${attrs}>${escapeSVGText(content)}</text>`;
}

function truncateLabel(label, max) {
  const text = String(label === null || label === undefined ? '' : label).trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
}

function valueOf(row) {
  return Math.max(0, Number(row && row.value) || 0);
}

function emptyChart(title) {
  return `<svg class="chart-svg" viewBox="0 0 640 160" role="img" aria-label="${
    escapeSVGText(title)
  }: no data"><g><title>No data yet</title>${textNode(320, 84, 'No data yet', FONT_EMPTY)}</g></svg>`;
}

/**
 * Vertical bar chart. `rows` is a list of {label, value} sorted as the caller
 * wants it shown. Units (e.g. "h" for hours) land in bar titles and value
 * labels. Each bar carries a <title> with the full label and value so the
 * chart is legible from a screen reader or a long press.
 */
export function barChart(rows, { title = 'Bar chart', unit = '' } = {}) {
  const data = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (data.length === 0) return emptyChart(title);
  const width = 640;
  const height = 320;
  const margins = { top: 12, right: 12, bottom: 48, left: 48 };
  const plotWidth = width - margins.left - margins.right;
  const plotHeight = height - margins.top - margins.bottom;
  const ticks = niceTicks(Math.max(...data.map(valueOf)), 4);
  const domainMax = Math.max(...ticks, 1);
  const baseline = margins.top + plotHeight;
  const band = plotWidth / data.length;
  const barWidth = Math.min(band * 0.62, 64);
  const parts = [];
  for (const tick of ticks) {
    const y = baseline - (tick / domainMax) * plotHeight;
    parts.push(
      `<line x1="${margins.left}" y1="${y.toFixed(2)}" x2="${width - margins.right}" y2="${y.toFixed(2)}" stroke="var(--chart-grid)" stroke-width="1"/>`,
    );
    parts.push(textNode(margins.left - 8, y + 4, formatTickValue(tick), `${FONT_AXIS} text-anchor="end"`));
  }
  data.forEach((row, index) => {
    const value = valueOf(row);
    const barHeight = Math.max(value > 0 ? 3 : 0, (value / domainMax) * plotHeight);
    const xCenter = margins.left + band * index + band / 2;
    const barX = xCenter - barWidth / 2;
    const barY = baseline - barHeight;
    parts.push(
      `<g><title>${escapeSVGText(row.label)}: ${formatTickValue(value)}${escapeSVGText(unit)}</title>` +
        `<rect x="${barX.toFixed(2)}" y="${barY.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" rx="4" fill="var(--chart-c1)"/>` +
        `${textNode(xCenter, baseline + 18, truncateLabel(row.label, 10), `${FONT_AXIS} text-anchor="middle"`)}${textNode(xCenter, barY - 6, `${formatTickValue(value)}${unit}`, `${FONT_LABEL} text-anchor="middle"`)}` +
        `</g>`,
    );
  });
  parts.push(
    `<line x1="${margins.left}" y1="${baseline}" x2="${width - margins.right}" y2="${baseline}" stroke="var(--chart-grid)" stroke-width="1.5"/>`,
  );
  const summary = data
    .map((row) => `${escapeSVGText(row.label)} ${formatTickValue(valueOf(row))}${escapeSVGText(unit)}`)
    .join('; ');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSVGText(title)}: ${summary}">${parts.join('')}</svg>`;
}

/**
 * Horizontal bar chart for ranked rows ({label, value}), longest bar at the
 * top in the order given. Truncates long labels for the visual (the full
 * label is in the bar title) and prints the value at the end of each bar.
 */
export function horizontalBarChart(rows, { title = 'Bar chart', unit = '' } = {}) {
  const data = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (data.length === 0) return emptyChart(title);
  const rowHeight = 34;
  const width = 640;
  const margins = { top: 10, right: 12, bottom: 26, left: 150 };
  const plotWidth = width - margins.left - margins.right;
  const height = margins.top + data.length * rowHeight + margins.bottom;
  const ticks = niceTicks(Math.max(...data.map(valueOf)), 4);
  const domainMax = Math.max(...ticks, 1);
  const parts = [];
  for (const tick of ticks) {
    const x = margins.left + (tick / domainMax) * plotWidth;
    parts.push(
      `<line x1="${x.toFixed(2)}" y1="${margins.top}" x2="${x.toFixed(2)}" y2="${height - margins.bottom}" stroke="var(--chart-grid)" stroke-width="1"/>`,
    );
    parts.push(
      textNode(x.toFixed(2), height - margins.bottom + 16, formatTickValue(tick), `${FONT_AXIS} text-anchor="middle"`),
    );
  }
  data.forEach((row, index) => {
    const value = valueOf(row);
    const barLength = Math.max(value > 0 ? 3 : 0, (value / domainMax) * plotWidth);
    const y = margins.top + index * rowHeight;
    const barY = y + (rowHeight - 20) / 2;
    parts.push(
      `<g><title>${escapeSVGText(row.label)}: ${formatTickValue(value)}${escapeSVGText(unit)}</title>` +
        `${textNode(margins.left - 8, y + 15, truncateLabel(row.label, 18), `${FONT_AXIS} text-anchor="end"`)}${textNode(margins.left + barLength + 6, y + 15, `${formatTickValue(value)}${unit}`, FONT_LABEL)}` +
        `<rect x="${margins.left}" y="${barY.toFixed(2)}" width="${barLength.toFixed(2)}" height="20" rx="4" fill="var(--chart-c${Math.min(index, 5) + 1})"/>` +
        `</g>`,
    );
  });
  const summary = data
    .map((row) => `${escapeSVGText(row.label)} ${formatTickValue(valueOf(row))}${escapeSVGText(unit)}`)
    .join('; ');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSVGText(title)}: ${summary}">${parts.join('')}</svg>`;
}

/**
 * Multi-line chart with a legend. `series` is a list of
 * {name, values: [{label, value}]} where every series shares the same x
 * buckets (the Statistics page sends created/completed per week). Each point
 * draws a circle with a <title>; the legend names each line.
 */
export function lineChart(series, { title = 'Line chart', unit = '' } = {}) {
  const lines = (Array.isArray(series) ? series : []).filter(
    (entry) => entry && Array.isArray(entry.values) && entry.values.length > 0,
  );
  if (lines.length === 0) return emptyChart(title);
  const width = 640;
  const height = 300;
  const margins = { top: 34, right: 14, bottom: 44, left: 48 };
  const plotWidth = width - margins.left - margins.right;
  const plotHeight = height - margins.top - margins.bottom;
  const buckets = lines[0].values.length;
  const peak = Math.max(
    1,
    ...lines.flatMap((entry) => entry.values.map((point) => Math.max(0, Number(point && point.value) || 0))),
  );
  const ticks = niceTicks(peak, 4);
  const domainMax = Math.max(...ticks, 1);
  const baseline = margins.top + plotHeight;
  const parts = [];
  for (const tick of ticks) {
    const y = baseline - (tick / domainMax) * plotHeight;
    parts.push(
      `<line x1="${margins.left}" y1="${y.toFixed(2)}" x2="${width - margins.right}" y2="${y.toFixed(2)}" stroke="var(--chart-grid)" stroke-width="1"/>`,
    );
    parts.push(textNode(margins.left - 8, y + 4, formatTickValue(tick), `${FONT_AXIS} text-anchor="end"`));
  }
  const xOf = (index) => margins.left + (buckets === 1 ? plotWidth / 2 : (index / (buckets - 1)) * plotWidth);
  const yOf = (value) => baseline - (Math.max(0, value) / domainMax) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(buckets / 8));
  for (let index = 0; index < buckets; index += 1) {
    if (index % labelEvery !== 0 && index !== buckets - 1) continue;
    parts.push(
      textNode(xOf(index), baseline + 18, truncateLabel(lines[0].values[index].label, 12), `${FONT_AXIS} text-anchor="middle"`),
    );
  }
  lines.forEach((entry, seriesIndex) => {
    const color = `var(--chart-c${Math.min(seriesIndex, 5) + 1})`;
    const points = entry.values.map((point, index) => {
      const value = Math.max(0, Number(point && point.value) || 0);
      return `<circle cx="${xOf(index).toFixed(2)}" cy="${yOf(value).toFixed(2)}" r="4" fill="${color}"><title>${escapeSVGText(point.label)}: ${formatTickValue(value)}${escapeSVGText(unit)}</title></circle>`;
    });
    const path = entry.values
      .map((point, index) => {
        const value = Math.max(0, Number(point && point.value) || 0);
        return `${xOf(index).toFixed(2)},${yOf(value).toFixed(2)}`;
      })
      .join(' ');
    parts.push(
      `<polyline points="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
      ...points,
    );
  });
  let legendX = margins.left;
  lines.forEach((entry, seriesIndex) => {
    const color = `var(--chart-c${Math.min(seriesIndex, 5) + 1})`;
    parts.push(
      `<line x1="${legendX}" y1="16" x2="${legendX + 18}" y2="16" stroke="${color}" stroke-width="3" stroke-linecap="round"/>` +
        textNode(legendX + 24, 20, entry.name, FONT_AXIS),
    );
    legendX += 24 + entry.name.length * 6.6 + 24;
  });
  parts.push(
    `<line x1="${margins.left}" y1="${baseline}" x2="${width - margins.right}" y2="${baseline}" stroke="var(--chart-grid)" stroke-width="1.5"/>`,
  );
  const summary = lines
    .map((entry) => `${escapeSVGText(entry.name)} ${entry.values.reduce((sum, point) => sum + Math.max(0, Number(point && point.value) || 0), 0)}${escapeSVGText(unit)}`)
    .join('; ');
  return `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeSVGText(title)}: ${summary}">${parts.join('')}</svg>`;
}