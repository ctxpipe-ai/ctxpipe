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

The critics are in [`critics.json`](critics.json). Each one has its intent, its triggers, and the reasons for which it may be skipped. It also has its reviewers (model and effort) and its `inputs`: the files that hold its rules and its prompt. `factory check` runs them beside the selected checks ([factory-check skill](../factory-check/SKILL.md)). Do not start review sub-agents.

1. Commit the change. The critics review the committed diff of the branch against `origin/main`. The merge gate looks up their verdicts for that diff.
2. Run `factory check --repo . --input <ticket or brief file>`. It uses the agent host profile (see the [factory-check skill](../factory-check/SKILL.md)). It plans each critic (`run-full`, `run-delta`, `carried` or `not-applicable`, with a reason). It runs one headless reviewer for each planned reviewer, records each verdict, and prints each finding with its file and line.
3. Fix each blocker and should-fix finding, commit, and run `factory check` again. It reviews only the hunks that changed or that had a finding; it carries the other hunks.
4. Give the user the findings under one heading for each critic. Do not merge or rerank them (see _Why separate axes_).

Give the same `--input` files in each run of a branch. A changed ticket or brief makes the next round review every hunk again.

The reviewers read the rules of each critic below through the `inputs` of `critics.json`, at the merge base. To change a review rule, change it here, not in the factory.

The merge gate checks that each critic has a stored verdict for the PR diff (job `Merge gate critics`). When it says that a critic is missing, run `factory check` on the PR head, then use **Re-run all jobs**. The gate proves that an agent recorded a review of the hunks. It does not prove that the review was sound.

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

## Without the factory

Use this procedure only when `factory` is not installed (for example, for a contributor from a fork). You are the one agent. Do not start sub-agents.

1. Get the fixed point from the user. If the user gave none, ask for it. Make sure that `git rev-parse <fixed-point>` resolves and that `git diff <fixed-point>...HEAD` is not empty. Read the diff and `git log <fixed-point>..HEAD`.
2. Find the spec: an issue in the commit messages (use `.ai/agents/issue-tracker.md`), a path from the user, or a Linear issue or document for the branch. If you find none, ask the user. If there is none, skip Spec.
3. Review the diff on one axis at a time, in this order: Standards, Spec, Simplicity. Use the rules of that critic above. Write the findings of an axis before you start the next axis.
4. When the diff touches a trust surface (the `triggers` of `critics.json`), review Security with the rules of the Security critic above.
5. Give the findings under `## Standards`, `## Spec`, `## Simplicity` and, when step 4 ran, `## Security`. Do not merge or rerank them. If you skipped Spec or Security, say so. End with one line: the count of findings and the worst finding of each axis.

## Why separate axes

A change can pass one axis and fail another:

- House style and the wrong behaviour → **Standards pass, Spec fail.**
- Exactly what the issue asked, against house conventions → **Spec pass, Standards fail.**
- Matches the spec and looks clean, but the spec kept leftover analogue machinery → **Spec pass, Simplicity fail.**

Reporting them separately stops Spec-match from hiding accidental complexity.
