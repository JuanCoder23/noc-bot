'use strict';
const { dedupe, decide, sweep, RESPONDED_TTL_MS } = require('../src/dedupe');
const { load } = require('./fixtures');

const NOW = 1_700_000_000_000;
const cpu = load('ecs-cpu-triggered');

module.exports = function (t) {
  // ---- layer 1: exact Slack ts ---------------------------------------
  t.eq(dedupe([{ ts: '1', mensaje: cpu }, { ts: '1', mensaje: cpu }], {}, NOW).length, 1,
    'same ts collapses to one');

  // ---- layer 2: identical message text --------------------------------
  t.eq(dedupe([{ ts: '1', mensaje: cpu }, { ts: '2', mensaje: cpu }], {}, NOW).length, 1,
    'identical text under different ts collapses');

  // ---- layer 3: composite state|type|resource -------------------------
  // Two textually different messages describing the same condition: layers 1
  // and 2 both miss these, layer 3 is what catches them.
  const a = { ts: '1', mensaje: '[Triggered] High CPU\nservicename:checkout-api\nValue: 91' };
  const b = { ts: '2', mensaje: '[Triggered] High CPU alarm\nservicename:checkout-api\nValue: 93' };
  t.eq(dedupe([a, b], {}, NOW).length, 1, 'same state|type|resource collapses on differing text');

  // Distinct conditions survive.
  const other = { ts: '3', mensaje: load('lambda-errors') };
  t.eq(dedupe([a, other], {}, NOW).length, 2, 'genuinely different alerts both survive');

  // ---- the response gate ----------------------------------------------
  const st = {};
  t.eq(decide({ ts: '1', mensaje: cpu }, st, NOW).should_respond, true, 'first sighting is answered');
  t.eq(decide({ ts: '9', mensaje: cpu }, st, NOW).should_respond, false, 'second sighting is suppressed');

  // Suppression expires with the TTL, but only once sweep() has run — which is
  // what dedupe() does at the top of every execution.
  const later = NOW + RESPONDED_TTL_MS + 1;
  sweep(st, later);
  t.eq(decide({ ts: '9', mensaje: cpu }, st, later).should_respond, true, 'answerable again after the TTL');

  // WARN then TRIGGERED on the same monitor are distinct states, so both are
  // answered. The same state twice is not.
  const st2 = {};
  const warnMsg = { ts: '1', mensaje: '[Warn] High CPU\nservicename:checkout-api' };
  t.eq(decide(warnMsg, st2, NOW).should_respond, true, 'WARN answered');
  t.eq(decide({ ts: '2', mensaje: cpu }, st2, NOW).should_respond, true, 'TRIGGERED after WARN also answered');
  t.eq(decide({ ts: '3', mensaje: cpu }, st2, NOW).should_respond, false, 'but not the same TRIGGERED twice');

  // ---- what the gate rejects -------------------------------------------
  t.eq(decide({ ts: '1', mensaje: load('ecs-cpu-recovered') }, {}, NOW).should_respond, false,
    'RECOVERED is never answered');
  t.eq(decide({ ts: '1', mensaje: load('unparseable') }, {}, NOW).should_respond, false,
    'an unparseable message is never answered');
  t.eq(decide({ ts: '1', mensaje: cpu, subtype: 'bot_message' }, {}, NOW).should_respond, false,
    'messages with a subtype are skipped');

  // ---- sweep ------------------------------------------------------------
  const aged = { respondedTs: { old: NOW - RESPONDED_TTL_MS - 1, fresh: NOW } };
  sweep(aged, NOW);
  t.eq(Object.keys(aged.respondedTs), ['fresh'], 'sweep drops only expired entries');

  // ---- known failure mode, asserted -------------------------------------
  // decide() marks the alert answered at the moment the gate passes — before
  // enrichment, the model call, or the Slack reply. Nothing downstream can
  // undo that, so a run aborting later drops the alert silently. Documented in
  // docs/architecture.md; this test pins the current behaviour so a future fix
  // is a deliberate, visible change.
  const st3 = {};
  decide({ ts: '1', mensaje: cpu }, st3, NOW);
  t.ok(Object.keys(st3.respondedTs).length > 0,
    'the alert is marked answered before any reply is attempted (known gap)');
};
