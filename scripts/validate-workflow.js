'use strict';

// Guards the published export: it must stay valid JSON, it must not regain any
// real credential or identifier, and the code nodes that src/ mirrors must
// still exist, with each module keeping its entry point. It does not compare
// the code itself, so it cannot prove the two are identical.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'workflows', 'NOC_bot.json');
const raw = fs.readFileSync(file, 'utf8');

let wf;
try {
  wf = JSON.parse(raw);
} catch (e) {
  console.error('✗ workflow is not valid JSON: ' + e.message);
  process.exit(1);
}

const problems = [];

// --- structure ---
if (!Array.isArray(wf.nodes) || wf.nodes.length === 0) problems.push('no nodes');
if (!wf.connections) problems.push('no connections');
if (wf.active !== false) problems.push('active must be false in the published export');
if (wf.pinData && Object.keys(wf.pinData).length) problems.push('pinData must be empty (it can carry real execution samples)');

// --- nothing that identifies a person, a tenant, or an account ---
const FORBIDDEN = [
  [/\bxox[abposr]-[A-Za-z0-9-]+/, 'Slack token'],
  [/\bsk-ant-[A-Za-z0-9\-_]+/, 'Anthropic key'],
  [/\bgsk_[A-Za-z0-9]{20,}/, 'Groq key'],
  [/\bddapp_[A-Za-z0-9]{20,}/, 'Datadog application key'],
  [/"DD-API-KEY",\s*"value":\s*"(?!YOUR_)[0-9a-f]{32}"/, 'Datadog API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/hooks\.slack\.com\/\S+/, 'Slack webhook URL'],
  [/<@U[A-Z0-9]{8,}>/, 'Slack member id'],
  [/"value":\s*"C[A-Z0-9]{8,}"/, 'Slack channel id'],
  [/\b\d{12}\b/, 'AWS account id'],
];
for (const [re, label] of FORBIDDEN) {
  if (re.test(raw)) problems.push(`contains what looks like a ${label}`);
}

// --- the runbook catalog stays synthetic ---
const parseNode = wf.nodes.find((n) => n.name === 'Parsear Alerta');
if (!parseNode) problems.push('the Parsear Alerta node is missing');
else {
  const code = parseNode.parameters.jsCode || '';
  const ids = [...code.matchAll(/"(RUNBOOK-\d{3})":\s*\{/g)].map((m) => m[1]);
  const expected = ['RUNBOOK-001', 'RUNBOOK-009', 'RUNBOOK-019'];
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    problems.push(`runbook catalog should be exactly ${expected.join(', ')} — found ${ids.join(', ') || 'none'}`);
  }
  if (!/EJEMPLO SINTETICO/.test(code)) problems.push('runbook entries are no longer marked synthetic');
}

// --- the export and src/ must not drift apart ---
// src/ is extracted from the code nodes; if a node changes without the module
// changing, the tests stop testing what actually runs.
const pairs = [
  ['Clasificar Prioridad', 'classifyPriority.js', /function classifyPriority/],
  ['Procesar Enriquecimiento', 'enrich.js', /function buildClaudePrompt/],
  ['Construir Mensaje Final', 'formatMessage.js', /function buildSlackMessage/],
];
for (const [nodeName, mod, marker] of pairs) {
  const node = wf.nodes.find((n) => n.name === nodeName);
  if (!node) { problems.push(`node ${nodeName} is missing`); continue; }
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', mod), 'utf8');
  if (!marker.test(src)) problems.push(`src/${mod} no longer defines its entry point`);
}

if (problems.length) {
  console.error('✗ workflow export failed validation:');
  problems.forEach((p) => console.error('   - ' + p));
  process.exit(1);
}
console.log(`✓ workflow export is valid — ${wf.nodes.length} nodes, no credentials, synthetic catalog intact`);
