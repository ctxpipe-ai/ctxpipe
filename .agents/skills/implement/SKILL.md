---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use Opus at medium effort for implementation sub-agents.

Use /tdd where possible, at pre-agreed seams.

Run typechecking regularly. During a red-green loop, run the one test file that you work on. Before each push, run `factory check`. Do not start review or test sub-agents.

Once done, commit your work to the current branch. Then run `factory check --input <the spec or ticket file>`. It runs the checks that the change can break. It also runs the review critics: Standards, Spec, Simplicity, and Security when it applies. Fix what it reports and commit. Run it again until it passes. Do not start review sub-agents.
