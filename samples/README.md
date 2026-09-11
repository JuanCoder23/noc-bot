# Sample alerts

Synthetic Datadog alert texts, written for this repository. They follow the
shape the parser expects — a state in the first line, a query line, a value and
threshold, a tag block, and an optional runbook reference — using invented
service, queue, and database names.

No captured production alert is included here. See "Note on data" in the README.

These nine are hand-written fixtures, chosen to pin specific parser behaviours,
and they are what `npm test` and `npm run demo` run against. They are not the
same thing as the generated dataset: `tools/synth` produces alerts in volume
from a seed, covering all 12 alert types the parser can emit, and feeds
`npm run replay`. Use these to reason about one parsing decision; use the
generator to exercise the pipeline.

| File | Exercises |
|---|---|
| `alerts/ecs-cpu-triggered.txt` | The common path: TRIGGERED, tags, runbook reference, monitor URL |
| `alerts/ecs-cpu-retriggered.txt` | RE-TRIGGERED state, metric barely over threshold |
| `alerts/ecs-cpu-recovered.txt` | RECOVERED — parsed, never answered |
| `alerts/lambda-errors.txt` | A different resource type (`functionname`) and an `.as_count()` query |
| `alerts/rds-connections.txt` | `database_instance` resource type |
| `alerts/sqs-dlq.txt` | `queuename` resource type |
| `alerts/flap-detection.txt` | WARN on a flapping monitor — the NOISE path |
| `alerts/synthetics-down.txt` | Prose-form resource extraction, no tag block |
| `alerts/unparseable.txt` | Not an alert. `alert_type` stays null and the response gate rejects it |
