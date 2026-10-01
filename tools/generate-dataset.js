'use strict';

// CLI for the synthetic alert generator.
//
//   npm run dataset
//   npm run dataset -- --seed incident-night --count 500 --window 180 --noise 0.4
//   npm run dataset -- --print 3        # write nothing, show three records
//
// Writes a JSON dataset to --out (default out/dataset.json). The file is
// regenerable from its seed, so out/ is gitignored and nothing generated is
// committed.

const fs = require('fs');
const path = require('path');

const { generateDataset, DEFAULTS } = require('./synth/generate');

const USAGE = `
Generate a synthetic Datadog alert dataset.

  node tools/generate-dataset.js [options]

  --seed <string>     Seed. Same seed, same dataset.    (default: ${DEFAULTS.seed})
  --count <n>         Base records, before bursts.      (default: ${DEFAULTS.count})
  --window <minutes>  Simulated time window.            (default: ${DEFAULTS.windowMinutes})
  --noise <0..1>      Share of alerts shaped as noise.  (default: ${DEFAULTS.noiseRatio})
  --chatter <0..1>    Share of records that are not alerts. (default: ${DEFAULTS.chatterRatio})
  --bursts <0..1>     Share of alerts that repeat.      (default: ${DEFAULTS.burstRatio})
  --burst-size <a,b>  Repeats per burst.                (default: ${DEFAULTS.burstSize.join(',')})
  --types <a,b,...>   Restrict to these alert types.    (default: all 12)
  --out <path>        Output file.                      (default: out/dataset.json)
  --print [n]         Print n records to stdout instead of writing a file.
  --help

All output is synthetic. See "Note on data" in the README.
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !next.startsWith('--');
    opts[key] = hasValue ? (i++, next) : true;
  }
  return opts;
}

function num(v, fallback) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE.trim());
    return;
  }

  const params = {
    seed: opts.seed !== undefined && opts.seed !== true ? String(opts.seed) : DEFAULTS.seed,
    count: num(opts.count, DEFAULTS.count),
    windowMinutes: num(opts.window, DEFAULTS.windowMinutes),
    noiseRatio: num(opts.noise, DEFAULTS.noiseRatio),
    chatterRatio: num(opts.chatter, DEFAULTS.chatterRatio),
    burstRatio: num(opts.bursts, DEFAULTS.burstRatio),
  };

  if (typeof opts['burst-size'] === 'string') {
    const parts = opts['burst-size'].split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite);
    if (parts.length === 2) params.burstSize = parts;
  }
  if (typeof opts.types === 'string') {
    params.types = opts.types.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  let dataset;
  try {
    dataset = generateDataset(params);
  } catch (e) {
    console.error('✗ ' + e.message);
    process.exit(1);
  }

  const c = dataset.meta.counts;

  if (opts.print) {
    const n = opts.print === true ? 1 : Math.max(1, parseInt(opts.print, 10) || 1);
    dataset.records.slice(0, n).forEach((r, i) => {
      console.log(`\n─── record ${i + 1} — ${r.synth.id} (${r.synth.intent}) ${'─'.repeat(30)}`);
      console.log(`ts ${r.ts}` + (r.subtype ? `   subtype ${r.subtype}` : ''));
      console.log(r.mensaje);
    });
    console.log();
    return;
  }

  const out = typeof opts.out === 'string' ? opts.out : path.join('out', 'dataset.json');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(dataset, null, 2) + '\n');

  const types = Object.keys(c.by_type).length;
  console.log(`✓ ${out} — SYNTHETIC DATA, seed "${dataset.meta.seed}"`);
  console.log(`  ${c.records} records over ${dataset.meta.params.windowMinutes} simulated minutes, ${types} alert types`);
  console.log(`  intents      ${JSON.stringify(c.by_intent)}`);
  console.log(`  states       ${JSON.stringify(c.by_state)}`);
  console.log(`  duplicates   ${c.bursts} bursts, ${JSON.stringify(c.by_duplicate_kind)}`);
  console.log('  Regenerate with the same seed to get this file back byte for byte.');
}

main();
