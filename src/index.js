'use strict';

// Demo entrypoint: traces one sample alert through the pipeline and prints
// each stage, so the repository can be inspected without an n8n instance,
// Datadog credentials, or a model API key.
//
//   npm run demo                     # default sample
//   npm run demo -- lambda-errors    # any file in samples/alerts
//
// The enrichment stage is stubbed with fixed responses. Everything else —
// parsing, deduplication, the response gate, scoring, prompt assembly and
// message rendering — is the code that runs in production.

const fs = require('fs');
const path = require('path');

const { parseDatadogAlert, buildDDQuery, buildLogsQuery } = require('./parseAlert');
const { lookupRunbook } = require('./runbooks');
const { dedupe, decide } = require('./dedupe');
const { classifyPriority } = require('./classifyPriority');
const { buildEnrichedContext, buildClaudePrompt } = require('./enrich');
const { buildSlackMessage } = require('./formatMessage');

const SAMPLES = path.join(__dirname, '..', 'samples', 'alerts');

// Stand-in for the five enrichment calls. Shaped like the real API responses.
const STUB_ENRICHMENT = {
  dd_metrics_response: { series: [{ pointlist: [[1, 71], [2, 78], [3, 90], [4, 94]] }] },
  dd_logs_response: { data: [
    { attributes: { message: 'task exceeded memory limit, restarting', status: 'error', timestamp: '2026-01-01T03:14:07Z' } },
  ] },
  dd_events_response: { events: [{ title: 'Deploy checkout-api v42', date_happened: 1767230000 }] },
  slack_history_response: [{ text: 'checkout-api looked hot earlier too' }],
  aws_health_summary: { available: true, incidents: 0 },
};

function hr(label) {
  console.log('\n\x1b[1m' + label + '\x1b[0m');
  console.log('─'.repeat(72));
}

function main() {
  const name = process.argv[2] || 'ecs-cpu-triggered';
  const file = path.join(SAMPLES, name + '.txt');
  if (!fs.existsSync(file)) {
    console.error(`No such sample: ${name}\nAvailable: ` +
      fs.readdirSync(SAMPLES).map((f) => f.replace(/\.txt$/, '')).join(', '));
    process.exit(1);
  }

  const now = Date.now();
  const state = {};
  const raw = fs.readFileSync(file, 'utf8');

  hr('1. Raw alert, as it arrives in Slack');
  console.log(raw.trim());

  // The same alert twice, to show deduplication doing its job.
  const incoming = [{ ts: '1700000000.0001', mensaje: raw }, { ts: '1700000000.0002', mensaje: raw }];
  const unique = dedupe(incoming, state, now);
  hr('2. Deduplication');
  console.log(`${incoming.length} messages in, ${unique.length} out (the duplicate is dropped before any API call)`);

  const item = decide(unique[0], state, now);
  const p = item.parsed;
  hr('3. Parsed');
  console.log({
    alert_type: p.alert_type, state: p.state, severity: p.severity,
    resource: p.resource, region: p.region,
    metric_value: p.metric_value, threshold: p.threshold,
    runbook: p.runbook, monitor_url: p.monitor_url,
  });
  console.log('dd_query:   ' + buildDDQuery(p));
  console.log('logs_query: ' + buildLogsQuery(p));
  console.log('runbook:    ' + ((lookupRunbook(p) || {}).id || 'none in the synthetic catalog'));

  hr('4. Response gate');
  console.log(`should_respond: ${item.should_respond}`);
  if (!item.should_respond) {
    console.log('\nThe pipeline stops here for this alert. Nothing is enriched and nothing is posted.');
    return;
  }

  const cls = classifyPriority(p, state);
  hr('5. Priority');
  console.log(`${cls.priority}  (noise_score ${cls.noise_score})`);
  console.log('why: ' + cls.classification_reason);
  if (cls.priority === 'NOISE') {
    console.log('\nNOISE: a Slack reaction and a log row, no enrichment and no model call.');
    return;
  }

  hr('6. Enrichment (stubbed) and prompt');
  const ctx = buildEnrichedContext({ ...item, ...STUB_ENRICHMENT, runbook_detail: lookupRunbook(p) });
  console.log(buildClaudePrompt(ctx));

  hr('7. Slack reply');
  console.log(buildSlackMessage({
    ...item,
    enriched_context: ctx,
    priority: cls.priority,
    claude_response: { content: [{ text:
      'Probable root cause: the v42 deploy raised steady-state memory above the task limit, and tasks are being OOM-killed and restarted (RUNBOOK-001). Check running vs desired task count and whether autoscaling has already reacted. Escalate to N2 if CPU stays above threshold past the team window or tasks keep restarting.' }] },
  }));
  console.log();
}

main();
