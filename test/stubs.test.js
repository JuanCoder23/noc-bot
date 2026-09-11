'use strict';

// Tests for the enrichment and model stubs, tools/harness/stubs.js.
//
// The load-bearing one is the offline test: it reads every source file under
// tools/ and fails if any of them so much as mentions a network API. A replay
// that started making real calls would stop being reproducible, would cost
// money, and would quietly contradict the claim that this repository runs end
// to end on its own.

const fs = require('fs');
const path = require('path');

const { generateDataset } = require('../tools/synth/generate');
const { stubEnrichment, stubDiagnosis, STUB_NOTICE } = require('../tools/harness/stubs');
const { decide } = require('../src/dedupe');
const { buildEnrichedContext, buildClaudePrompt } = require('../src/enrich');
const { buildSlackMessage } = require('../src/formatMessage');

const SEED = 'stub-test';
const NOW = Date.parse('2026-01-01T03:00:00Z');

const dataset = generateDataset({ seed: SEED, count: 120 });
const items = dataset.records
  .map((r) => decide(r, {}, NOW))
  .filter((i) => i.should_respond);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

module.exports = function (t) {
  // ── no network, asserted against the sources ──────────────────────────
  const toolFiles = walk(path.join(__dirname, '..', 'tools'));
  t.ok(toolFiles.length >= 6, 'the scan found the tools sources');

  const NETWORK = [
    [/require\(['"](?:node:)?https?['"]\)/, 'http/https'],
    [/require\(['"](?:node:)?(?:net|dgram|dns|tls)['"]\)/, 'a socket module'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/require\(['"](?:node:)?child_process['"]\)/, 'child_process'],
  ];
  let networkUses = 0;
  for (const file of toolFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const [re, label] of NETWORK) {
      if (re.test(src)) {
        networkUses++;
        t.ok(false, `${path.relative(process.cwd(), file)} reaches for ${label}`);
      }
    }
  }
  t.eq(networkUses, 0, 'nothing under tools/ can make a network call or shell out');

  // ── determinism ───────────────────────────────────────────────────────
  const sample = items.slice(0, 40);
  let unstable = 0;
  for (const item of sample) {
    const a = stubEnrichment(item, SEED);
    const b = stubEnrichment(item, SEED);
    if (JSON.stringify(a) !== JSON.stringify(b)) unstable++;
  }
  t.eq(unstable, 0, 'the same alert gets the same enrichment every time');

  // Position-independence is what makes poll mode reproducible: the same
  // alert is read two or three times, at different points in the run.
  const first = stubEnrichment(items[0], SEED);
  items.slice(1, 10).forEach((i) => stubEnrichment(i, SEED));
  t.eq(JSON.stringify(stubEnrichment(items[0], SEED)), JSON.stringify(first),
    'and is unaffected by how many other alerts were enriched in between');

  const otherSeed = stubEnrichment(items[0], 'a-different-seed');
  t.ok(JSON.stringify(otherSeed) !== JSON.stringify(first), 'a different seed gives different enrichment');

  // ── shapes src/enrich.js can actually read ────────────────────────────
  let metricsRead = 0, logsRead = 0, eventsRead = 0, corrRead = 0;
  let metricsAbsent = 0, logsAbsent = 0, eventsAbsent = 0;
  for (const item of items) {
    const ctx = buildEnrichedContext({ ...item, ...stubEnrichment(item, SEED) });
    if (ctx.metrics.available) metricsRead++; else metricsAbsent++;
    if (ctx.logs.available) logsRead++; else logsAbsent++;
    if (ctx.events.available) eventsRead++; else eventsAbsent++;
    if (ctx.correlation.available) corrRead++;
  }
  t.ok(metricsRead > 0, 'summarizeMetrics reads the stubbed metric series');
  t.ok(logsRead > 0, 'summarizeLogs reads the stubbed logs');
  t.ok(eventsRead > 0, 'summarizeEvents reads the stubbed events');
  t.ok(corrRead > 0, 'summarizeCorrelation reads the stubbed channel history');

  // The degradation ladder is the interesting half: a branch that returns
  // nothing must be as ordinary as one that returns data.
  t.ok(metricsAbsent > 0, 'some alerts get no metrics at all, as SYNTHETICS never can');
  t.ok(logsAbsent > 0, 'some get no logs');
  t.ok(eventsAbsent > 0, 'some get no deploy events');

  const synthetics = items.filter((i) => i.parsed.alert_type === 'SYNTHETICS');
  t.ok(synthetics.length > 0, 'the sample contains synthetics alerts');
  const synthMetrics = synthetics.filter((i) => stubEnrichment(i, SEED).dd_metrics_response !== null);
  t.eq(synthMetrics.length, 0, 'and none of them gets a metric series, because there is no query to run');

  // ── the model stub ────────────────────────────────────────────────────
  const item = items[0];
  const ctx = buildEnrichedContext({ ...item, ...stubEnrichment(item, SEED) });
  const prompt = buildClaudePrompt(ctx);
  const reply = stubDiagnosis(prompt, item, SEED);

  t.eq(JSON.stringify(stubDiagnosis(prompt, item, SEED)), JSON.stringify(reply), 'the model stub is deterministic');
  t.ok(reply.content[0].text.startsWith(STUB_NOTICE), 'its first line says it is not a model output');
  t.eq(reply.model, 'stub-no-model-was-called', 'and its model field says no model was called');
  t.eq(reply.usage.input_tokens, null, 'token counts are null rather than invented');

  // The notice has to survive all the way into the rendered Slack message,
  // since that is the artefact someone might screenshot.
  const message = buildSlackMessage({ ...item, enriched_context: ctx, priority: 'P2', claude_response: reply });
  t.ok(message.includes(STUB_NOTICE), 'and the notice reaches the rendered Slack message intact');
  t.ok(/synth-/.test(message), 'which also carries a synth- prefixed resource name');

  // ── stubbed content is marked ─────────────────────────────────────────
  let unmarkedLogs = 0, unmarkedEvents = 0;
  for (const i of items.slice(0, 60)) {
    const e = stubEnrichment(i, SEED);
    const res = Array.isArray(i.parsed.resource) ? i.parsed.resource[0] : i.parsed.resource;
    // AUTH0_TOKEN's resource is hardcoded by the parser and is not a
    // generated name, so it is the one type without a synth- prefix.
    if (i.parsed.alert_type === 'AUTH0_TOKEN' || !res) continue;
    for (const l of (e.dd_logs_response || { data: [] }).data) {
      if (!l.attributes.message.includes(res)) unmarkedLogs++;
    }
    for (const ev of (e.dd_events_response || { events: [] }).events) {
      if (!ev.tags.includes('source:synthetic-stub')) unmarkedEvents++;
    }
  }
  t.eq(unmarkedLogs, 0, 'every stubbed log line names the synthetic resource it belongs to');
  t.eq(unmarkedEvents, 0, 'every stubbed event is tagged as coming from the stub');
};
