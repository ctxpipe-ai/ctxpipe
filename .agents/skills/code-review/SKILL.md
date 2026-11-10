---
name: code-review
description: Review a branch along the critics of `critics.json` — Standards, Spec, Simplicity, and Security when its triggers match. `factory check` runs the critics and stores their verdicts for the merge gate. This skill is the entry to it; it holds the rules of each critic. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

The critics review the diff between `HEAD` and a fixed point along separate axes:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?
- **Simplicity** — is the machinery essential for the job, or accidental leftover?
- **Security** — only when the diff touches a trust surface (the `triggers` of `critics.json`).

Each axis reviews alone, so that one axis cannot hide the findings of another. Do **not** run the review as spec-only.

The issue tracker should have been provided to you — run `/setup-matt-pocock-skills` if `.ai/agents/issue-tracker.md` is missing.

## Run the critics with `factory check`

The critics are in [`critics.json`](critics.json). Each one has its intent, its triggers, and the reasons for which it may be skipped. It also has its reviewers (model and effort) and its `inputs`: the files that hold its rules and its prompt. When a critic has two reviewers, they run in parallel and the critic reports the union of their findings. `factory check` runs them beside the selected checks ([factory-check skill](../factory-check/SKILL.md)). Do not start review sub-agents.

1. Commit the change. The critics review the committed diff of the branch against `origin/main`. The merge gate looks up their verdicts for that diff.
2. Run `factory check --repo . --input <ticket or brief file>`. It uses the agent host profile (see the [factory-check skill](../factory-check/SKILL.md)). It plans each critic (`run-full`, `run-delta`, `carried` or `not-applicable`, with a reason). It runs one headless reviewer for each planned reviewer, records each verdict, and prints each finding with its file and line.
3. Fix each blocker and should-fix finding, commit, and run `factory check` again. It reviews only the hunks that changed or that had a finding; it carries the other hunks.
4. Give the user the findings under one heading for each critic. Do not merge or rerank them (see _Why separate axes_).

Give the same `--input` files in each run of a branch. A changed ticket or brief makes the next round review every hunk again.

The reviewers read the rules of each critic below through the `inputs` of `critics.json`, at the merge base. To change a review rule, change it here, not in the factory.

The merge gate checks that each critic has a stored verdict for the PR diff (job `Merge gate critics`). When it says that a critic is missing, run `factory check` on the PR head, then use **Re-run all jobs**. The gate proves that an agent recorded a review of the hunks. It does not prove that the review was sound.

## Dispute a finding

You cannot close a finding alone. When you think that a blocker or should-fix finding is wrong, dispute it with evidence:

1. Write a file outside the checkout, for example `$TMPDIR/disputes.json`, such as `{"disputes": [{"finding": "f:0123abcd", "kind": "factual", "reason": "...", "evidence": {"kind": "code", "path": "src/a.ts", "line": 12}}]}`. `finding` is the id that `factory check` prints before the finding. `kind` is `factual`, `rule-unseen`, `stale`, `duplicate`, `out-of-scope` (add `"followUp": "CTX-123"`, the follow-up ticket), or `rule-or-scope`. Never commit the file: it holds your reasons, and the repo is public.
2. Give evidence: a `rule` (`AGENTS.md`, an ADR, a skill or `lessons-learned.md` as it is on `main` before the PR), a `test` that disproves the finding, or `code` that the critic missed. A rule that the PR adds or changes is not evidence. A dispute without valid evidence counts as no answer.
3. Run `factory check --repo . --input <ticket> --disputes <file> --implementer <your model>`. The same critic withdraws or upholds the finding. It withdraws only for new information that it names. A model of another family arbitrates an upheld should-fix, but never a Security finding.
4. In some cases, only a ctxpipe developer can decide. The cases are:
   - You dispute a blocker.
   - The Security critic upholds its finding. A Security finding closes without a person only when its critic withdraws it for new information.
   - You defer a Security finding as `out-of-scope`. For a Security finding, scope is never a reason for the critic to withdraw.
   - Your dispute is about a rule or about the ticket scope.
   - The arbiter upholds the finding.
   - Another PR disputed the same finding with the same rule. A rule can be missing.
5. For each of these cases, `factory check` fails and prints `ESCALATED` with the finding, your dispute and its evidence, and the answers of the critic and the arbiter. The finding then holds its hunks: each later `factory check` fails and prints `HELD <id>`, also when the critic does not raise the finding again. A finding that names no changed hunk holds only the hunks of its file, also when that file comes into the diff later.
6. Ask the human in your conversation. Show them that text. Do not ask in a ticket or a PR comment. Record only a decision that the human states there.
7. A Security finding: the risk register is its only way. When the human accepts the risk, run `factory risk propose --finding <id> --reasons "<their words>" --decider <their role>`. Give the id of the `ESCALATED` line. It opens a PR in the private factory repo and prints the PR link as its last line. Show the human that link, so that they can open it. A ctxpipe developer approves and merges it. After that PR merges, run `factory check` again: the entry ends the hold. When the human decides that the finding stands, fix it.
8. Any other finding (`factory risk propose` refuses it):
   - The finding stands: run `factory decide <id> --stands`, fix it, commit, and run `factory check`. The hold ends when the same critic reviews the held hunks and does not raise the finding again.
   - The finding does not stand: run `factory decide <id> --dismissed --reason "<their words>"`. The hold ends. The reason has 40 to 300 characters in plain words, with no id, key or customer name: the PR comment shows it with the writer.
9. Run `factory decide` on the host where the finding escalated: only a ruling of the writer of the hold ends it.
10. Never write, approve or merge a register entry yourself, also when you act for a person. Do not quote the reasons of an entry in a dispute.

## The rules of each critic

The reviewers of `factory check` read this section through the `inputs` of `critics.json`. The fallback below uses it too.

**Rules that a check decides.** The repo CI already enforces these exact cases (CTX-1120). Do not report them:

- A new ADR file that `.ai/memory/decisions/index.md` does not list: `scripts/ci/check-adr.mjs` (`policy:adr`). Whether a change needs an ADR stays a review judgement.
- A single-use scalar constant (a string or number) at module scope: `scripts/ci/check-module-scope-values.mjs` (`policy:module-scope-values`). Arrays, objects, and calls at module scope stay a review judgement.

**Standards critic.** The standards sources are the files in the repo that document how to write code: each `AGENTS.md`, `.ai/memory/lessons-learned.md`, and files such as `CONTRIBUTING.md`. Report, for each file or hunk, (a) each place where the diff breaks a documented standard, with the file and the rule; and (b) each baseline smell below, with its name and the hunk. A documented standard can be a hard violation. A baseline smell is always a judgement call. Skip what tooling enforces, including the two cases above.

The smell baseline is a fixed set of Fowler code smells (_Refactoring_, ch.3). It applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

A single switch that replaced a one-adapter seam is not Repeated Switches. A type that matches `.ai/memory/glossary.md` is not Primitive Obsession. Speculative Generality is a local hint; leftover analogue / “should this table exist?” belongs on **Simplicity**.

**Spec critic.** Report (a) the requirements of the spec that are missing or partial; (b) the behavior in the diff that the spec did not ask for (scope creep); and (c) the requirements that look implemented, but where the implementation looks wrong. Quote the spec line for each finding.

**Security critic.** Review only the trust surfaces that the `intent` of `critics.json` names. Report each place where the diff does one of these:

- It gives a job, a token, or a role more permission than its job needs. Or it gives a credential to a job that runs PR code, or to a third-party action that is not pinned by commit.
- It breaks the GitHub environment rules of `AGENTS.md`: `Production` and `Preview` share a credential, or a check that calls an outside service does not use `workbench`.
- It lets one organization read or change the data of another organization, or it skips an auth check.
- It trusts data that a less trusted writer can make (PR code, a fork, an artifact found by name, a model answer) for a decision that needs trust.
- It sends a secret, a customer identifier, or private data to a public artifact, a log, a PR comment, or an outside provider (_Customer privacy_ in `AGENTS.md`).
- It runs new code at install, at check listing, or at check discovery.

For each finding, give the writer who can do it, the effect, and the fix. A guardrail bypass inside a sandbox is not a finding: the sandbox is the security boundary. A change that keeps the same trust is not a finding.

**Simplicity critic.** Apply each rule of [`.agents/skills/simplicity-audit/REVIEW-BRIEF.md`](../simplicity-audit/REVIEW-BRIEF.md) to the diff, and report in the shape of that brief. Spec-match is not a defense.

**Visual critic.** It judges each changed baseline screenshot (`**/screenshots/*.screenshot.png`) with `pnpm visual:review`. The rules, the rubric and the prompt are in `packages/visual-review`, not here, so that the command, the factory and a fork use the same rules. Do not judge a screenshot outside the command. With `--judge agent`, you judge the images of a request, and the command checks and reports your verdict. The command prints one verdict for each changed screenshot or group: `intended`, `regression`, `noise` or `unsure`, with a severity. A screenshot id is `<story id>[@<snapshot>].<viewport>`. Screenshots with the same diff form a group. A judge looks at one screenshot of the group and at two samples. The verdict line of the group names each screenshot of the group. With `--json`, each screenshot of the group has its verdict, with `groupedWith`. A `regression` with severity `major` or `blocker` blocks: the command exits with code 1. Exit code 2 means that the review is not complete. To accept a change, commit the new baseline. A verdict does not accept a change.

The `visual` entry of `critics.json` is a command critic ([CTX-1198](https://linear.app/ctxpipe/issue/CTX-1198)). It runs only when the diff changes a file that matches `**/screenshots/*.screenshot.png`. `factory check` runs its `command` in an export of the merge base, never in the checkout: `pnpm -s visual:review --images <review folder>/binary -- <paths>`. The command reads `base/<path>` and `head/<path>` for each path, compares them with its own compare engine, and prints one verdict for each path, with `path`. It reads no manifest from the branch. A new screenshot (no base image) is judged on its own against the rubric, in one model call for the new screenshots of one story at all its viewports ([CTX-1224](https://linear.app/ctxpipe/issue/CTX-1224)). A removed screenshot is `unsure`, and an image pair in the tolerance of the visual check is `noise`; neither calls a model. The factory makes `regression` with `major` or `blocker` a blocker, `regression` with `minor` or `none` and `unsure` a nit, and `intended` and `noise` no finding.

A PR that changes a screenshot needs `MODEL_PROVIDER_API_KEY` on the host that runs `factory check`. On a Mac, store the key once in the login keychain item `factory-model-provider`: `security add-generic-password -s factory-model-provider -a "$USER" -w`. Without a key, the visual critic is an `ERROR` and records nothing. A missing key never gives a pass.

The factory stores each visual verdict by the repo, the critic version, the path, the hashes of the two images and the hash of the brief ([CTX-1199](https://linear.app/ctxpipe/issue/CTX-1199)). The critic version includes the `inputs` of the `visual` entry: the code of `packages/visual-review` (its rubric, prompt, model choice and compare engine) and `pnpm-lock.yaml`. A second run on the same images reuses the verdict and calls no model, also when the verdict is a `regression`. A new run does not give a new judgment. To change the verdict, change the image or override the verdict. When two writers stored different verdicts for the same images, the more severe verdict counts.

- **Spend limit.** The visual critic may spend $5 for each PR, across all runs. When the next run would pass the limit, `factory check` gives an `ERROR` and does not run the command. Ask the human. Only on the human's word, run `factory check --critic-limit-usd <dollars>`. Else make fewer screenshots change: fix a shared cause one time. The limit prevents an accidental spend. It does not stop a hostile writer, because a writer can give another branch or a higher limit. Thus each raised limit is recorded with its writer, and the merge gate and the PR comment show it. The command has its own hard stop too: with `--budget-usd <n>`, `visual:review` makes no more model calls when the spent cost reaches `n`, marks each screenshot that it did not judge `unsure` with the error "Budget reached", and exits with code 2 ([CTX-1227](https://linear.app/ctxpipe/issue/CTX-1227)). The `visual` entry passes `--budget-usd {budgetUsd}`: the factory gives the rest of the $5 limit of the PR ([CTX-1233](https://linear.app/ctxpipe/issue/CTX-1233)). Thus one run cannot pass the limit by more than one model call. A factory release without the placeholder passes the text `{budgetUsd}` as it is. `visual:review` refuses it, so the critic is an `ERROR`, never a pass.
- **Override.** When you are sure that a visual blocker is wrong, override it in the disputes file: `{"finding": "f:0123abcd", "kind": "override", "reason": "...", "evidence": {"kind": "code", "path": "<the screenshot path>"}}`. The reason says why the verdict is wrong, in 40 to 300 characters of plain words, with no id, hash or key. The merge gate and the PR comment show the reason, the writer and the commit, so write no customer name in it. Only a visual finding takes an override.

## Without the factory

Use this procedure only when `factory` is not installed (for example, for a contributor from a fork). You are the one agent. Do not start sub-agents.

1. Get the fixed point from the user. If the user gave none, ask for it. Make sure that `git rev-parse <fixed-point>` resolves and that `git diff <fixed-point>...HEAD` is not empty. Read the diff and `git log <fixed-point>..HEAD`.
2. Find the spec: an issue in the commit messages (use `.ai/agents/issue-tracker.md`), a path from the user, or a Linear issue or document for the branch. If you find none, ask the user. If there is none, skip Spec.
3. Review the diff on one axis at a time, in this order: Standards, Spec, Simplicity. Use the rules of that critic above. Write the findings of an axis before you start the next axis.
4. When the diff touches a trust surface (the `triggers` of `critics.json`), review Security with the rules of the Security critic above.
5. When the diff changes a baseline screenshot (`**/screenshots/*.screenshot.png`), review Visual with `pnpm visual:review`. It reads the manifest of the last visual run, `.ci-results/visual/manifest.json` (or the path of `--manifest`). The visual capture of Storybook will write it; no command in this repo writes it yet (the capture tickets of the visual review plan). If the manifest is not there, say that Visual was skipped, and why.
   - When the PR is not your own work, skip Visual and say why. PR code can change `visual:review` and its manifest, and it can read your key. No trusted command makes the manifest of a PR yet.
   - With a model key: run `pnpm visual:review --brief <ticket or brief file>`. It uses your `MODEL_PROVIDER_API_KEY` and `MODEL_PROVIDER_URL` (OpenRouter by default). `--filter jev` asks the cheap Jev filter first.
   - Without a key: run `pnpm visual:review --judge agent --brief <ticket or brief file>`. For each screenshot that needs a judgment, it writes `<session>/<screenshot id>/request.md` and the images. The session is a new private folder in the temporary folder of the system, and the command prints it. It never keeps a verdict in the run folder or the checkout, because PR code can write those. Read each `request.md` and its images, and write `verdict.json` in the same folder, as the request tells you. Then run the command that the request gives: the same options with `--session <session>`. It reads each `verdict.json` of that session and checks it against the verdict schema.
   - Exit code 2: the review is not complete (a verdict is missing or does not match the schema). Fix the cause and run again. Exit code 1: a verdict blocks.
6. Give the findings under `## Standards`, `## Spec`, `## Simplicity` and, when they ran, `## Security` and `## Visual`. Do not merge or rerank them. If you skipped Spec, Security or Visual, say so. End with one line: the count of findings and the worst finding of each axis.

## Why separate axes

A change can pass one axis and fail another:

- House style and the wrong behaviour → **Standards pass, Spec fail.**
- Exactly what the issue asked, against house conventions → **Spec pass, Standards fail.**
- Matches the spec and looks clean, but the spec kept leftover analogue machinery → **Spec pass, Simplicity fail.**

Reporting them separately stops Spec-match from hiding accidental complexity.
