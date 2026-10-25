---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use Opus at medium effort for implementation sub-agents.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review (Opus, high effort) to review the work. That review is three axes — Standards, Spec, and Simplicity.

Commit your work to the current branch.
