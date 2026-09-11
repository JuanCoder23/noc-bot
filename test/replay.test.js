'use strict';

// Tests for the replay harness, tools/harness/replay.js.
//
// The harness's job is to schedule the stages in src/ and count what happens,
// so most of these check that the counting is sound — a report whose books do
// not balance is worse than no report, because its figures look authoritative.

const { generateDataset } = require('../tools/synth/generate');
const { replay, POLL_INTERVAL_MS, READ_WINDOW_MS } = require('../tools/harness/replay');
const { STUB_NOTICE } = require('../tools/harness/stubs');

const SEED = 'replay-test';
const dataset = generateDataset({ seed: SEED, count: 150 });
const report = replay(dataset, { timings: false });
const single = replay(dataset, { mode: 'single', timings: false });

module.exports = function (t) {
  // ── the books balance ─────────────────────────────────────────────────
  const p = report.pipeline;
  t.eq(p.reads, p.after_dedupe + p.dropped_by_dedupe.total,
    'every record read is either deduplicated away or survives');
  t.eq(p.after_dedupe, p.gate_passed + p.gate_rejected,
    'every survivor is either answered or rejected by the gate');

  const bandTotal = Object.values(p.by_priority).reduce((a, b) => a + b, 0);
  t.eq(bandTotal, p.gate_passed, 'every answered alert lands in exactly one priority band');

  t.eq(p.enriched, p.gate_passed - p.by_priority.NOISE,
    'everything that is not NOISE is enriched, and nothing else is');
  t.eq(p.noise_stopped, p.by_priority.NOISE, 'NOISE stops before enrichment');
  t.eq(p.prompted, p.enriched, 'every enriched alert gets a prompt');
  t.eq(p.diagnosed, p.prompted, 'every prompt reaches the model stub');
  t.eq(p.messaged, p.diagnosed, 'every diagnosis renders a message');

  const dropTotal = Object.values(p.dropped_by_dedupe.planted).reduce((a, b) => a + b, 0)
    + p.dropped_by_dedupe.re_read + p.dropped_by_dedupe.incidental;
  t.eq(dropTotal, p.dropped_by_dedupe.total, 'every drop is attributed to exactly one cause');

  const rejectTotal = Object.values(p.gate_rejections).reduce((a, b) => a + b, 0);
  t.eq(rejectTotal, p.gate_rejected, 'every gate rejection is attributed to exactly one condition');

  const byType = Object.values(report.by_alert_type);
  t.eq(byType.reduce((a, s) => a + s.gate_passed, 0), p.gate_passed,
    'the per-type breakdown adds up to the totals');
  t.eq(byType.reduce((a, s) => a + s.diagnosed, 0), p.diagnosed, 'and so do its diagnosis counts');

  // ── determinism ───────────────────────────────────────────────────────
  const again = replay(generateDataset({ seed: SEED, count: 150 }), { timings: false });
  t.eq(JSON.stringify(again), JSON.stringify(report),
    'the whole report is reproducible from the seed, timings excluded');

  t.ok(replay(dataset, { timings: true }).timings_ms !== undefined, 'timings are reported when asked for');
  t.ok(report.timings_ms === undefined, 'and omitted when not, which is what makes the rest snapshot-stable');

  // ── poll mode really replays the trigger ──────────────────────────────
  t.eq(report.mode, 'poll', 'poll is the default mode');
  t.eq(report.polls.interval_seconds, POLL_INTERVAL_MS / 1000, 'polling every 2 minutes');
  t.eq(report.polls.read_window_seconds, READ_WINDOW_MS / 1000, 'over a 5-minute read window');

  // The overlap is the whole point: it is what turns an at-least-once read
  // into single-response behaviour, and what makes dedup load-bearing.
  t.ok(p.reads > p.ingested, 'the overlapping windows read most records more than once');
  t.ok(p.dropped_by_dedupe.re_read > 0, 'and deduplication catches those re-reads across polls');

  const everyRecordRead = report.polls.detail.reduce((a, d) => a + d.read, 0);
  t.eq(everyRecordRead, p.reads, 'the per-poll detail adds up to the read total');

  t.eq(single.mode, 'single', 'single-pass mode is available');
  t.eq(single.polls.count, 1, 'and makes exactly one pass');
  t.eq(single.pipeline.reads, single.pipeline.ingested, 'reading each record exactly once');
  t.ok(single.pipeline.dropped_by_dedupe.re_read === 0,
    'so nothing is ever a re-read, which is what poll mode exists to exercise');

  // ── coverage of the pipeline's branches ───────────────────────────────
  t.ok(p.gate_rejections.recovered > 0, 'recoveries are rejected, never answered');
  t.ok(p.gate_rejections.already_answered > 0, 'and re-reads of an answered alert are suppressed');
  t.ok(p.gate_rejections.slack_subtype > 0, 'an edited Slack message is rejected on its subtype');
  t.ok(p.by_priority.P1 > 0 && p.by_priority.P2 > 0 && p.by_priority.P3 > 0 && p.by_priority.NOISE > 0,
    'all four priority bands are reached');
  t.ok(Object.keys(report.by_alert_type).length >= 12, 'all 12 alert types reach the pipeline');

  // The degradation ladder: diagnoses are produced on partial evidence, which
  // is the behaviour the neverError settings in the workflow buy.
  const e = report.evidence_available;
  t.ok(e.metrics > 0 && e.metrics < p.diagnosed,
    'some diagnoses have metrics and some do not, so the degraded path is exercised');
  t.ok(e.events < p.diagnosed, 'and some are produced with no deploy correlation at all');

  // ── the fail-safe cap, visible in the output ──────────────────────────
  // NOISE is only reachable from WARN: classifyPriority caps TRIGGERED and
  // RE-TRIGGERED at 69, under the NOISE threshold. If this ever fails, either
  // the cap moved or the bands did, and the README's claim about the trade is
  // no longer true.
  // With noiseRatio 0 every generated alert is TRIGGERED or RE-TRIGGERED, so
  // the cap applies to all of them — including the ones bursting repeatedly,
  // which is the case the cap exists for.
  const allFiring = replay(
    generateDataset({ seed: SEED, count: 150, noiseRatio: 0, chatterRatio: 0, burstRatio: 0.6 }),
    { timings: false }
  );
  t.ok(allFiring.pipeline.gate_passed > 0, 'a dataset of firing alerts reaches the classifier');
  t.eq(allFiring.pipeline.by_priority.NOISE, 0,
    'and not one of them is classified NOISE, however often it repeats');
  t.eq(allFiring.pipeline.diagnosed, allFiring.pipeline.gate_passed,
    'so every one of them reaches diagnosis');

  // The other half of the trade: noise-shaped WARN alerts do get silenced.
  const allWarn = replay(
    generateDataset({ seed: SEED, count: 150, noiseRatio: 1, chatterRatio: 0 }),
    { timings: false }
  );
  t.ok(allWarn.pipeline.by_priority.NOISE > 0, 'while WARN alerts barely over threshold are');

  // ── marking ───────────────────────────────────────────────────────────
  t.ok(report.synthetic === true, 'the report declares itself synthetic');
  t.ok(/SYNTHETIC DATA/.test(report.warning), 'and carries the dataset warning');
  t.ok(report.notes.length >= 4, 'and the notes that keep its figures from being misread');
  t.ok(report.notes.some((n) => /not a measurement of production/.test(n)),
    'including that nothing here measures production');
  t.ok(report.notes.some((n) => /NOISE band is only reachable from a WARN/.test(n)),
    'and that the band split is not a tuning result');
  t.ok(report.notes.some((n) => /not production latency|dominated by/.test(n)),
    'and that the timings are not latency');
  t.ok(report.notes.some((n) => /Date\.now\(\)/.test(n)),
    'and how the frequency window is handled against a simulated clock');

  // ── the frequency-window correction ───────────────────────────────────
  // classifyPriority reads the real clock, so without the correction nothing
  // ages out of its 30-minute window during a replay that takes milliseconds.
  const raw = replay(dataset, { timings: false, ageFrequencyWindow: false });
  t.ok(raw.pipeline.by_priority.NOISE >= report.pipeline.by_priority.NOISE,
    'leaving the frequency window unaged scores at least as much as NOISE');
  t.ok(raw.notes.some((n) => /ageFrequencyWindow is off/.test(n)),
    'and the report says which behaviour produced its numbers');

  // ── the rendered message is still marked as a stub ────────────────────
  // Nothing in the harness should be able to strip the notice on the way out.
  t.ok(STUB_NOTICE.length > 0 && /not a model output/.test(STUB_NOTICE),
    'the model stub notice says it is not a model output');
};
