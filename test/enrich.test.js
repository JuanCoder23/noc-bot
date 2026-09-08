'use strict';
const {
  summarizeMetrics, summarizeLogs, summarizeEvents, summarizeCorrelation,
  buildEnrichedContext, buildClaudePrompt,
} = require('../src/enrich');
const { parseDatadogAlert } = require('../src/parseAlert');
const { load } = require('./fixtures');

const parsed = parseDatadogAlert(load('ecs-cpu-triggered'));

module.exports = function (t) {
  // ---- every summarizer degrades to { available: false } ---------------
  // A failed API call and an empty result must be indistinguishable here.
  // That equivalence is what lets the pipeline degrade instead of fail.
  for (const [name, fn] of Object.entries({ summarizeMetrics, summarizeLogs, summarizeEvents })) {
    t.eq(fn(undefined).available, false, `${name}(undefined) -> unavailable`);
    t.eq(fn({}).available, false, `${name}({}) -> unavailable`);
  }
  t.eq(summarizeMetrics({ series: [] }).available, false, 'empty series -> unavailable');
  t.eq(summarizeMetrics({ series: [{ pointlist: [] }] }).available, false, 'no points -> unavailable');
  t.eq(summarizeCorrelation(null, parsed).available, false, 'no correlation data -> unavailable');

  // ---- metric summarization -------------------------------------------
  const rising = summarizeMetrics({ series: [{ pointlist: [[1, 10], [2, 10], [3, 40], [4, 40]] }] });
  t.eq(rising.available, true, 'a real series is available');
  t.eq(rising.avg, 25, 'average computed');
  t.eq(rising.max, 40, 'max computed');
  t.eq(rising.min, 10, 'min computed');
  t.ok(/subiendo/.test(rising.trend), 'rising series detected');

  const falling = summarizeMetrics({ series: [{ pointlist: [[1, 40], [2, 40], [3, 10], [4, 10]] }] });
  t.ok(/bajando/.test(falling.trend), 'falling series detected');

  const flat = summarizeMetrics({ series: [{ pointlist: [[1, 20], [2, 21], [3, 20], [4, 21]] }] });
  t.eq(flat.trend, 'estable', 'flat series detected');

  // Null points are filtered, not counted.
  const holes = summarizeMetrics({ series: [{ pointlist: [[1, 10], [2, null], [3, 20]] }] });
  t.eq(holes.points_count, 2, 'null datapoints are dropped');

  // ---- logs -------------------------------------------------------------
  const logs = summarizeLogs({ data: Array.from({ length: 9 }, (_, i) => ({
    attributes: { message: 'boom ' + i, status: 'error', timestamp: '2026-01-01T00:00:0' + i + 'Z' },
  })) });
  t.eq(logs.count, 9, 'full count reported');
  t.eq(logs.samples.length, 5, 'at most 5 samples retained');

  // ---- events split into deploys vs other changes ------------------------
  const ev = summarizeEvents({ events: [
    { title: 'Deploy checkout-api v42' },
    { title: 'Release payments v7' },
    { title: 'Monitor edited' },
  ] });
  t.eq(ev.deploys.length, 2, 'deploy and release both count as deploys');
  t.eq(ev.changes.length, 1, 'everything else is a change');

  // ---- correlation --------------------------------------------------------
  const corr = summarizeCorrelation(
    [{ text: 'High CPU on checkout-api again' }, { text: 'unrelated chatter' }, { text: 'checkout-api still hot' }],
    parsed);
  t.eq(corr.similar_count, 2, 'matches on the resource name');

  // ---- prompt assembly ----------------------------------------------------
  const bare = buildClaudePrompt(buildEnrichedContext({ parsed }));
  t.ok(/ECS_CPU/.test(bare), 'prompt names the alert type');
  t.ok(/checkout-api/.test(bare), 'prompt names the resource');
  t.ok(/No disponibles/.test(bare), 'missing metrics are stated, not omitted silently');
  t.ok(!/LOGS/.test(bare), 'sections without data are left out entirely');

  const full = buildClaudePrompt(buildEnrichedContext({
    parsed,
    dd_metrics_response: { series: [{ pointlist: [[1, 90], [2, 95]] }] },
    dd_logs_response: { data: [{ attributes: { message: 'OOMKilled', status: 'error' } }] },
    aws_health_summary: { available: true, incidents: 1 },
  }));
  t.ok(/MÉTRICAS \(30 min\)/.test(full), 'metrics section present when data exists');
  t.ok(/OOMKilled/.test(full), 'log line reaches the prompt');
  t.ok(/AWS HEALTH/.test(full), 'AWS health section present');

  // Raw API payloads must never reach the model — only the summaries.
  t.ok(!/pointlist/.test(full), 'raw metric payload is not forwarded');
  t.ok(!/attributes/.test(full), 'raw log payload is not forwarded');
};
