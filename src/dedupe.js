'use strict';

// Extracted from the tail of the `Parsear Alerta` code node in
// workflows/NOC_bot.json. The n8n static-data handle and Date.now() are passed
// in, so the 10-minute TTL and the cross-run suppression can be exercised
// without waiting on a clock.
//
// Three within-run layers plus one cross-run layer, all of which run BEFORE any
// enrichment call is made. See "Design decisions" in the README for why the
// ordering matters.

const { parseDatadogAlert, buildDDQuery, buildLogsQuery } = require('./parseAlert');
const { lookupRunbook } = require('./runbooks');

const RESPONDED_TTL_MS = 10 * 60 * 1000;

/** Drop entries older than the TTL. Mutates `state`, as the node does. */
function sweep(state, now) {
  if (!state.respondedTs) state.respondedTs = {};
  Object.keys(state.respondedTs).forEach((k) => {
    if (now - state.respondedTs[k] > RESPONDED_TTL_MS) delete state.respondedTs[k];
  });
  return state;
}

/**
 * Within-run deduplication, in three layers:
 *   1. exact Slack ts
 *   2. first 200 characters of message text
 *   3. composite state|alert_type|resource
 * Layer 3 catches the same condition delivered as two distinct Slack messages,
 * which layers 1 and 2 both miss.
 */
function dedupe(messages, state, now) {
  sweep(state, now);

  const seenTs = new Set();
  const seenAlertKey = new Set();
  const seenText = new Set();

  return messages.filter((msg) => {
    const ts = msg.ts || msg.timestamp;
    if ((ts && seenTs.has(ts)) || state.respondedTs[ts]) return false;
    if (ts) seenTs.add(ts);

    const msgText = (msg.text || msg.mensaje || '').substring(0, 200);
    if (msgText && seenText.has(msgText)) return false;
    if (msgText) seenText.add(msgText);

    const parsed = parseDatadogAlert(msg.mensaje || msg.message || '');
    const alertKey =
      (parsed.state || 'unknown') + '|' +
      (parsed.alert_type || 'unknown') + '|' +
      (Array.isArray(parsed.resource) ? parsed.resource[0] : parsed.resource || 'unknown');
    if (seenAlertKey.has(alertKey)) return false;
    seenAlertKey.add(alertKey);

    return true;
  });
}

/**
 * Parse a deduplicated message and decide whether to answer it.
 *
 * NOTE: on a positive decision this marks the alert answered immediately —
 * before enrichment, the model call, or the Slack reply. A run that aborts
 * later suppresses the alert for the TTL without having replied. This is the
 * known failure mode documented in docs/architecture.md; the behaviour is kept
 * here as it runs in production rather than quietly fixed.
 */
function decide(msg, state, now) {
  // In the workflow dedupe() always runs first and initialises this; guard so
  // the function is safe to call on its own.
  if (!state.respondedTs) state.respondedTs = {};

  const att = (msg.attachments && msg.attachments[0]) || null;
  const rawTitle = att ? (att.title || '') + '\n' + (att.pretext || '') + '\n' : '';
  const parsed = parseDatadogAlert(rawTitle + (msg.mensaje || ''));

  const resourceKey = Array.isArray(parsed.resource)
    ? (parsed.resource[0] || '')
    : (parsed.resource || '');
  const respondedKey =
    (parsed.state || '') + '|' + (parsed.alert_type || '') + '|' + resourceKey;
  const alreadyResponded = Boolean(respondedKey && state.respondedTs[respondedKey]);

  const shouldRespond =
    (parsed.state === 'WARN' || parsed.state === 'TRIGGERED' || parsed.state === 'RE-TRIGGERED') &&
    parsed.alert_type !== null &&
    !msg.subtype &&
    !alreadyResponded;

  if (shouldRespond) {
    const alertTs = msg.ts || msg.timestamp || '';
    if (alertTs) state.respondedTs[alertTs] = now;
    if (respondedKey) state.respondedTs[respondedKey] = now;
  }

  return {
    ...msg,
    parsed,
    runbook_detail: lookupRunbook(parsed),
    should_respond: shouldRespond,
    dd_query: buildDDQuery(parsed),
    logs_query: buildLogsQuery(parsed),
  };
}

module.exports = { dedupe, decide, sweep, RESPONDED_TTL_MS };
