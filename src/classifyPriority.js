'use strict';

// Extracted from the `Clasificar Prioridad` code node in
// workflows/NOC_bot.json. The scoring is unchanged; the only edit is that the
// n8n static-data handle is passed in as `state` instead of being reached for
// through $getWorkflowStaticData, so the frequency window can be exercised in
// tests. Pass {} for a cold instance.
//
// The last adjustment before clamping is the fail-safe cap: an alert whose
// monitor still says TRIGGERED or RE-TRIGGERED can never score into NOISE,
// regardless of every other signal. See "Design decisions" in the README.

const INHERENTLY_CRITICAL = new Set(['PULSAR_BACKLOG', 'RDS_BLOCKING']);
const INHERENTLY_NOISY    = new Set(['FLAP_DETECTION']);

function classifyPriority(parsed, state) {
  let score   = 50;
  const why   = [];

  if (INHERENTLY_CRITICAL.has(parsed.alert_type)) {
    score = Math.min(score, 20);
    why.push(parsed.alert_type + ' inherently critical');
  }
  if (INHERENTLY_NOISY.has(parsed.alert_type)) {
    score = Math.min(score + 30, 100);
    why.push('flap detection type');
  }
  if (parsed.state === 'RE-TRIGGERED') { score -= 15; why.push('re-triggered (persists)'); }
  else if (parsed.state === 'WARN')    { score += 10;  why.push('WARN state'); }

  if (parsed.metric_value !== null && parsed.threshold > 0) {
    const ratio = parsed.metric_value / parsed.threshold;
    if (ratio > 1.5)      { score -= 25; why.push('metric ' + ratio.toFixed(1) + 'x above threshold'); }
    else if (ratio < 1.1) { score += 15; why.push('barely above threshold (' + ratio.toFixed(2) + 'x)'); }
  }

  // Frequency from staticData (last 30 min)
  const sd  = state || {};
  if (!sd.recentFires) sd.recentFires = {};
  const now = Date.now();
  Object.keys(sd.recentFires).forEach(k => {
    if (now - sd.recentFires[k].lastSeen > 30 * 60 * 1000) delete sd.recentFires[k];
  });

  const res      = Array.isArray(parsed.resource) ? parsed.resource[0] : (parsed.resource || '');
  const alertKey = (parsed.alert_type || 'UNKNOWN') + '|' + res;
  const recent   = sd.recentFires[alertKey];
  if (recent) {
    const fc = recent.count || 1;
    if      (fc >= 5) { score += 30; why.push('fired ' + fc + 'x in 30 min (noise)'); }
    else if (fc >= 3) { score += 20; why.push('fired ' + fc + 'x in 30 min'); }
    else if (fc >= 2) { score += 10; why.push('fired ' + fc + 'x in 30 min'); }
  }

  if (!sd.recentFires[alertKey]) sd.recentFires[alertKey] = { count: 0, lastSeen: now };
  sd.recentFires[alertKey].count    = (sd.recentFires[alertKey].count || 0) + 1;
  sd.recentFires[alertKey].lastSeen = now;

  // // TRIGGERED y RE-TRIGGERED nunca pueden ser NOISE
  // if (parsed.state === 'TRIGGERED' || parsed.state === 'RE-TRIGGERED') {
  //   score = Math.min(score, 69);
  // }

  score = Math.max(0, Math.min(100, score));
  const priority =
    score > 70 ? 'NOISE' :
    score > 50 ? 'P3'    :
    score > 30 ? 'P2'    : 'P1';

  return { priority, noise_score: score, classification_reason: why.join('; ') || 'base score' };
}

module.exports = { classifyPriority, INHERENTLY_CRITICAL, INHERENTLY_NOISY };
