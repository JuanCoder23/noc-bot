'use strict';

// Deterministic stand-ins for the two things the pipeline reaches outside
// itself for: the five enrichment calls, and the model.
//
// Nothing here opens a socket. There is no http, https, net, dns or fetch in
// this file or anywhere under tools/, and test/stubs.test.js asserts that by
// reading the sources — a replay that quietly started making real calls would
// stop being reproducible and would start costing money.
//
// Every stub is a pure function of the alert plus a seed, never of the clock
// or of processing order. That last part matters: in poll mode the same alert
// is read two or three times, at different positions in the run, and it must
// get the same enrichment every time.
//
// WHAT IS AND IS NOT MODELLED
// The response shapes are the ones the real APIs return, because that is what
// src/enrich.js parses. The CONTENT is invented — the metric series, the log
// lines, the deploy events and the correlation hits are all fabricated, and
// they are marked as such: every one of them names a `synth-` resource, the
// events carry a `source:synthetic-stub` tag, and the model stub says in its
// first line that it is not a model output. No number produced here describes
// anything that happened anywhere.

const { makeRng } = require('../synth/rng');
const { buildDDQuery } = require('../../src/parseAlert');

const STUB_NOTICE = 'SYNTHETIC STUB - not a model output.';

/** An rng bound to one alert, so its enrichment is stable wherever it appears. */
function alertRng(seed, item) {
  return makeRng(`${seed}|${item.ts}|${item.parsed.alert_type}|${item.parsed.resource}`);
}

function resourceOf(parsed) {
  const r = parsed.resource;
  return (Array.isArray(r) ? r[0] : r) || 'synth-unknown';
}

/**
 * Datadog metrics. Returns nothing when the alert has no query to run, which
 * is genuinely the case for SYNTHETICS — buildDDQuery has no entry for it —
 * and the prompt then omits the metrics section. Failure and absence are
 * indistinguishable downstream by design, so both are modelled the same way.
 */
function stubMetrics(rng, item) {
  if (!buildDDQuery(item.parsed)) return null;

  const threshold = item.parsed.threshold;
  const peak = item.parsed.metric_value !== null
    ? item.parsed.metric_value
    : (threshold ? threshold * rng.float(0.8, 1.6, 2) : rng.float(10, 90, 2));
  const base = peak * rng.float(0.45, 0.85, 3);

  const startMs = Math.floor(parseFloat(item.ts) * 1000) - 30 * 60 * 1000;
  const points = [];
  const n = 12;
  for (let i = 0; i < n; i++) {
    // Ramp from base toward peak with a little jitter, so summarizeMetrics
    // has a direction to find rather than a flat line.
    const progress = i / (n - 1);
    const v = base + (peak - base) * progress * rng.float(0.85, 1.15, 3);
    points.push([startMs + i * 150 * 1000, parseFloat(v.toFixed(2))]);
  }
  return { series: [{ pointlist: points }] };
}

const LOG_SHAPES = [
  (r) => `${r}: upstream call exceeded its deadline, retrying`,
  (r) => `${r}: connection pool exhausted, queueing request`,
  (r) => `${r}: task exceeded its memory reservation and was restarted`,
  (r) => `${r}: dependency returned 503, falling back to cache`,
  (r) => `${r}: handler threw an unhandled exception, request failed`,
  (r) => `${r}: throttled by the downstream rate limit`,
];

function stubLogs(rng, item) {
  const r = resourceOf(item.parsed);
  const count = rng.int(0, 8);
  if (count === 0) return null;

  const alertMs = Math.floor(parseFloat(item.ts) * 1000);
  const data = [];
  for (let i = 0; i < Math.min(count, 5); i++) {
    data.push({
      attributes: {
        message: rng.pick(LOG_SHAPES)(r),
        status: rng.chance(0.75) ? 'error' : 'warn',
        service: r,
        timestamp: new Date(alertMs - rng.int(30, 880) * 1000).toISOString(),
      },
    });
  }
  return { data };
}

function stubEvents(rng, item) {
  const r = resourceOf(item.parsed);
  if (rng.chance(0.35)) return null;

  const alertMs = Math.floor(parseFloat(item.ts) * 1000);
  const events = [];
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const isDeploy = rng.chance(0.6);
    events.push({
      title: isDeploy
        ? `Deploy ${r} v${rng.int(100, 9999)}`
        : `Config change on ${r}`,
      text: isDeploy
        ? `Rollout of ${r} completed across the cluster.`
        : `Parameter update applied to ${r}.`,
      date_happened: Math.floor((alertMs - rng.int(120, 3200) * 1000) / 1000),
      tags: [`resource:${r}`, 'source:synthetic-stub'],
    });
  }
  return { events };
}

function stubCorrelation(rng, item) {
  const r = resourceOf(item.parsed);
  const type = (item.parsed.alert_type || '').toLowerCase().replace(/_/g, ' ');
  const hits = rng.int(0, 5);
  const messages = [];
  for (let i = 0; i < hits; i++) {
    messages.push({ text: rng.chance(0.5) ? `${r} looked unhealthy a moment ago` : `another ${type} alert on ${r}` });
  }
  // Unrelated channel traffic, so summarizeCorrelation has something to
  // correctly not count.
  for (let i = 0; i < rng.int(1, 4); i++) {
    messages.push({ text: 'shift handover note, nothing outstanding' });
  }
  return messages;
}

function stubAwsHealth(rng, item) {
  if (!item.parsed.region || rng.chance(0.2)) return { available: false, incidents: 0 };
  return { available: true, incidents: rng.chance(0.12) ? rng.int(1, 2) : 0 };
}

/**
 * The five enrichment branches for one alert. Each can come back empty, which
 * is what the real pipeline sees when a call times out — it has neverError set
 * and degrades rather than failing — so the replay exercises the degradation
 * ladder rather than only the happy path.
 */
function stubEnrichment(item, seed) {
  const rng = alertRng(seed, item);
  const metrics = stubMetrics(rng, item);
  const logs = stubLogs(rng, item);
  const events = stubEvents(rng, item);
  const correlation = stubCorrelation(rng, item);
  const health = stubAwsHealth(rng, item);

  return {
    synthetic: true,
    dd_metrics_response: metrics,
    dd_logs_response: logs,
    dd_events_response: events,
    slack_history_response: correlation,
    aws_health_summary: health,
    // Which branches came back with something, so the replay report can say
    // how much evidence a diagnosis was actually built on.
    stub_branches: {
      metrics: Boolean(metrics),
      logs: Boolean(logs),
      events: Boolean(events),
      correlation: correlation.length > 0,
      aws_health: health.available,
    },
  };
}

/**
 * The model call. Shaped like an Anthropic messages response because that is
 * what buildSlackMessage reads, and deterministic in the prompt so the same
 * alert always yields the same reply.
 *
 * The text is not a diagnosis. It says so in its first line, which is the
 * point: this string travels all the way into the rendered Slack message, and
 * a screenshot of that message must not be mistakable for a real one.
 */
function stubDiagnosis(prompt, item, seed) {
  const rng = makeRng(`${seed}|llm|${item.ts}`);
  const p = item.parsed;
  const r = resourceOf(p);
  const runbook = item.runbook_detail ? item.runbook_detail.id : 'none mapped';

  const escalate = rng.chance(0.4)
    ? 'Escalate to N2: the condition is above the band this runbook handles at N1.'
    : 'Do not escalate yet: within the band the runbook allows N1 to observe.';

  const text = [
    STUB_NOTICE,
    `Placeholder analysis for a ${p.alert_type} alert on ${r} in ${p.region || 'an unspecified region'}.`,
    `Evidence assembled: ${prompt.length} characters of context. Runbook: ${runbook}.`,
    escalate,
    'Generated by tools/harness/stubs.js so the message renderer can be exercised offline.',
  ].join('\n');

  return {
    synthetic: true,
    model: 'stub-no-model-was-called',
    content: [{ type: 'text', text }],
    // Shaped like the real usage block because the pipeline carries one.
    // The replay report deliberately does not aggregate these: a token total
    // from a stub is an invented number, and there is no honest way to
    // present it alongside real ones.
    usage: { input_tokens: null, output_tokens: null },
  };
}

module.exports = { stubEnrichment, stubDiagnosis, STUB_NOTICE };
