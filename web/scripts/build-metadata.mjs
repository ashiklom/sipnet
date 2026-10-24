#!/usr/bin/env node
// Extract parameter and output-variable descriptions/units from the SIPNET
// docs, for display in the web runner:
//   docs/parameters.md                 -> web/param-info.json
//   docs/user-guide/model-outputs.md   -> web/output-info.json
//
// Usage: node web/scripts/build-metadata.mjs   (run from anywhere)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '..');
const docsDir = path.resolve(webDir, '..', 'docs');

const SUPER = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
const toSuper = (s) => (/^[-\d]+$/.test(s) ? [...s].map((c) => SUPER[c]).join('') : `^${s}`);

// Rough LaTeX/markdown-to-plain-text for short unit and description strings
function plain(s) {
  return s
    .replace(/\\(text|textrm|mathrm|textit|mathit)\{([^{}]*)\}/g, '$2')
    .replace(/\\(overline|bar)\{([^{}]*)\}/g, '$2')
    .replace(/\\cdot/g, '·')
    .replace(/\\times/g, '×')
    .replace(/\^\{([^{}]*)\}/g, (_, e) => toSuper(e))
    .replace(/\^(-?\d)/g, (_, e) => toSuper(e))
    .replace(/_\{([^{}]*)\}/g, '$1')
    .replace(/_(\d)/g, '$1')
    .replace(/\\\*/g, '*')
    .replace(/\\[ ,;]/g, ' ')
    .replace(/\\[A-Za-z]+/g, '')
    .replace(/[{}$`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Yield { heading, cells: {header: value} } for every markdown table row
function* tableRows(text) {
  let heading = '';
  let header = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^#{2,4}\s+(.*?)\s*(\{#.*\})?\s*$/);
    if (h) {
      heading = h[1];
      header = null;
      continue;
    }
    if (!line.trim().startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (!header) {
      header = cells.map((c) => c.toLowerCase());
    } else if (!cells.every((c) => /^:?-+:?$/.test(c))) {
      yield { heading, cells: Object.fromEntries(header.map((k, i) => [k, cells[i] ?? ''])) };
    }
  }
}

function paramInfo() {
  const text = fs.readFileSync(path.join(docsDir, 'parameters.md'), 'utf8');
  const out = {};
  for (const { heading, cells } of tableRows(text)) {
    const name = cells['parameter name'] ?? cells.name;
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) continue;
    const description = plain(cells.definition || cells.description || '') || plain(cells.notes || '');
    out[name] = {
      group: heading.replace(/\s+parameters$/i, '').replace(/^./, (c) => c.toUpperCase()),
      description,
      units: plain(cells.units || ''),
    };
  }
  return out;
}

function outputInfo() {
  const text = fs.readFileSync(path.join(docsDir, 'user-guide', 'model-outputs.md'), 'utf8');
  const out = {};
  for (const { cells } of tableRows(text)) {
    const name = cells['output name'];
    if (!name || !/^\w+$/.test(name)) continue;
    out[name] = {
      description: plain((cells['definition / notes'] || '').replace(/\[\^\d+\]/g, '')),
      units: plain(cells.units || '').replace(/^\((.*)\)$/, '$1'),
    };
  }
  return out;
}

const write = (name, obj) => {
  fs.writeFileSync(path.join(webDir, name), JSON.stringify(obj, null, 1) + '\n');
  console.log(`wrote web/${name} (${Object.keys(obj).length} entries)`);
};
write('param-info.json', paramInfo());
write('output-info.json', outputInfo());
