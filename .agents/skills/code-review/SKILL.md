---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along three axes — Standards, Spec, and Simplicity. Runs the three reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?
- **Simplicity** — is the machinery essential for the job, or accidental leftover?

All three axes run as **parallel sub-agents** (Opus, high effort) so they don't pollute each other's context, then this skill aggregates their findings. Do **not** run the review as spec-only.

The issue tracker should have been provided to you — run `/setup-matt-pocock-skills` if `.ai/agents/issue-tracker.md` is missing.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside parallel sub-agents.

### 1b. Build the context pack (when the factory is installed)

If `factory` is on `PATH`, and the review request does not say `Context pack: off`, run `factory review pack <fixed-point>..HEAD`. Add `--ticket <file>` and `--brief <file>` when you have the spec text in a file. In a follow-up round, add `--findings <file>` for each earlier report. The command prints the path of the pack.

The pack is one Markdown file (first line `<!-- factory-review-pack/1 -->`). It holds the rules that apply to the changed paths, the task, the diff with whole functions, the direct callers and callees, and the earlier findings. Give the path only to the **Standards** sub-agent. In a replay of past rounds (CTX-1119), the pack cut the Standards tokens by about half with the same real findings. For Spec it saved nothing, and for Simplicity it added about a quarter, because those axes still search the repo and carry the pack in each turn. Spec and Simplicity read the repo as before.

If `factory` is not on `PATH`, or the request says `Context pack: off`, skip this step. Each sub-agent then reads the repo as before. The live audit of the review critics uses `Context pack: off` for its control sample.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the workflow in `.ai/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/`, or a Linear issue or document, matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

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

### 4. Spawn three sub-agents in parallel

Spawn all three on Opus at high effort (use the harness's own name for the model and effort setting). Always spawn **Simplicity**. Skip Spec only when step 2 found no spec.

When step 1b made a pack, start the Standards prompt with this text: "Context pack: `<path>`. Read the pack first. Read a file from the repo only when the pack does not have what you need, for example a file that the pack lists under Not in the pack. In the report, name each file that you read from the repo." In that prompt, replace the diff command with "The diff is in the pack, section 4. Run git for a file or a whole function that the pack cut or narrowed (the pack gives the command)." In the list of standards sources, replace the root `AGENTS.md`, the app `AGENTS.md` files and `.ai/memory/lessons-learned.md` with "the Rules section of the pack, the root `AGENTS.md` that your harness loads, and the sources that the pack names under Not in the pack, when they apply". Keep the path of each other source from step 3 (for example `CONTRIBUTING.md` or `apps/ui/DESIGN.md`): the pack does not collect them. Each byte in the prompt costs once for each turn of the sub-agent, so do not also paste the diff or the rules.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

**Simplicity sub-agent prompt** — include:

- The full diff command and commit list.
- The spec path or a note that none was found.
- The **entire** contents of [`.agents/skills/simplicity-audit/REVIEW-BRIEF.md`](../simplicity-audit/REVIEW-BRIEF.md), pasted in full — the sub-agent has no other access to it.
- The brief: "You are the Simplicity axis. Apply every rule in the pasted brief to this diff. Report in the brief's shape. Spec-match is not a defense."

### 5. Aggregate

Present the reports under `## Standards`, `## Spec`, and `## Simplicity`, verbatim or lightly cleaned. Do **not** merge or rerank findings — the axes are deliberately separate (see _Why three axes_). If Spec was skipped, say so under `## Spec`.

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

## Why three axes

A change can pass one axis and fail another:

- House style and the wrong behaviour → **Standards pass, Spec fail.**
- Exactly what the issue asked, against house conventions → **Spec pass, Standards fail.**
- Matches the spec and looks clean, but the spec kept leftover analogue machinery → **Spec pass, Simplicity fail.**

Reporting them separately stops Spec-match from hiding accidental complexity.
