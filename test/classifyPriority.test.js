'use strict';
const { classifyPriority } = require('../src/classifyPriority');
const { parseDatadogAlert } = require('../src/parseAlert');
const { load } = require('./fixtures');

const noisiest = { metric_value: 86, threshold: 85 }; // barely over -> +15

module.exports = function (t) {
  // ---------------------------------------------------------------
  // The fail-safe cap. This is the design decision the README argues
  // for, asserted rather than described: while a monitor still says
  // the condition is active, NO combination of noise signals can
  // silence it.
  // ---------------------------------------------------------------
  for (const state of ['TRIGGERED', 'RE-TRIGGERED']) {
    const st = {};
    let r;
    // Pile on every noise signal at once: a type flagged noisy, a value
    // barely over threshold, and a monitor firing repeatedly.
    for (let i = 0; i < 12; i++) {
      r = classifyPriority({ alert_type: 'FLAP_DETECTION', state, resource: 'svc-a', ...noisiest }, st);
    }
    t.ok(r.noise_score <= 69, `${state} with every noise signal: score capped at 69, got ${r.noise_score}`);
    t.ok(r.priority !== 'NOISE', `${state} is never classified NOISE`);
  }

  // The same signals on a state that is NOT actively firing do reach NOISE,
  // which is what makes the cap above meaningful rather than vacuous.
  const st = {};
  let warn;
  for (let i = 0; i < 12; i++) {
    warn = classifyPriority({ alert_type: 'FLAP_DETECTION', state: 'WARN', resource: 'svc-a', ...noisiest }, st);
  }
  t.eq(warn.priority, 'NOISE', 'same signals on WARN do reach NOISE');

  // ---------------------------------------------------------------
  // Scoring components
  // ---------------------------------------------------------------
  // The critical cap is applied before the state adjustment, so a WARN on a
  // critical type still lands slightly higher than a TRIGGERED one.
  const crit = classifyPriority({ alert_type: 'PULSAR_BACKLOG', state: 'TRIGGERED' }, {});
  t.eq(crit.noise_score, 20, 'PULSAR_BACKLOG is capped down to 20');
  t.eq(crit.priority, 'P1', 'inherently critical type -> P1');
  const critWarn = classifyPriority({ alert_type: 'PULSAR_BACKLOG', state: 'WARN' }, {});
  t.eq(critWarn.noise_score, 30, 'the WARN adjustment applies after the cap');
  t.eq(critWarn.priority, 'P1', 'still P1');

  const far = classifyPriority({ alert_type: 'ECS_CPU', state: 'TRIGGERED', metric_value: 200, threshold: 85 }, {});
  const near = classifyPriority({ alert_type: 'ECS_CPU', state: 'TRIGGERED', metric_value: 86, threshold: 85 }, {});
  t.ok(far.noise_score < near.noise_score, 'further over threshold scores more urgent');

  // Frequency accumulates in the injected state, per alert_type|resource.
  const freq = {};
  const first = classifyPriority({ alert_type: 'ECS_CPU', state: 'WARN', resource: 'svc-b' }, freq);
  let sixth;
  for (let i = 0; i < 5; i++) {
    sixth = classifyPriority({ alert_type: 'ECS_CPU', state: 'WARN', resource: 'svc-b' }, freq);
  }
  t.ok(sixth.noise_score > first.noise_score, 'repeat firing raises the noise score');
  t.ok(/fired \d+x in 30 min/.test(sixth.classification_reason), 'reason cites the frequency');

  // Different resources are counted separately.
  const sep = {};
  classifyPriority({ alert_type: 'ECS_CPU', state: 'WARN', resource: 'svc-c' }, sep);
  const other = classifyPriority({ alert_type: 'ECS_CPU', state: 'WARN', resource: 'svc-d' }, sep);
  t.ok(!/fired/.test(other.classification_reason), 'frequency is keyed per resource');

  // Score is always clamped to the band range.
  const s = classifyPriority({ alert_type: 'ECS_CPU', state: 'TRIGGERED', metric_value: 1e9, threshold: 1 }, {});
  t.ok(s.noise_score >= 0 && s.noise_score <= 100, 'score stays within 0..100');

  // ---------------------------------------------------------------
  // End to end from a sample alert
  // ---------------------------------------------------------------
  const parsed = parseDatadogAlert(load('ecs-cpu-triggered'));
  const live = classifyPriority(parsed, {});
  t.ok(live.priority !== 'NOISE', 'a real TRIGGERED sample is never NOISE');
};
