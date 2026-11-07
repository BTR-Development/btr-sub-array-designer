#!/usr/bin/env node
/**
 * Add a subwoofer to the BTR library from a JSON record.
 *
 *   node scripts/add-speaker.mjs record.json
 *   node scripts/add-speaker.mjs record.json --force   # overwrite existing id
 *   cat record.json | node scripts/add-speaker.mjs -
 *   node scripts/add-speaker.mjs --template            # print a blank record
 *
 * Validation is deliberately strict: a record without a source URL, a retrieval
 * date, or an explicit null for an unpublished dimension is rejected. The point
 * of the library is that every number can be traced back to the manufacturer.
 *
 * The source may be a DATASHEET (PDF) or a product page — `sourceType` records
 * which, and `sourcePage` the page it was read from. Datasheets are preferred:
 * versioned, explicit about the basis of a max-SPL figure, and stable under
 * their URL. Record the figures, cite the document, never vendor the PDF.
 *
 * This never produces quality A/B data. Acoustic prediction for anything added
 * here is the analytical omni / gradient-cardioid model — see README,
 * "Acoustic model assumptions".
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTRA = resolve(HERE, '../src/speakers/extra.json');

const TEMPLATE = {
  id: 'manufacturer-model-slug',
  manufacturer: 'Manufacturer',
  model: 'MODEL',
  widthMm: null,
  heightMm: null,
  depthMm: null,
  weightKg: null,
  type: 'omnidirectional',
  construction: '2 x 18" bass reflex',
  radiation: 'omnidirectional',
  maxSpl: null,
  minHz: null,
  maxHz: null,
  cardioidVariant: false,
  sourceUrl: 'https://example.com/datasheet.pdf',
  sourceType: 'manufacturer-datasheet',
  sourcePage: null,
  retrieved: new Date().toISOString().slice(0, 10),
  note: 'Exact wording of the spec line the numbers came from.',
};

const TYPES = ['omnidirectional', 'cardioid', 'infra', 'other'];

const SOURCE_KINDS = ['manufacturer-datasheet', 'manufacturer-website'];

function validate(o) {
  const errs = [];
  for (const k of ['id', 'manufacturer', 'model', 'sourceUrl', 'retrieved']) {
    if (typeof o[k] !== 'string' || !o[k].trim()) errs.push(`"${k}" is required (non-empty string)`);
  }
  if (!TYPES.includes(o.type)) errs.push(`"type" must be one of ${TYPES.join(' | ')}`);
  for (const k of ['widthMm', 'heightMm', 'depthMm']) {
    if (!(k in o)) {
      errs.push(`"${k}" must be present — use null if the manufacturer does not publish it. Never guess.`);
    } else if (o[k] !== null && (typeof o[k] !== 'number' || o[k] <= 20 || o[k] > 4000)) {
      errs.push(`"${k}" must be null or a plausible millimetre value (20–4000), got ${JSON.stringify(o[k])}`);
    }
  }
  if (o.maxSpl != null && (typeof o.maxSpl !== 'number' || o.maxSpl < 80 || o.maxSpl > 170)) {
    errs.push('"maxSpl" must be null or 80–170 (dB @ 1 m)');
  }
  for (const k of ['minHz', 'maxHz']) {
    if (o[k] != null && (typeof o[k] !== 'number' || o[k] <= 0 || o[k] > 2000)) {
      errs.push(`"${k}" must be null or a positive frequency below 2000 Hz`);
    }
  }
  if (typeof o.sourceUrl === 'string' && !/^https?:\/\//.test(o.sourceUrl)) {
    errs.push('"sourceUrl" must be an http(s) URL pointing at the datasheet or page you read');
  }
  if (o.sourceType !== undefined && !SOURCE_KINDS.includes(o.sourceType)) {
    errs.push(`"sourceType" must be one of ${SOURCE_KINDS.join(' | ')}`);
  }
  if (o.sourcePage != null && (typeof o.sourcePage !== 'number' || o.sourcePage < 1)) {
    errs.push('"sourcePage" must be null or a page number of 1 or more');
  }
  if (typeof o.retrieved === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(o.retrieved)) {
    errs.push('"retrieved" must be an ISO date, YYYY-MM-DD');
  }
  if (o.widthMm === null && o.heightMm === null && o.depthMm === null) {
    errs.push('at least one dimension must be confirmed, otherwise the entry carries no useful geometry');
  }
  // Same gate as validateRecord in src/speakers/loadExtra.ts: the two-element
  // separation and its d/c delay ARE the cabinet depth, so a cardioid without a
  // published depth cannot be modelled without inventing one.
  if ((o.type === 'cardioid' || o.cardioidVariant) && o.depthMm == null) {
    errs.push('"depthMm" must be published for a cardioid or a cardioidVariant — it is the element separation');
  }
  return errs;
}

function readInput(arg) {
  if (arg === '-') return readFileSync(0, 'utf8');
  return readFileSync(resolve(process.cwd(), arg), 'utf8');
}

const args = process.argv.slice(2);
if (args.includes('--template')) {
  console.log(JSON.stringify(TEMPLATE, null, 2));
  process.exit(0);
}
if (!args.length || args[0].startsWith('--')) {
  console.error('usage: node scripts/add-speaker.mjs <record.json | -> [--force]\n       node scripts/add-speaker.mjs --template');
  process.exit(2);
}

const force = args.includes('--force');
let parsed;
try {
  parsed = JSON.parse(readInput(args[0]));
} catch (e) {
  console.error(`Could not read/parse input: ${e.message}`);
  process.exit(1);
}

const records = Array.isArray(parsed) ? parsed : [parsed];
const existing = JSON.parse(readFileSync(EXTRA, 'utf8'));
const byId = new Map(existing.map((r) => [r.id, r]));

let failed = 0;
let added = 0;
let replaced = 0;

for (const rec of records) {
  const errs = validate(rec);
  if (errs.length) {
    console.error(`✗ ${rec?.id ?? '<no id>'}`);
    for (const e of errs) console.error(`    ${e}`);
    failed++;
    continue;
  }
  if (byId.has(rec.id)) {
    if (!force) {
      console.error(`✗ ${rec.id}: already present — pass --force to overwrite`);
      failed++;
      continue;
    }
    replaced++;
  } else {
    added++;
  }
  byId.set(rec.id, rec);
}

if (failed) {
  console.error(`\n${failed} record(s) rejected — nothing was written.`);
  process.exit(1);
}

const out = [...byId.values()].sort((a, b) =>
  `${a.manufacturer} ${a.model}`.localeCompare(`${b.manufacturer} ${b.model}`),
);
writeFileSync(EXTRA, `${JSON.stringify(out, null, 2)}\n`);
console.log(`✓ ${added} added, ${replaced} replaced. extra.json now holds ${out.length} record(s).`);
console.log('  Run "npm test" and reload the app to see them in the library.');
