'use strict';

// Invented resource names for the synthetic alert generator.
//
// Every name is prefixed `synth-`, which is the generator's primary marking
// rule: the resource is the one field that travels through the whole pipeline
// and out the far end — it lands in the parsed alert, the Datadog query, the
// prompt sent to the model, and the rendered Slack message. Prefixing it means
// there is no stage of the pipeline whose output can be mistaken for a real
// alert about a real service, including a screenshot of the final message.
//
// None of these correspond to any real service, queue, database, function,
// topic, or monitor. See "Note on data" in the README.
//
// The lists are sized so that a few hundred records spread across distinct
// `alert_type|resource` pairs rather than collapsing into a handful. They
// still collide sometimes, and that is left alone: incidental collisions in
// deduplication layer 3 are real behaviour, and the replay report counts them
// separately from the duplicates the generator planted on purpose.

const SERVICES = [
  'synth-checkout-api', 'synth-ledger-api', 'synth-notify-api',
  'synth-catalog-api', 'synth-pricing-api', 'synth-fraud-api',
  'synth-identity-api', 'synth-shipping-api', 'synth-inventory-api',
  'synth-reporting-api',
];

const FUNCTIONS = [
  'synth-settlement-worker', 'synth-invoice-render', 'synth-webhook-fanout',
  'synth-report-roller', 'synth-receipt-mailer', 'synth-ledger-compactor',
  'synth-export-scheduler', 'synth-token-refresher',
];

const QUEUES = [
  'synth-refunds-dlq', 'synth-payouts-dlq', 'synth-webhooks-dlq',
  'synth-receipts-dlq', 'synth-exports-dlq', 'synth-notifications-dlq',
];

const DATABASES = [
  'synth-orders-primary', 'synth-ledger-primary', 'synth-catalog-replica',
  'synth-identity-primary', 'synth-reporting-replica', 'synth-pricing-primary',
];

// RDS_BLOCKING is detected from a `Host:` line rather than a
// `database_instance:` tag, because the tag would be claimed by the
// RDS_CONNECTIONS branch first. Separate list, separate naming.
const DB_HOSTS = [
  'synth-orders-primary-rw', 'synth-ledger-primary-rw',
  'synth-identity-primary-rw', 'synth-pricing-primary-rw',
];

const APIS = [
  'synth-partner-gw', 'synth-mobile-gw', 'synth-internal-gw', 'synth-webhook-gw',
];

const LOAD_BALANCERS = [
  'app/synth-edge-alb', 'app/synth-internal-alb',
  'app/synth-partner-alb', 'app/synth-admin-alb',
];

const TOPICS = [
  'synth-billing-events', 'synth-audit-events',
  'synth-inventory-events', 'synth-identity-events',
];

const SUBSCRIPTIONS = [
  'synth-billing-reconciler', 'synth-billing-archiver', 'synth-audit-indexer',
  'synth-inventory-projector', 'synth-identity-syncer', 'synth-ledger-replayer',
];

const AUTH_CONNECTIONS = [
  'synth-workforce', 'synth-partners', 'synth-customers',
];

const WEB_MONITORS = [
  'synth-checkout-web', 'synth-status-web', 'synth-partner-web', 'synth-admin-web',
];

const CLUSTERS = [
  'synth-prod-cluster-a', 'synth-prod-cluster-b', 'synth-prod-cluster-c',
];

const REGIONS = [
  'us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'sa-east-1', 'ap-southeast-2',
];

const ENVS = ['prod', 'staging'];

// Non-alert channel traffic. These must parse to alert_type null so the
// response gate rejects them, which test/generate.test.js asserts for every
// generated chatter record.
const CHATTER = [
  'Reminder: the change freeze starts Friday at 18:00 UTC. No releases over the weekend.',
  'Handover note: nothing outstanding from the night shift, board is clear.',
  'Maintenance window confirmed for Sunday 02:00-04:00 UTC on the reporting stack.',
  'Heads up, the on-call rotation swaps at 07:00 UTC tomorrow.',
  'Weekly review moved to Thursday. Agenda in the usual place.',
  'Paging test completed, please ignore the notification you just received.',
  'Runbook review session scheduled, bring anything that misfired this week.',
  'Access request approved for the read-only observability role.',
];

module.exports = {
  SERVICES, FUNCTIONS, QUEUES, DATABASES, DB_HOSTS, APIS, LOAD_BALANCERS,
  TOPICS, SUBSCRIPTIONS, AUTH_CONNECTIONS, WEB_MONITORS, CLUSTERS, REGIONS,
  ENVS, CHATTER,
};
