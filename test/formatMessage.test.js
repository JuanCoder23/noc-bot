'use strict';
const { buildSlackMessage } = require('../src/formatMessage');
const { buildEnrichedContext } = require('../src/enrich');
const { parseDatadogAlert } = require('../src/parseAlert');
const { lookupRunbook } = require('../src/runbooks');
const { load } = require('./fixtures');

const parsed = parseDatadogAlert(load('ecs-cpu-triggered'));

function payload(extra) {
  return {
    enriched_context: buildEnrichedContext({ parsed, runbook_detail: lookupRunbook(parsed) }),
    priority: 'P2',
    ...extra,
  };
}

module.exports = function (t) {
  // ---- the model's text reaches the message ---------------------------
  const withAI = buildSlackMessage(payload({
    claude_response: { content: [{ text: 'Probable cause: undersized task definition.' }] },
  }));
  t.ok(/undersized task definition/.test(withAI), 'model output is rendered');

  // ---- a missing or failed model call degrades visibly ------------------
  const noAI = buildSlackMessage(payload({}));
  t.ok(noAI.length > 0, 'a message is still produced without model output');
  t.ok(!/undefined/.test(noAI), 'no undefined leaks into the message');
  t.ok(!/\[object Object\]/.test(noAI), 'no object stringification leaks in');

  const errAI = buildSlackMessage(payload({ claude_response: { error: { message: 'overloaded' } } }));
  t.ok(!/undefined/.test(errAI), 'an API error body does not corrupt the message');

  // ---- alert facts are carried through ----------------------------------
  t.ok(/checkout-api/.test(withAI), 'resource named');
  t.ok(/us-east-1/.test(withAI), 'region named');
  t.ok(/TRIGGERED/.test(withAI), 'state named');
  t.ok(/RUNBOOK-001/.test(withAI), 'runbook cited');

  // ---- the sanitized export carries a placeholder, not a real user id ----
  t.ok(!/<@U[A-Z0-9]{8,}>/.test(withAI),
    'no real Slack member id is embedded in the rendered message');

  // ---- an alert with almost nothing parsed still renders -----------------
  const sparse = buildSlackMessage({
    enriched_context: buildEnrichedContext({ parsed: parseDatadogAlert(load('unparseable')) }),
  });
  t.ok(sparse.length > 0, 'a near-empty alert still renders');
  t.ok(!/undefined/.test(sparse), 'sparse render has no undefined');
};
