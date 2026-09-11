'use strict';
const { parseDatadogAlert, buildDDQuery, buildLogsQuery } = require('../src/parseAlert');
const { lookupRunbook } = require('../src/runbooks');
const { load, names } = require('./fixtures');

module.exports = function (t) {
  // ---- states -------------------------------------------------------
  t.eq(parseDatadogAlert(load('ecs-cpu-triggered')).state, 'TRIGGERED', 'TRIGGERED parsed');
  t.eq(parseDatadogAlert(load('ecs-cpu-retriggered')).state, 'RE-TRIGGERED', 'RE-TRIGGERED not swallowed by TRIGGERED');
  t.eq(parseDatadogAlert(load('ecs-cpu-recovered')).state, 'RECOVERED', 'RECOVERED parsed');
  t.eq(parseDatadogAlert(load('flap-detection')).state, 'WARN', 'WARN parsed');

  // ---- severity is derived from state --------------------------------
  t.eq(parseDatadogAlert(load('ecs-cpu-triggered')).severity, 'ALERT', 'TRIGGERED -> ALERT');
  t.eq(parseDatadogAlert(load('ecs-cpu-recovered')).severity, 'OK', 'RECOVERED -> OK');
  t.eq(parseDatadogAlert(load('flap-detection')).severity, 'WARN', 'WARN -> WARN');

  // ---- resource extraction per type ----------------------------------
  const cases = [
    ['ecs-cpu-triggered', 'ECS_CPU', 'servicename', 'checkout-api'],
    ['lambda-errors', 'LAMBDA_ERROR', 'functionname', 'payments-settlement-worker'],
    ['rds-connections', 'RDS_CONNECTIONS', 'database_instance', 'orders-primary'],
    ['sqs-dlq', 'SQS_DLQ', 'queuename', 'refunds-processor-dlq'],
    ['synthetics-down', 'SYNTHETICS', 'service', 'checkout-web'],
  ];
  for (const [file, type, rtype, resource] of cases) {
    const p = parseDatadogAlert(load(file));
    t.eq(p.alert_type, type, `${file} -> ${type}`);
    t.eq(p.resource_type, rtype, `${file} resource_type`);
    t.eq(p.resource, resource, `${file} resource`);
  }

  // ---- numeric and metadata extraction --------------------------------
  const cpu = parseDatadogAlert(load('ecs-cpu-triggered'));
  t.eq(cpu.metric_value, 92.4, 'metric value parsed as float');
  t.eq(cpu.threshold, 85, 'threshold parsed');
  t.eq(cpu.region, 'us-east-1', 'region parsed');
  t.eq(cpu.runbook, 'RUNBOOK-001', 'runbook reference parsed');
  t.ok(/app\.datadoghq\.com\/monitors\/10000001/.test(cpu.monitor_url), 'monitor URL parsed');
  t.eq(parseDatadogAlert(load('rds-connections')).region, 'eu-west-1', 'a different region parses too');

  // ---- non-alerts degrade rather than throw ---------------------------
  const junk = parseDatadogAlert(load('unparseable'));
  t.eq(junk.alert_type, null, 'a non-alert yields no alert_type');
  t.eq(junk.resource, null, 'a non-alert yields no resource');
  t.eq(parseDatadogAlert('').alert_type, null, 'empty string is safe');
  t.eq(parseDatadogAlert(null).alert_type, null, 'null is safe');
  t.eq(parseDatadogAlert(undefined).state, null, 'undefined is safe');

  // ---- query building -------------------------------------------------
  const lam = parseDatadogAlert(load('lambda-errors'));
  t.ok(/functionname:payments-settlement-worker/.test(buildDDQuery(lam)), 'DD query carries the resource');
  t.ok(!/as_count\(\)/.test(buildDDQuery(lam)), '.as_count() is stripped from the embedded query');
  t.ok(/status:error/.test(buildLogsQuery(lam)), 'logs query filters to errors');
  t.eq(buildLogsQuery(junk), null, 'no resource -> no logs query');

  // ---- runbook lookup -------------------------------------------------
  t.eq(lookupRunbook(cpu).id, 'RUNBOOK-001', 'runbook resolved from the alert reference');
  t.eq(lookupRunbook(cpu).source, 'explicit', 'an in-text RUNBOOK-nnn reference wins');

  // With no reference in the text, the alert_type mapping is the fallback.
  const auto = lookupRunbook({ alert_type: 'ECS_CPU', runbook: null });
  t.eq(auto.id, 'RUNBOOK-001', 'runbook resolved by alert_type mapping');
  t.eq(auto.source, 'auto_mapped', 'and is reported as auto-mapped');

  // A reference to a runbook this repository does not ship resolves to null
  // rather than to a stub: only the three synthetic runbooks have content.
  t.eq(lookupRunbook(parseDatadogAlert(load('sqs-dlq'))), null,
    'a mapped id with no catalog entry yields null');
  t.eq(lookupRunbook(junk), null, 'no alert_type -> no runbook');

  // ---- every sample parses without throwing ---------------------------
  for (const n of names()) {
    let ok = true;
    try { parseDatadogAlert(load(n)); } catch { ok = false; }
    t.ok(ok, `${n} parses without throwing`);
  }
};
