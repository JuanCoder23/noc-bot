'use strict';
const { parseDatadogAlert } = require('../src/parseAlert');
const { ALERT_TYPE_TO_RUNBOOK, KNOWN_RUNBOOKS, RUNBOOKS } = require('../src/runbooks');
const { INHERENTLY_NOISY } = require('../src/classifyPriority');
const fs = require('fs');
const path = require('path');

// Alert types the parser can actually emit, read off the source.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'parseAlert.js'), 'utf8');
const EMITTED = new Set(
  [...src.matchAll(/result\.alert_type = '([A-Z_0-9]+)'/g)].map((m) => m[1])
);

module.exports = function (t) {
  // Documents a real gap rather than asserting it away: the runbook mapping
  // covers more alert types than the parser can produce. Nine of them are
  // unreachable, so their runbooks can never be selected. Pinning the numbers
  // here means closing the gap shows up as a failing test, not as silence.
  const mapped = new Set(Object.keys(ALERT_TYPE_TO_RUNBOOK));
  const unreachable = [...mapped].filter((k) => !EMITTED.has(k)).sort();

  t.eq(EMITTED.size, 12, 'the parser emits 12 alert types');
  t.eq(unreachable.length, 9, 'nine mapped alert types are unreachable from parsing');
  t.eq(unreachable, [
    'APM_ERRORS', 'APM_LATENCY', 'ECS_HIGH_TASK', 'ECS_LOW_TASK', 'ECS_NETWORK',
    'ECS_STORAGE', 'FLAP_DETECTION', 'LAMBDA_INVOCATIONS', 'SNOWFLAKE_ERROR',
  ], 'the unreachable set is exactly these');

  // Consequence: the classifier's inherently-noisy branch is dead code, because
  // the only type in it is one the parser never produces.
  const noisy = [...INHERENTLY_NOISY];
  t.eq(noisy, ['FLAP_DETECTION'], 'INHERENTLY_NOISY holds only FLAP_DETECTION');
  t.ok(!EMITTED.has(noisy[0]), 'and the parser cannot emit it, so that branch never runs');

  // Every alert type the parser CAN emit does resolve to a runbook id.
  for (const type of EMITTED) {
    t.ok(Boolean(ALERT_TYPE_TO_RUNBOOK[type]), `${type} maps to a runbook`);
  }

  // Every mapped runbook id has a title.
  for (const id of new Set(Object.values(ALERT_TYPE_TO_RUNBOOK))) {
    t.ok(Boolean(KNOWN_RUNBOOKS[id]), `${id} has a title`);
  }

  // The published catalog is the synthetic one, not an operator's.
  t.eq(Object.keys(RUNBOOKS).sort(), ['RUNBOOK-001', 'RUNBOOK-009', 'RUNBOOK-019'],
    'only the three synthetic runbooks ship with this repository');
  for (const [id, rb] of Object.entries(RUNBOOKS)) {
    t.ok(/EJEMPLO SINTETICO/.test(rb.diagnostico), `${id} is marked synthetic`);
  }
};
