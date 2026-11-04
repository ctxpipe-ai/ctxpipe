---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use Opus at medium effort for implementation sub-agents.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly and single test files regularly.

Once done, commit your work to the current branch. Then run `factory check --input <the spec or ticket file>`: it runs the checks that the change can break and the review critics (Standards, Spec, Simplicity, and Security when it applies). Fix what it reports, commit, and run it again until it passes. Do not start review sub-agents.
