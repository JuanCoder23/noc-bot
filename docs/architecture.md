# Architecture

This document covers the data flow and the failure behaviour of `workflows/NOC_bot.json`. For what the system is, why it exists, and the reasoning behind the four main design decisions, see the [README](../README.md).

Everything below describes the workflow as exported in this repository. Where the implementation has a known weakness, it is stated rather than smoothed over.

## Execution model

The workflow is a **polling** pipeline, not an event-driven one. A schedule trigger fires every **2 minutes** and reads Slack channel history with `oldest = now - 5 minutes`.

Those two windows are deliberately mismatched: a 5-minute read window on a 2-minute interval means every message is read roughly two to three times before it ages out. Nothing downstream is idempotent by construction, so **the deduplication layer is load-bearing** — it is what turns an overlapping read into single-response behaviour. The overlap buys tolerance for a skipped or slow run; the cost is that correctness now depends on dedup state being intact.

The trigger has a second, redundant connection directly to the `Formatear Mensaje` node, alongside the one through the Slack node. Each run therefore injects one extra item carrying trigger metadata and no message fields. It is filtered out immediately by the `Tiene contenido` gate, so it is harmless, but it is a leftover rather than a design.

## Data flow

### 1. Ingestion and normalization

`Get the history of a channel` → `Formatear Mensaje`

Slack messages are flattened into a fixed shape. Alert content is taken from `text`, falling back to the first attachment's `title` + `pretext` + `text`, because Datadog delivers alerts as attachments rather than plain text.

| Field | Source |
|---|---|
| `mensaje` | `text`, else the assembled attachment body |
| `timestamp` | `ts` |
| `canal` | `channel` |
| `thread_ts`, `reply_count` | thread state, used to tell an unanswered alert from an answered one |
| `subtype` | used to exclude bot edits and joins |
| `monitor_url` | first attachment's `title_link` |

`Tiene contenido` drops anything with an empty `mensaje`.

### 2. Parsing

`Parsear Alerta` is the largest node in the workflow and does four separate jobs: parse, deduplicate, decide whether to respond, and look up the runbook.

Parsing is **regex over the alert text**, not a schema. There is no structured Datadog webhook payload to rely on, because the alert arrives as rendered Slack text. It extracts:

- **State** — `TRIGGERED`, `RE-TRIGGERED`, `RECOVERED`, or `WARN`, from the first line.
- **Severity** — derived from state: `RECOVERED` → `OK`, `TRIGGERED`/`RE-TRIGGERED` → `ALERT`, everything else → `WARN`.
- **Alert type** — an ordered chain of substring tests against the message body, resolving to one of 20 types (`ECS_CPU`, `LAMBDA_ERROR`, `RDS_BLOCKING`, `SQS_DLQ`, `SYNTHETICS`, and so on). The chain is ordered, so the first match wins.
- **Resource and resource type** — per alert type, from the alert's tag block where present (`servicename:`, `functionname:`, `queuename:`, `apiname:`, `loadbalancer:`), falling back to a `Host:` line.
- **Region, AWS account, metric value, threshold, monitor URL, and the Datadog query** — generic patterns applied to the whole body.

The parser is written to degrade: any field it cannot find stays `null` and the pipeline continues. An unrecognized `alert_type` is the one exception, because the response gate requires it.

### 3. Deduplication

Deduplication runs **before any enrichment call**, in three within-run layers plus one cross-run layer.

Within a single execution, an item is dropped if it matches an earlier item on any of:

1. exact Slack `ts`
2. the first 200 characters of message text
3. the composite key `state|alert_type|resource`

Layer 3 is what catches the same condition delivered twice as two distinct Slack messages, which layers 1 and 2 would both miss.

Across executions, state lives in `$getWorkflowStaticData('global').respondedTs` — a flat map of key → timestamp, swept on every run to drop entries older than **10 minutes**. Each answered alert writes two entries: its raw `ts`, and the composite `state|alert_type|resource` key.

The composite key includes `state` on purpose. It allows the bot to answer a `WARN` and then answer the `TRIGGERED` from the same monitor on the same resource, while refusing to answer the same state twice.

### 4. Response gate

`Debe responder` passes an item only when all of the following hold:

- state is `WARN`, `TRIGGERED`, or `RE-TRIGGERED`
- `alert_type` is not `null`
- the Slack message has no `subtype`
- the composite key is not already in `respondedTs`

`RECOVERED` is excluded, so recoveries are never answered.

### 5. Priority classification

`Clasificar Prioridad` produces a `noise_score` from 0 to 100 and a band. Scoring starts at 50 and is adjusted:

| Signal | Effect |
|---|---|
| Type in `{PULSAR_BACKLOG, RDS_BLOCKING}` | score capped down to 20 |
| Type is `FLAP_DETECTION` | +30 |
| State `RE-TRIGGERED` | −15 |
| State `WARN` | +10 |
| Metric > 1.5× threshold | −25 |
| Metric < 1.1× threshold | +15 |
| Same `alert_type\|resource` fired 2 / 3 / 5+ times in 30 min | +10 / +20 / +30 |
| **State `TRIGGERED` or `RE-TRIGGERED`** | **score capped at 69** |

The final cap is the fail-safe described in the README. It is applied last, after every noise signal, so no combination of them can push an actively firing alert into the NOISE band.

Bands: `> 70` NOISE, `> 50` P3, `> 30` P2, otherwise P1.

Firing frequency is counted in a second static-data map, `recentFires`, with a **30-minute** window — distinct from the 10-minute `respondedTs` map, and swept independently.

### 6. The NOISE branch

`Es NOISE?` splits the flow. NOISE items get a `no_bell` Slack reaction and a Sheets row with `tokens_used = 0`, and stop there. **No enrichment call and no model call is made for them.** This is where the API-budget saving in decision (c) actually lands.

### 7. Parallel enrichment

Everything that is not NOISE fans out to five independent calls:

| Branch | Request | Window | Timeout |
|---|---|---|---|
| Datadog Metrics | `GET v1/query`, query built from the parsed alert | 30 min around the alert | 10 s |
| Datadog Logs | `POST v2/logs/events/search`, sorted `-timestamp`, `limit: 10` | last 15 min | 10 s |
| Datadog Events | `GET v1/events`, tagged `resource_type:resource` | last 1 h | 10 s |
| Slack correlation | channel history, `limit: 100` | last 1 h | — |
| AWS Health | `POST DescribeEvents`, region from the alert or `us-east-1`, status `open`/`upcoming`, `maxResults: 5` | current | 8 s |

Datadog credentials are passed as **plain header parameters** on each HTTP node (`DD-API-KEY`, `DD-APPLICATION-KEY`), not as an n8n credential object. The same is true of the Anthropic key. This is why those values appear as `YOUR_*` placeholders in the exported JSON rather than as credential references — worth knowing before importing, since it means the keys live in the workflow body.

### 8. Merge and consolidation

The five branches converge on a `Merge` node in `combine` / `combineByPosition` mode with 5 inputs, then `Consolidar enriquecimiento` assembles a single object.

Consolidation guards every branch with `$if($("Node").isExecuted, ..., {})`, so a branch that never ran contributes an empty object rather than an undefined reference. Priority, noise score, and the classification reason are pulled back in from `Clasificar Prioridad` by item index.

### 9. Prompt assembly

`Procesar Enriquecimiento` summarizes rather than forwards. Each summarizer returns `{ available: false }` when its input is missing or empty, and the prompt builder omits the corresponding section:

- **Metrics** — average, max, min, and a direction derived by comparing the mean of the first half of the series against the second (>1.2× rising, <0.8× falling).
- **Logs** — up to 5 entries kept, 3 rendered, each truncated to 150 characters with newlines flattened.
- **Events** — first 10 examined, split into deploys and other changes by testing the title for `deploy` or `release`, 3 of each retained, 2 rendered.
- **Correlation** — a count of recent channel messages matching either the resource string or the alert type, with a recurring-pattern marker at 3 or more.
- **AWS Health** — a count of open incidents in the region.

Only this summary reaches the model. Raw API responses are never forwarded.

### 10. Model call

`POST https://api.anthropic.com/v1/messages`, `claude-haiku-4-5`, `max_tokens: 1024`, `anthropic-beta: prompt-caching-2024-07-31`, 30 s timeout.

The request is split deliberately:

- the **system block** holds the runbook catalog and the response instructions, marked `cache_control: { type: "ephemeral" }`, and is byte-identical across calls
- the **user message** holds only the per-alert summary from step 9

That split is the entire caching strategy. It only works while the system block does not change, which is the constraint noted in the README.

### 11. Output

`Construir Mensaje Final` renders a Slack message with a priority badge, the parsed alert fields, the available evidence blocks, the model's analysis, the matched runbook, and a link to the monitor. `Responder en hilo` posts it as a reply using the original alert's `ts` as `thread_ts`.

`Registrar en Sheets` then appends a 19-column row: `timestamp`, `alert_type`, `state`, `severity`, `resource`, `region`, `runbook_id`, `runbook_source`, `response_time_ms`, `ai_provider`, `ai_success`, `tokens_used`, `thread_ts`, `channel`, `message_preview`, `priority`, `noise_score`, `classification_reason`, `metric_value`.

`response_time_ms` is measured from the alert's own Slack timestamp to the moment the row is written, so it covers polling latency as well as processing.

## Error handling

### What is configured

| Node | Setting | Effect |
|---|---|---|
| DD Metrics / Logs / Events | `neverError: true` | A non-2xx response is passed downstream as data instead of failing the run |
| Claude | `neverError: true` | Same — an API error becomes a response body the pipeline carries forward |
| AWS Health | `neverError: true` + `continueOnFail` | Fully optional; both the HTTP layer and the node layer are non-fatal |
| Registrar en Sheets | `continueOnFail` | A logging failure does not lose the Slack reply that already went out |
| Slack: Reacción NOISE | `continueOnFail` | Cosmetic |
| Sheets: Log NOISE | `continueOnFail` | Cosmetic |

The design intent is a **degradation ladder**: enrichment is best-effort, and the diagnosis is produced from whatever context arrived. A Datadog outage does not stop the bot from answering — it produces an answer with `MÉTRICAS: No disponibles` and correspondingly less to reason from. The `available: false` guards in step 9 are what make this safe, since a failed call and an empty result reach the prompt builder identically.

### What is not configured

**No node has `retryOnFail` set.** There is no retry anywhere in the workflow, no backoff, and no dead-letter path. The recovery mechanism for a transient failure is the next poll, 2 minutes later — and only if dedup state has not already marked the alert as answered. See the failure mode below.

**Three nodes are fatal on error**, having neither `neverError` nor `continueOnFail`:

- `Get the history of a channel` — a Slack API failure aborts the run before anything is read
- `Slack: Correlación (1h)` — a failure here aborts a run that has already passed the response gate
- `Responder en hilo` — the reply itself

The code nodes are also fatal on an uncaught exception, though they are written defensively throughout.

### Known failure modes

**An alert can be marked answered without being answered.** `respondedTs` is written in `Parsear Alerta`, at the moment the response gate passes — before enrichment, before the model call, and before the Slack reply. If the run aborts after that point, most plausibly at `Slack: Correlación (1h)` or `Responder en hilo`, the alert is recorded as handled and will be suppressed by dedup for the next 10 minutes. It is neither answered nor retried, and because `Registrar en Sheets` never runs, no row is written either. The alert is silently dropped.

This is the sharpest gap in the current implementation. Moving the `respondedTs` write to after a successful reply would close it, at the cost of allowing duplicate replies when the write itself fails.

**Merge alignment is positional.** `combineByPosition` across 5 inputs assumes the branches emit items in matching order and count. It holds because each branch emits one item per alert, but it is an assumption the node does not verify, and a branch that emits zero or two items would misalign the others rather than error.

**Dedup state is instance-local and short-lived.** `respondedTs` lives in n8n's per-workflow static data. It does not survive a workflow re-import, and its 10-minute TTL is shorter than the 1-hour correlation window and the 30-minute frequency window it sits alongside. A restart during an incident clears the memory of what was already answered.

**Model errors are indistinguishable from model output at the HTTP layer.** Because `neverError: true` is set, an Anthropic API error is carried forward as a response body. The downstream code reads `ai_success` and token counts defensively, but the failure surfaces as a degraded Slack reply rather than as a run failure that anyone would notice.

**Nine mapped alert types cannot be produced.** `ALERT_TYPE_TO_RUNBOOK` covers 21 alert types, but the detection chain in `parseDatadogAlert` only ever assigns 12 of them: `ALB_RESPONSE_TIME`, `APIGW_4XX`, `AUTH0_TOKEN`, `ECS_CPU`, `ECS_GENERIC`, `ECS_MEMORY`, `LAMBDA_ERROR`, `PULSAR_BACKLOG`, `RDS_BLOCKING`, `RDS_CONNECTIONS`, `SQS_DLQ` and `SYNTHETICS`. The other nine — `APM_ERRORS`, `APM_LATENCY`, `ECS_HIGH_TASK`, `ECS_LOW_TASK`, `ECS_NETWORK`, `ECS_STORAGE`, `FLAP_DETECTION`, `LAMBDA_INVOCATIONS` and `SNOWFLAKE_ERROR` — have runbooks and mappings that nothing can reach. An alert of one of those kinds falls through to a coarser branch or to no type at all.

One consequence is worth naming separately: `FLAP_DETECTION` is the only member of the classifier's `INHERENTLY_NOISY` set, so that branch of the scoring never executes. Flapping monitors are still caught, but by the frequency signal rather than by type. `test/coverage.test.js` asserts the exact unreachable set, so closing the gap surfaces as a failing test rather than as silence.

**Enrichment failures are invisible.** A branch that times out contributes an empty object and the prompt simply omits that section. Nothing in the Sheets log distinguishes "no metrics existed for this alert type" from "Datadog timed out", so the run log cannot be used to measure enrichment reliability.
