---
"ctxpipe": minor
---

A repository that you set up with CLI 0.2.0 now repairs its memory setup at the next agent session. You do not have to do a step.

CLI 0.3.0 removed the commands `memory mcp` and `memory hook`. The hooks and MCP entries of CLI 0.2.0 still call them. Thus these hooks failed at each session start and stop, and memory capture stopped.

These commands now apply the `memory init` upgrade in the repository in which they run. They write the current capture hooks for each host that had a 0.2.0 entry. Then they remove the 0.2.0 entries of the repository. They always exit with code 0 and write nothing to stdout. They write one line to stderr that tells what they did. A second run changes nothing.

Like `memory init`, the repair also writes these files:

- the memory rules and skills that the capture follow-ups name
- the `.ai/memory` seed files that are missing
- the `.gitignore` line for `.ai/memory/events`

The repair changes only a repository that has `.ai/memory`. It changes no file in your home directory. It stops with no change when a path goes through a symlink, or when a JSON file that it changes does not parse.

0.2.0 entries in your home directory stay, so that your other repositories repair themselves too. A home entry of a host also adds the capture hooks of that host to a repository that has `.ai/memory`. Run `npx ctxpipe memory init` one time to remove these entries.

The hooks continue to run `npx -y ctxpipe …` with no version. Thus each hook run uses the newest release. `memory init` replaces a capture hook that has a version pin (`ctxpipe@<version>`) with the unpinned command.

`memory init` and the repair now write each file through a temporary file and a rename. Thus a process that reads the file at the same time never sees a partial file.
