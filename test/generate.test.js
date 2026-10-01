'use strict';

// Tests for the synthetic alert generator, tools/synth.
//
// Two of these carry more weight than the rest. The round-trip test is what
// makes "covers the 12 types the parser can emit" a checked claim rather than
// a comment, and the marker test is what keeps the synthetic marking from
// changing the behaviour it is supposed to be invisible to.

const fs = require('fs');
const path = require('path');

const { generateDataset, TYPES } = require('../tools/synth/generate');
const { MARKER_RE } = require('../tools/synth/templates');
const { parseDatadogAlert } = require('../src/parseAlert');
const { dedupe, decide } = require('../src/dedupe');
const { ALERT_TYPE_TO_RUNBOOK } = require('../src/runbooks');

const SEED = 'noc-demo';
const dataset = generateDataset({ seed: SEED, count: 200 });
const alerts = dataset.records.filter((r) => r.synth.intent !== 'chatter');
const origins = {};
for (const r of dataset.records) if (!r.synth.duplicate_of) origins[r.synth.id] = r;

/** The composite key deduplication layer 3 and the response gate both use. */
function compositeKey(parsed) {
  const res = Array.isArray(parsed.resource) ? parsed.resource[0] : (parsed.resource || '');
  return (parsed.state || '') + '|' + (parsed.alert_type || '') + '|' + res;
}

module.exports = function (t) {
  // ── determinism ───────────────────────────────────────────────────────
  const again = generateDataset({ seed: SEED, count: 200 });
  t.eq(JSON.stringify(again), JSON.stringify(dataset), 'same seed and params produce an identical dataset');

  const other = generateDataset({ seed: 'a-different-seed', count: 200 });
  t.ok(JSON.stringify(other) !== JSON.stringify(dataset), 'a different seed produces a different dataset');

  // Pins the PRNG itself. mulberry32 and the FNV-1a seed hash are part of the
  // contract: changing either silently invalidates every seed ever recorded,
  // including the one the README publishes.
  const firstAlert = dataset.records.find((r) => r.synth.intent !== 'chatter');
  t.eq(dataset.records.length, 333, 'seed noc-demo produces a pinned number of records');
  t.eq(dataset.records[0].ts, '1767236409.000001', 'its first record is pinned');
  t.eq(firstAlert.synth.alert_type, 'ECS_CPU', 'and so is the type of its first alert');
  t.eq(firstAlert.synth.resource, 'synth-inventory-api', 'and that alert\'s resource');

  // Nothing reads the clock, so the simulated window is exact.
  const startSec = Math.floor(dataset.meta.params.startTime / 1000);
  const endSec = startSec + dataset.meta.params.windowMinutes * 60;
  const inWindow = dataset.records.every((r) => {
    const s = parseInt(r.ts.split('.')[0], 10);
    return s >= startSec && s <= endSec;
  });
  t.ok(inWindow, 'every timestamp falls inside the requested window');

  const ordered = dataset.records.every((r, i) =>
    i === 0 || parseFloat(r.ts) >= parseFloat(dataset.records[i - 1].ts));
  t.ok(ordered, 'records are emitted in timestamp order, as Slack delivers them');

  // ── type coverage ─────────────────────────────────────────────────────
  // The set the parser can actually emit, read off the source the same way
  // test/coverage.test.js reads it. Tying the generator to that set means a
  // parser that gains a type fails here too, instead of leaving the dataset
  // quietly short of the thing it claims to cover.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'parseAlert.js'), 'utf8');
  const EMITTED = [...src.matchAll(/result\.alert_type = '([A-Z_0-9]+)'/g)].map((m) => m[1]);
  t.eq(TYPES.slice().sort(), EMITTED.slice().sort(),
    'the generator covers exactly the alert types the parser can emit');
  t.eq(TYPES.length, 12, 'which is 12 of the 21 in the runbook map');

  const produced = Object.keys(dataset.meta.counts.by_type).sort();
  t.eq(produced, TYPES.slice().sort(), 'a default run actually produces all 12');

  const unreachable = Object.keys(ALERT_TYPE_TO_RUNBOOK).filter((k) => !EMITTED.includes(k));
  t.ok(!produced.some((p) => unreachable.includes(p)),
    'and none of the nine unreachable types, which would be a fiction');

  // ── round trip: intended type is the parsed type ──────────────────────
  let wrongType = 0;
  for (const r of alerts) {
    if (parseDatadogAlert(r.mensaje).alert_type !== r.synth.alert_type) wrongType++;
  }
  t.eq(wrongType, 0, 'every generated alert parses back to the type it was generated as');

  let chatterTyped = 0;
  for (const r of dataset.records) {
    if (r.synth.intent === 'chatter' && parseDatadogAlert(r.mensaje).alert_type !== null) chatterTyped++;
  }
  t.eq(chatterTyped, 0, 'channel chatter parses to no alert type, so the gate rejects it');

  // ── synthetic marking ─────────────────────────────────────────────────
  t.ok(dataset.meta.synthetic === true, 'the dataset declares itself synthetic');
  t.ok(/SYNTHETIC DATA/.test(dataset.meta.warning), 'and carries a warning saying so');

  let unmarked = 0, unprefixed = 0;
  for (const r of dataset.records) {
    if (r.synthetic !== true) unmarked++;
    if (!MARKER_RE.test(r.mensaje)) unmarked++;
  }
  for (const r of alerts) {
    const res = r.synth.resource;
    // AUTH0_TOKEN is the exception: the parser hardcodes its resource to
    // 'auth0' regardless of what the alert says, so no generated name reaches
    // the pipeline for that type.
    if (r.synth.alert_type !== 'AUTH0_TOKEN' && !/^(app\/)?synth-/.test(res)) unprefixed++;
  }
  t.eq(unmarked, 0, 'every record is marked synthetic on the object and in the alert text');
  t.eq(unprefixed, 0, 'every invented resource name carries the synth- prefix into the pipeline');

  // The marker rides along through the whole pipeline, so it must not be able
  // to change a parse. This is the test that catches a marker reworded into
  // something the ordered detection chain keys on.
  let shifted = 0;
  for (const r of dataset.records) {
    const withMarker = parseDatadogAlert(r.mensaje);
    const without = parseDatadogAlert(r.mensaje.replace(MARKER_RE, ''));
    if (JSON.stringify(withMarker) !== JSON.stringify(without)) shifted++;
  }
  t.eq(shifted, 0, 'stripping the marker changes nothing the parser extracts');

  // ── bursts and the three deduplication layers ─────────────────────────
  const kinds = dataset.meta.counts.by_duplicate_kind;
  t.ok(kinds.exact_ts > 0, 'the dataset plants exact-timestamp duplicates (layer 1)');
  t.ok(kinds.exact_text > 0, 'and identical-text duplicates (layer 2)');
  t.ok(kinds.same_key > 0, 'and same-composite-key duplicates (layer 3)');

  let badTs = 0, badText = 0, badKey = 0, badWindow = 0, sharedTs = 0;
  for (const r of dataset.records) {
    const kind = r.synth.duplicate_kind;
    if (!kind) continue;
    const origin = origins[r.synth.duplicate_of];

    if (kind === 'exact_ts') {
      if (r.ts !== origin.ts) badTs++;
    } else if (kind === 'exact_text') {
      if (r.mensaje !== origin.mensaje) badText++;
      if (r.ts === origin.ts) sharedTs++;
    } else if (kind === 'same_key') {
      // Must survive layers 1 and 2 and be caught only by layer 3.
      if (r.ts === origin.ts) sharedTs++;
      if (r.mensaje.substring(0, 200) === origin.mensaje.substring(0, 200)) badWindow++;
      if (compositeKey(parseDatadogAlert(r.mensaje)) !== compositeKey(parseDatadogAlert(origin.mensaje))) badKey++;
    }
  }
  t.eq(badTs, 0, 'exact_ts duplicates really do reuse their origin timestamp');
  t.eq(badText, 0, 'exact_text duplicates are byte-identical to their origin');
  t.eq(sharedTs, 0, 'and the other two kinds carry a distinct timestamp, so layer 1 cannot claim them');
  t.eq(badWindow, 0, 'same_key duplicates differ inside the 200 characters layer 2 compares');
  t.eq(badKey, 0, 'same_key duplicates keep their origin composite key, so layer 3 catches them');

  // The planted duplicates are not a description of intent — deduplication
  // actually drops them.
  let survivedDuplicates = 0;
  for (const r of dataset.records) {
    if (!r.synth.duplicate_kind) continue;
    const origin = origins[r.synth.duplicate_of];
    const survivors = dedupe([origin, r], {}, Date.parse('2026-01-01T03:00:00Z'));
    if (survivors.length !== 1) survivedDuplicates++;
  }
  t.eq(survivedDuplicates, 0, 'every planted duplicate is dropped when replayed behind its origin');

  // ── intents reach the pipeline as intended ────────────────────────────
  const intents = dataset.meta.counts.by_intent;
  t.ok(intents.incident > 0 && intents.noise > 0 && intents.chatter > 0,
    'the default mix produces incidents, noise and chatter');

  let recoveredAnswered = 0, subtypeAnswered = 0;
  for (const r of dataset.records) {
    const item = decide(r, {}, Date.parse('2026-01-01T03:00:00Z'));
    if (item.parsed.state === 'RECOVERED' && item.should_respond) recoveredAnswered++;
    if (r.subtype && item.should_respond) subtypeAnswered++;
  }
  t.ok(dataset.records.some((r) => r.synth.state === 'RECOVERED'), 'recoveries are generated');
  t.eq(recoveredAnswered, 0, 'and no recovery ever passes the response gate');
  t.ok(dataset.meta.counts.with_subtype > 0, 'some records arrive with a Slack subtype');
  t.eq(subtypeAnswered, 0, 'and the gate rejects all of them');

  // The gate is an && chain evaluated in order, so a subtype on a chatter
  // message proves nothing — the missing state rejects it first. Only a
  // well-formed alert carrying a subtype reaches that condition.
  const subtypedAlerts = dataset.records.filter((r) => r.subtype && r.synth.intent !== 'chatter');
  t.ok(subtypedAlerts.length > 0, 'including well-formed alerts, which is what actually tests that condition');
  t.ok(subtypedAlerts.every((r) => parseDatadogAlert(r.mensaje).alert_type !== null),
    'those alerts parse cleanly, so the subtype is the only thing rejecting them');

  // ── parameters ────────────────────────────────────────────────────────
  const small = generateDataset({ seed: SEED, count: 10, burstRatio: 0, chatterRatio: 0 });
  t.eq(small.records.length, 10, 'count is exact when no bursts are requested');
  t.eq(small.meta.counts.bursts, 0, 'and burstRatio 0 plants no duplicates');
  t.ok(small.records.every((r) => r.synth.intent !== 'chatter'), 'chatterRatio 0 emits no chatter');

  const oneType = generateDataset({ seed: SEED, count: 25, types: ['RDS_BLOCKING'] });
  t.eq(Object.keys(oneType.meta.counts.by_type), ['RDS_BLOCKING'], 'the type list restricts what is generated');

  const narrow = generateDataset({ seed: SEED, count: 30, windowMinutes: 5 });
  const span = parseFloat(narrow.records[narrow.records.length - 1].ts) - parseFloat(narrow.records[0].ts);
  t.ok(span <= 5 * 60 + 150, 'a narrow window really does compress the dataset in time');

  let threw = false;
  try { generateDataset({ seed: SEED, count: 5, types: ['FLAP_DETECTION'] }); } catch (e) { threw = /unknown alert type/.test(e.message); }
  t.ok(threw, 'asking for a type the parser cannot emit is an error, not an empty dataset');
};
