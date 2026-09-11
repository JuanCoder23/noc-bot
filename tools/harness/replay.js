'use strict';

// Replays a synthetic dataset through the whole pipeline and reports what
// happened to it:
//
//   dedupe -> response gate -> classify -> enrich -> prompt -> model -> message
//
// Every stage is the code from src/, which is the code extracted from the
// workflow's own nodes. Nothing is reimplemented here; this file schedules the
// stages, stubs the two calls that leave the process, and counts.
//
// EVERY NUMBER THIS PRODUCES DESCRIBES SYNTHETIC DATA. It is a property of the
// generator and of the pipeline's logic, not a measurement of anything that
// ran in production. The report says so in its own `warning` field, and any
// figure quoted from it has to carry that with it.

const { dedupe, decide } = require('../../src/dedupe');
const { classifyPriority } = require('../../src/classifyPriority');
const { buildEnrichedContext, buildClaudePrompt } = require('../../src/enrich');
const { buildSlackMessage } = require('../../src/formatMessage');
const { stubEnrichment, stubDiagnosis } = require('./stubs');

// The real trigger's numbers, from docs/architecture.md: a schedule trigger
// every 2 minutes reading Slack history with oldest = now - 5 minutes. The
// deliberate overlap means every message is read two or three times, which is
// what makes the deduplication layer load-bearing rather than a nicety.
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const READ_WINDOW_MS = 5 * 60 * 1000;

// The window classifyPriority counts firing frequency over.
const FREQUENCY_WINDOW_MS = 30 * 60 * 1000;

const DEFAULTS = { mode: 'poll', timings: true, ageFrequencyWindow: true };

function ns() { return process.hrtime.bigint(); }

/** Accumulates elapsed nanoseconds per pipeline stage. */
function makeClock() {
  const totals = {};
  return {
    totals,
    time(stage, fn) {
      const t0 = ns();
      const out = fn();
      totals[stage] = (totals[stage] || 0n) + (ns() - t0);
      return out;
    },
    toMs() {
      const out = {};
      for (const [k, v] of Object.entries(totals)) out[k] = Number(v) / 1e6;
      return out;
    },
  };
}

function bump(obj, key, by) {
  if (key === null || key === undefined) return;
  obj[key] = (obj[key] || 0) + (by === undefined ? 1 : by);
}

/**
 * Why the response gate rejected an item.
 *
 * Derived from what `decide` already returns rather than by re-evaluating the
 * gate, so this cannot drift from it. The gate has exactly four conditions —
 * state, alert_type, subtype, and the composite key — so once the first three
 * are ruled out the fourth is the only one left.
 */
function rejectionReason(item) {
  const state = item.parsed.state;
  if (state !== 'WARN' && state !== 'TRIGGERED' && state !== 'RE-TRIGGERED') {
    return state === 'RECOVERED' ? 'recovered' : 'no_state';
  }
  if (item.parsed.alert_type === null) return 'unparseable';
  if (item.subtype) return 'slack_subtype';
  return 'already_answered';
}

/** The poll schedule: read windows over the dataset's simulated timeline. */
function buildPolls(dataset, mode) {
  const startMs = dataset.meta.params.startTime;
  const endMs = startMs + dataset.meta.params.windowMinutes * 60 * 1000;

  if (mode === 'single') {
    return [{ at: endMs + READ_WINDOW_MS, from: startMs - 1, to: endMs + READ_WINDOW_MS }];
  }

  const polls = [];
  // Run past the end of the window so the last alerts get read at all.
  for (let at = startMs; at <= endMs + READ_WINDOW_MS; at += POLL_INTERVAL_MS) {
    polls.push({ at, from: at - READ_WINDOW_MS, to: at });
  }
  return polls;
}

function replay(dataset, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };
  const seed = dataset.meta.seed;
  const clock = makeClock();

  // The n8n per-workflow static data, shared across polls. This is the object
  // that makes deduplication work across runs, and losing it is what the
  // README means by "it does not survive a re-import".
  const state = {};

  // classifyPriority reads Date.now() directly for its 30-minute frequency
  // sweep, so it cannot see the simulated clock. Left alone, a two-hour replay
  // finishes in milliseconds of real time and nothing ever ages out: a
  // resource that fired across the whole window accumulates every fire, which
  // inflates the noise score and pushes WARN alerts into the NOISE band that
  // production would have scored lower.
  //
  // The harness therefore keeps its own record of when each frequency key was
  // last seen in SIMULATED time and applies the node's own rule — drop
  // anything older than 30 minutes — at each poll boundary. Same rule, a clock
  // that actually moves. Set ageFrequencyWindow: false to see the uncorrected
  // behaviour; the report says which was used either way.
  const simulatedLastSeen = {};

  const records = dataset.records.slice().sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  const polls = buildPolls(dataset, opts.mode);

  const counts = {
    reads: 0,
    after_dedupe: 0,
    gate_passed: 0,
    gate_rejected: 0,
    noise_stopped: 0,
    enriched: 0,
    prompted: 0,
    diagnosed: 0,
    messaged: 0,
  };
  const droppedByDedupe = { total: 0, planted: {}, re_read: 0, incidental: 0 };
  const gateRejections = {};
  const byPriority = { P1: 0, P2: 0, P3: 0, NOISE: 0 };
  const evidence = { metrics: 0, logs: 0, events: 0, correlation: 0, aws_health: 0 };
  const byType = {};
  const seenTsInEarlierPolls = new Set();
  const pollDetail = [];

  for (const poll of polls) {
    const read = records.filter((r) => {
      const t = parseFloat(r.ts) * 1000;
      return t > poll.from && t <= poll.to;
    });
    if (read.length === 0) {
      pollDetail.push({ at: new Date(poll.at).toISOString(), read: 0, survived: 0, gate_passed: 0 });
      continue;
    }
    counts.reads += read.length;

    if (opts.ageFrequencyWindow && state.recentFires) {
      for (const key of Object.keys(state.recentFires)) {
        if (poll.at - (simulatedLastSeen[key] || 0) > FREQUENCY_WINDOW_MS) {
          delete state.recentFires[key];
          delete simulatedLastSeen[key];
        }
      }
    }

    const survivors = clock.time('dedupe', () => dedupe(read, state, poll.at));
    counts.after_dedupe += survivors.length;

    // dedupe() filters the array it is given, so survivors are the very same
    // objects. Identity is the only reliable way to tell which reads were
    // dropped: matching on ts or on text would miss exactly the duplicates
    // that share them, which is all of them.
    const survived = new Set(survivors);
    for (const r of read) {
      if (survived.has(r)) continue;
      droppedByDedupe.total++;
      if (r.synth.duplicate_kind) bump(droppedByDedupe.planted, r.synth.duplicate_kind);
      else if (seenTsInEarlierPolls.has(r.ts)) droppedByDedupe.re_read++;
      else droppedByDedupe.incidental++;
    }
    for (const r of read) seenTsInEarlierPolls.add(r.ts);

    let pollGatePassed = 0;

    for (const msg of survivors) {
      const item = clock.time('gate', () => decide(msg, state, poll.at));
      const type = item.parsed.alert_type || 'UNPARSEABLE';
      if (!byType[type]) {
        byType[type] = { read: 0, gate_passed: 0, by_priority: { P1: 0, P2: 0, P3: 0, NOISE: 0 }, diagnosed: 0 };
      }
      byType[type].read++;

      if (!item.should_respond) {
        counts.gate_rejected++;
        bump(gateRejections, rejectionReason(item));
        continue;
      }
      counts.gate_passed++;
      pollGatePassed++;
      byType[type].gate_passed++;

      const cls = clock.time('classify', () => classifyPriority(item.parsed, state));
      const res = Array.isArray(item.parsed.resource) ? item.parsed.resource[0] : (item.parsed.resource || '');
      simulatedLastSeen[(item.parsed.alert_type || 'UNKNOWN') + '|' + res] = poll.at;

      byPriority[cls.priority]++;
      byType[type].by_priority[cls.priority]++;

      // The NOISE branch stops here in the workflow too: a Slack reaction and
      // a log row, no enrichment call and no model call. This is where the
      // API-budget saving actually lands.
      if (cls.priority === 'NOISE') {
        counts.noise_stopped++;
        continue;
      }

      const enriched = clock.time('enrich', () => stubEnrichment(item, seed));
      counts.enriched++;
      for (const [branch, got] of Object.entries(enriched.stub_branches)) {
        if (got) evidence[branch]++;
      }

      const ctx = clock.time('enrich', () => buildEnrichedContext({ ...item, ...enriched }));
      const prompt = clock.time('prompt', () => buildClaudePrompt(ctx));
      counts.prompted++;

      const reply = clock.time('model', () => stubDiagnosis(prompt, item, seed));
      counts.diagnosed++;
      byType[type].diagnosed++;

      const message = clock.time('message', () =>
        buildSlackMessage({ ...item, enriched_context: ctx, priority: cls.priority, claude_response: reply }));
      if (message && message.length) counts.messaged++;
    }

    pollDetail.push({
      at: new Date(poll.at).toISOString(),
      read: read.length,
      survived: survivors.length,
      gate_passed: pollGatePassed,
    });
  }

  return buildReport(dataset, opts, {
    counts, droppedByDedupe, gateRejections, byPriority, evidence, byType,
    polls, pollDetail, clock,
  });
}

function buildReport(dataset, opts, r) {
  const notes = [
    'Every figure in this report describes synthetic data generated by tools/synth. ' +
    'It is a property of the generator and of the pipeline logic, not a measurement of production traffic.',

    'The NOISE band is only reachable from a WARN alert. classifyPriority caps the score of ' +
    'anything in TRIGGERED or RE-TRIGGERED at 69, below the NOISE threshold, so no combination of ' +
    'noise signals can silence an actively firing monitor. The share of input the generator shapes ' +
    'as noise therefore does not translate into a NOISE share here, and should not be read as one.',

    'Enrichment and the model call are stubbed. No network call is made, so the stage timings below ' +
    'are in-process work only. Production latency is dominated by the 2-minute polling interval and ' +
    'by five network calls per alert, and is not represented here at all.',

    opts.ageFrequencyWindow
      ? 'classifyPriority reads Date.now() for its 30-minute frequency window and cannot see the ' +
        'simulated clock. The harness applies that same 30-minute rule against simulated time at each ' +
        'poll boundary, so repeat-firing counts age out as they would in production.'
      : 'ageFrequencyWindow is off: classifyPriority reads Date.now(), so nothing ages out of its ' +
        '30-minute frequency window during a replay. Repeat-firing counts accumulate across the whole ' +
        'run, which inflates noise scores and pushes WARN alerts toward NOISE.',
  ];

  if (opts.mode === 'poll') {
    notes.push(
      'Poll mode replays the real trigger: a read every 2 minutes over a 5-minute window. The overlap ' +
      'means most records are read two or three times, so `reads` exceeds the dataset size by design ' +
      'and the re-reads are what exercise deduplication across runs.'
    );
  }

  const report = {
    synthetic: true,
    warning: dataset.meta.warning,
    generated_by: 'noc-bot tools/harness/replay',
    dataset: {
      seed: dataset.meta.seed,
      records: dataset.meta.counts.records,
      params: dataset.meta.params,
      window: dataset.meta.window,
    },
    mode: opts.mode,
    polls: {
      count: r.polls.length,
      interval_seconds: POLL_INTERVAL_MS / 1000,
      read_window_seconds: READ_WINDOW_MS / 1000,
      detail: r.pollDetail,
    },
    pipeline: {
      ingested: dataset.meta.counts.records,
      reads: r.counts.reads,
      after_dedupe: r.counts.after_dedupe,
      dropped_by_dedupe: r.droppedByDedupe,
      gate_passed: r.counts.gate_passed,
      gate_rejected: r.counts.gate_rejected,
      gate_rejections: r.gateRejections,
      by_priority: r.byPriority,
      noise_stopped: r.counts.noise_stopped,
      enriched: r.counts.enriched,
      prompted: r.counts.prompted,
      diagnosed: r.counts.diagnosed,
      messaged: r.counts.messaged,
    },
    // How many of the diagnoses had each kind of evidence available. The
    // pipeline degrades rather than failing when a branch returns nothing, so
    // this is the only place a partial diagnosis is visible at all.
    evidence_available: r.evidence,
    by_alert_type: r.byType,
    notes,
  };

  if (opts.timings) {
    report.timings_ms = {
      ...r.clock.toMs(),
      note: 'Wall-clock time inside this process, with enrichment and the model stubbed. ' +
        'Not production latency.',
    };
  }

  return report;
}

module.exports = { replay, DEFAULTS, POLL_INTERVAL_MS, READ_WINDOW_MS };
