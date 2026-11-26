---
"ctxpipe": minor
---

`ctxpipe memory init` now pins the CLI version in each hook and instruction that it writes (`npx -y ctxpipe@<version> memory capture …`). A new release does not run in your repository until you run `memory init` again. Before, each hook run took the newest release.

The commands `memory mcp` and `memory hook` were removed in 0.3.0. Hooks from CLI 0.2.0 still call them, and these hooks failed at each session start and stop. These commands now write one line to stderr that tells you to migrate, and exit with code 0. Most hosts show stderr only in a hook or verbose log. Stdout stays empty, because the host can parse it.

Action: in each repository that you set up with an older CLI, run `npx ctxpipe memory init` again. This updates the hooks to the pinned command and removes the 0.2.0 hooks.
