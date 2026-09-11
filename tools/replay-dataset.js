'use strict';

// CLI for the replay harness.
//
//   npm run replay                              # generate and replay in one step
//   npm run replay -- --seed incident-night --count 500
//   npm run replay -- --in out/dataset.json     # replay a dataset from disk
//   npm run replay -- --single-pass --quiet
//
// Writes a JSON report to --out (default out/report.json) and prints a
// summary. Makes no network calls. Every figure it produces describes
// synthetic data.

const fs = require('fs');
const path = require('path');

const { generateDataset, DEFAULTS: GEN_DEFAULTS } = require('./synth/generate');
const { replay } = require('./harness/replay');

const USAGE = `
Replay a synthetic alert dataset through the whole pipeline.

  node tools/replay-dataset.js [options]

  --in <path>         Replay this dataset instead of generating one.
  --seed <string>     Seed, when generating.           (default: ${GEN_DEFAULTS.seed})
  --count <n>         Base records, when generating.   (default: ${GEN_DEFAULTS.count})
  --window <minutes>  Simulated window, when generating. (default: ${GEN_DEFAULTS.windowMinutes})
  --noise <0..1>      Share of alerts shaped as noise. (default: ${GEN_DEFAULTS.noiseRatio})
  --bursts <0..1>     Share of alerts that repeat.     (default: ${GEN_DEFAULTS.burstRatio})
  --single-pass       One pass over the dataset instead of replaying the
                      2-minute poll with its overlapping 5-minute read window.
  --no-timings        Omit stage timings, so the report is fully deterministic.
  --raw-frequency     Do not age classifyPriority's 30-minute frequency window
                      against the simulated clock. See the report's notes.
  --out <path>        Output file.                     (default: out/report.json)
  --quiet             Print nothing but the output path.
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

function pct(n, of) {
  return of > 0 ? `${((n / of) * 100).toFixed(1)}%` : '—';
}

function bar(label, n, of) {
  const width = Math.round((of > 0 ? n / of : 0) * 28);
  return `  ${label.padEnd(12)} ${String(n).padStart(5)}  ${pct(n, of).padStart(6)}  ${'█'.repeat(width)}`;
}

function summarize(report) {
  const p = report.pipeline;
  const d = p.dropped_by_dedupe;
  const planted = Object.entries(d.planted).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';

  console.log(`\n\x1b[1mSYNTHETIC REPLAY\x1b[0m — seed "${report.dataset.seed}", ${report.mode} mode`);
  console.log('─'.repeat(64));
  console.log(`  ${p.ingested} generated records over ${report.dataset.params.windowMinutes} simulated minutes`);
  if (report.mode === 'poll') {
    console.log(`  ${report.polls.count} polls every ${report.polls.interval_seconds}s over a ${report.polls.read_window_seconds}s read window`);
    console.log(`  ${p.reads} reads, because the windows overlap on purpose`);
  }
  console.log(`\n  deduplication   ${p.after_dedupe} survived, ${d.total} dropped`);
  console.log(`                  planted duplicates: ${planted}`);
  console.log(`                  re-reads across polls: ${d.re_read}, incidental collisions: ${d.incidental}`);
  console.log(`\n  response gate   ${p.gate_passed} passed, ${p.gate_rejected} rejected`);
  for (const [reason, n] of Object.entries(p.gate_rejections).sort((a, b) => b[1] - a[1])) {
    console.log(`                  ${String(n).padStart(4)}  ${reason}`);
  }
  console.log('\n  priority        (of the ' + p.gate_passed + ' that passed the gate)');
  for (const band of ['P1', 'P2', 'P3', 'NOISE']) {
    console.log(bar(band, p.by_priority[band], p.gate_passed));
  }
  console.log(`\n  reached diagnosis   ${p.diagnosed}  (${pct(p.diagnosed, p.ingested)} of generated records)`);
  console.log(`  NOISE stopped early ${p.noise_stopped}  — no enrichment call, no model call`);
  console.log('\n  evidence reaching the prompt (of ' + p.diagnosed + ' diagnoses)');
  for (const [branch, n] of Object.entries(report.evidence.reached_prompt)) {
    const back = report.evidence.returned[branch];
    const extra = back > n ? `  (${back} branches returned data)` : '';
    console.log(bar(branch, n, p.diagnosed) + extra);
  }
  if (report.timings_ms) {
    const stages = Object.entries(report.timings_ms).filter(([k]) => k !== 'note');
    const total = stages.reduce((a, [, v]) => a + v, 0);
    console.log(`\n  stage timings   ${total.toFixed(1)} ms in-process, enrichment and model stubbed`);
    for (const [stage, ms] of stages) {
      console.log(`                  ${stage.padEnd(10)} ${ms.toFixed(2).padStart(8)} ms`);
    }
    console.log('                  These are not production latency. See the report notes.');
  }
  console.log('\n  \x1b[2mEvery figure above describes synthetic data generated by tools/synth.\x1b[0m');
  console.log('  \x1b[2mIt is a property of the generator and of the pipeline logic, not a\x1b[0m');
  console.log('  \x1b[2mmeasurement of production traffic.\x1b[0m\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE.trim());
    return;
  }

  let dataset;
  if (typeof opts.in === 'string') {
    dataset = JSON.parse(fs.readFileSync(opts.in, 'utf8'));
    if (!dataset.meta || dataset.meta.synthetic !== true) {
      console.error('✗ that file is not a dataset generated by tools/synth. The harness only replays synthetic data.');
      process.exit(1);
    }
  } else {
    try {
      dataset = generateDataset({
        seed: opts.seed !== undefined && opts.seed !== true ? String(opts.seed) : GEN_DEFAULTS.seed,
        count: num(opts.count, GEN_DEFAULTS.count),
        windowMinutes: num(opts.window, GEN_DEFAULTS.windowMinutes),
        noiseRatio: num(opts.noise, GEN_DEFAULTS.noiseRatio),
        burstRatio: num(opts.bursts, GEN_DEFAULTS.burstRatio),
      });
    } catch (e) {
      console.error('✗ ' + e.message);
      process.exit(1);
    }
  }

  const report = replay(dataset, {
    mode: opts['single-pass'] ? 'single' : 'poll',
    timings: !opts['no-timings'],
    ageFrequencyWindow: !opts['raw-frequency'],
  });

  const out = typeof opts.out === 'string' ? opts.out : path.join('out', 'report.json');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');

  if (!opts.quiet) summarize(report);
  console.log(`✓ ${out}`);
}

main();
