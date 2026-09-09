# Gate 3 remaining acceptance

Current reviewed candidate: f7c354334bb91310f3a49f74563bce6497c688ca, zero blockers on both cumulative axes after focused corrections. CI 34294500881 passed twelve non-test jobs; one stale Notion cancellation fixture in the backend lane was corrected and both native cases pass. Revised test-only candidate awaits final CI. Gates 0–2 complete; Gate 3 awaits CI; Gates 4–6 pending.
User approvals persist: autonomous work, pushes to the recovery branch, existing model key.

This is the current ledger. status.md is historical evidence, not a work queue.

| Item | Requirement / gap | Closure evidence | State |
| --- | --- | --- | --- |
| G3-A | Native workflow ownership: connector wrong-version recovery; audit matching repository paths; finish retirement of test-only activation helpers | Public native admission rejects wrong identity; existing finalization and ingestion contracts pass | Reviewed: zero blockers; milestone CI pending |
| G3-B | Retry / resume idempotency: persisted semantic handoff after lost reply and a second tip advance; legacy paused binding | Native replay retains exact persisted handoff and publishes at most one commit | Reviewed: zero blockers; milestone CI pending |
| G3-C | Empty repository lifecycle / bootstrap | Empty hydrate remains empty; allowed bootstrap creates first real commit; concurrent first writer handled without fabricated read SHA | Reviewed: zero blockers; adopted-root hydration fixed and seven native cases pass |
| G3-D | Extraction producer and source isolation | Integrated producer through captured extraction and typed Git publication; in-flight older source cannot replace newer published source | Reviewed: real producer and held older clone; zero D blockers |
| G3-E | Worker / allocation crash ownership | Process-kill proof at model/sandbox allocation boundary; replacement resumes and cleanup completes | Reviewed: zero blockers; both actual SIGKILL boundaries, stable Docker identity, one commit, independent expiry cleanup; Bun 1.4.2 required |
| G3-F | Required retirement and policy audit | Every default-branch push has one typed owner; superseded lifecycle removed; config ordering and linked declaration behavior match locked specs | Reviewed: ownership-audit.md; final root authority and retired mutator corrections accepted on both axes |
| G3-G | Gate closure | Affected checks, full CI on closure candidate, two pinned reviews with no blocking findings, authorized push verified | Active: final candidate CI; both final reviews zero blockers |

Execution: complete one item before starting another. Group fixes for the same invariant. Use focused tests and reuse unaffected evidence. Broad reviews and CI run at coherent milestone candidates; retain required comprehensive gate closure reviews. Do not create reviews for every small commit.

Nonblocking review suggestions (nine cumulative Fowler heuristics) are a separate backlog, not gate blockers. Any newly discovered blocker must cite a locked requirement and join an existing item or document why a new item is required. At 30 minutes without measurable progress, reassess the hypothesis and approach autonomously. No user input is needed for routine decisions.
