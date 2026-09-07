# Gate 0 measured baseline

The canonical uninstrumented series is `logs/http-measurements.jsonl`: 5 cold
(new conversation, prepare then send; backend/OS caches retained) and 20 warm
(same conversation after its first turn) samples. It uses real authenticated
HTTP/SSE and a local native Git fixture after explicitly seeding its desired SHA.
It is not browser/WebSocket latency or a completed clean golden journey.

`python3 docs/plans/workspace-recovery-gate-0/summarize-measurements.py
 docs/plans/workspace-recovery-gate-0/logs/http-measurements.jsonl` regenerates
`logs/http-summary.json`. Quantiles use **nearest rank**, not interpolated median.
All values below are milliseconds, in p50 / p95 / maximum order.

| Observation | Cold (5) | Warm (20) |
| --- | --- | --- |
| Workspace GET | 14.04 / 19.10 / 19.10 | 23.57 / 31.23 / 31.36 |
| Prepare response | 169.01 / 185.00 / 185.00 | 169.42 / 192.30 / 204.48 |
| Send → first SSE event | 25.11 / 27.35 / 27.35 | 24.22 / 30.62 / 30.97 |
| Send → first text | 5727.18 / 6424.17 / 6424.17 | 5815.03 / 6607.53 / 9064.69 |
| Send → terminal | 8311.27 / 9531.03 / 9531.03 | 5970.21 / 6802.45 / 9215.26 |
| Send complete | 8312.78 / 9532.63 / 9532.63 | 5971.68 / 6804.07 / 9216.70 |
| Subsequent history GET | 34.43 / 41.61 / 41.61 | 25.26 / 34.07 / 38.15 |

History GET latency measures observation after terminal, not the exact internal
write-commit instant. First text already misses the roughly five-second useful
answer target. Slow samples remain in all quantiles.

The narrowly defined turn oracle is HTTP 200, exactly one RUN_FINISHED, no
RUN_ERROR, and text containing Clockwork. **25/25 pass; observed failure rate
0/25** for this oracle only. This is not UI or golden-journey flake evidence,
nor a statistical guarantee. The Home first-send failure is recorded separately.

There are **25 distinct OpenCode sessions and 25 distinct sandbox directories**,
including 20 new ones during the warm series. The 21 sends in the same conversation
return exactly three history records every time, rather than accumulating turns.
Thus transcript continuity and warm no-provider-creation requirements fail even
though every single-turn answer succeeds. The identical prompts do not constitute
an independent conversational-memory oracle.

`logs/http-runtime-counts.json` contains the associated runtime timing values and
**50 real model-proxy requests** (two generations per turn). The native-remote
path makes zero GitHub network requests and transfers zero GitHub bytes; this is
not evidence for the GitHub-connected warm path. Each chat-create is logged
`attached: false`. Prepare additionally executes ensure once per sample; exact
provider create/attach calls outside the observed session directories were not
intercepted. The runtime phase measurements distinguish prepare/ensure,
github-resolve, proxy-and-tools and chat creation.

The instrumented follow-up is a separate artifact, with 5 cold and 20 warm turns,
UTC boundaries, process and socket snapshots, and PostgreSQL statement counting.
The UI is navigated away and the worker is stopped during this follow-up. Its
fixture has synthetic writable capability; do not pool its timings with the first
series. Bound parameter values are disabled in PostgreSQL logs.

## Browser traffic and resource observations

In one stationary README-pane window the backend records **20 / 128 / 256**
completed API requests within **5 / 30 / 60 seconds**, respectively. Each includes
repeated tree/status polling. `logs/ui-request-windows.jsonl` contains every
request and status. These are cumulative windows in one series, not independent
replicates. Browser bundle requests and WebSocket frames are excluded.

The Home first action produced two prepare POSTs and two chat GET requests, plus
two touch requests. No first-turn model request or completion is observed. A later
explicit Send produces a real successful WebSocket turn. GET /chat status 200
alone does not prove the number of WebSocket messages sent.

After navigation to Home, the backend retained seven TCP connections to the
browser, nine DB connections, three UI-proxy connections and two remote HTTPS
connections in the captured snapshot (`resources-before-restart.json`). TCP
connections are not identified as WebSocket frames: devtool SSE, HMR and HTTP
keep-alive also exist. The two surviving OpenCode processes predate these model
measurements and have different cwd directories; they are not attributed as leaks
from the 25-sample series and were left untouched.

All 25 observed provider directories are absent after five production DELETEs;
`logs/measurement-directory-cleanup.json` records the paths. The associated
workspace_sandbox_instances query returns zero rows. Cleanup checks must be read
with the final resource artifact, not inferred from HTTP 204 alone.

## Unreached phases

The clean native-remote journey fails at immutable tip resolution. Consequently
successful hydrate read/parse/activation/derived-store phase timings, typed job
queue/transform/commit/push, successful Home first-message acceptance, and
successful publish-to-PR timings are **NOT_REACHED**, not zero. Diagnostic file
PUT/read/diff and rejected push/PR timings are in `file-publish-diagnostic.jsonl`;
these are one-shot diagnostic results, not 5/20 successful-path percentiles.
`golden-journey.md` identifies the bypasses and blocking steps. Later gate proof
must replace these censored baseline observations with successful end-to-end
measurements; Gate 0 does not certify product correctness.


## Instrumented follow-up result and final cleanup

The second series also has 25/25 successful per-turn oracles and 25 distinct
sessions/directories. First-text p50/p95/max: cold **5548.85 / 6797.22 / 6797.22**
ms; warm **5642.64 / 6779.12 / 6861.28** ms. Complete metrics are in
`logs/http-instrumented-summary.json`.

PostgreSQL statement counts per entire sample (workspace GET + prepare + send +
history GET, including transactions) are cold **215 / 215 / 215** and warm
**221 / 221 / 221** at p50/p95/max. Individual counts and UTC windows are in
`database-query-counts.json`, backed by parameter-free `database-statements.log`.
The warm minimum is 220; small boundary differences are retained. These counts
are not exclusively the send endpoint and must not be described as such.

After deleting both measurement series and manual conversations, all 52 captured
model-run directories were absent. Two additional empty conversations created by
UI navigation remained, one with a sandbox; these were then deleted through the
same production API. Final `navigation-database-cleanup.log` reports zero rows
for both workspace conversations and sandbox instances, and
`navigation-resource-cleanup.json` records that its directory **still exists** after DELETE: one observed directory leak.
The schema has no separate public lease table; retained instance state is checked
through workspace_sandbox_instances. Two pre-existing OpenCode processes remain
with unrelated directories and were preserved. No surviving process can be
attributed to the measured or navigation directories. TCP snapshots remain raw
and do not pretend to distinguish WebSocket/SSE/HTTP keep-alive connections.
