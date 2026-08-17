---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use `cursor-grok-4.6-high-fast` for implementation Task sub-agents.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Once done, use /code-review (`gpt-5.6-sol-high`) to review the work.

Commit your work to the current branch.
