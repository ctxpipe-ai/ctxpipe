# Gate 0 status — full scope restored, validation in progress

The GitHub and npm 403 blockers are resolved. Gate 0 is **not complete** and Gate 1 has not started.

## Fixed points

- Starting recovery checkpoint: `f632772cb10e4a220923acf4278b47e2295a5e94`.
- Required branch: `codex/develop-plan-to-refocus-branch-direction`.
- PR 280 head: `1fad8412525efdeefdfa4899fe9a2f41dfbbc1c8`.
- PR merge base: `9072089086f6fad87fbf05572b9f1ff5336e0520`.
- Verified totals: **465 commits, 801 files, +148,441/−13,326**.
- Source inventory: **421 unique tracked test/story files** at the PR head.

See the [scope bundle](workspace-recovery-gate-0/baseline.md),
[command ledger](workspace-recovery-gate-0/evidence.tsv), and
[local validation notes](workspace-recovery-gate-0-local-evidence.md).

## Completed since the cloud checkpoint

- Fetched full ancestry and reconciled all four totals against GitHub metadata.
- Restored the transferred baseline collector and regression fixtures.
- Fixed BSD awk compatibility and duplicate test paths. The inventory now reads
  tracked files at the named PR head, excluding untracked/generated output.
- Ran a successful frozen install; both fresh migrations and upgrade from the
  exact PR merge-base schema pass against disposable pgvector/Postgres 17.
- Ran unfiltered backend/UI typechecks, all declared workspace builds, backend/UI
  tests, and CLI/CDK tests. Logs retain failures and environment qualifications.

## Remaining gate requirements

- Complete the full Storybook interaction and codesearch Docker lanes. Clean UI,
  backend, application-role isolation, explicit OpenCode and package runs are
  recorded; failures remain visible in the ledger.
- Complete and review the 414 remaining test/story classifications. Seven rows
  were reviewed; proof classifications with failing runs are not passing proof.
- Record a manual integrated golden journey, product latency, provider/request
  counts, resource cleanup, and repeated flake measurements.
- Push the candidate checkpoint and obtain independent adversarial review of the
  exact remote SHA. An in-progress checkpoint does not mean Gate 0 has passed.

## Environment recovery

The initial isolated clone lived in Documents and later exhibited filesystem
read stalls (`pread`, including a native `fsevents.node`) and stalled native git
reads. A fresh clone and a separate dependency store in `/private/tmp` avoid
reusing those dependency files. The original developer checkout and its local
changes were preserved. Node 22.16.0 is selected explicitly for resumed checks;
initial pnpm subprocesses used Node 23.10.0 despite the shell reporting Node 24.

Do not treat interrupted/stalled commands, API-origin mismatch tests, or tests
run concurrently with prebuild generation as product-failure counts. Their logs
remain for diagnosis; qualifying reruns must be separately named.

## Latest findings and review

Clean UI (291), RLS (2), CDK (32), and CLI (93 plus one skip) tests pass.
Backend has one live two-turn timeout; the explicit OpenCode route stream test
also fails. Storybook builds but its selected navigation play fails on stale
text. The codesearch host diagnostic has one timeout and does not replace the
required Docker lane. See the canonical ledger for per-run commands and limits.

The first checkpoint `0971c6314f858a8d516d8a616088facb1579e164` was pushed and
verified. Independent standards/specification review requested automated GitHub
base-ref verification, a synchronized evidence ledger, and safe/reproducible
migration tooling. Those corrections are implemented and are being re-reviewed.
The integrated journey additionally awaits approval to reuse the local model key;
automatic approval review rejected that credential-read action. Gate 0 stays open.
