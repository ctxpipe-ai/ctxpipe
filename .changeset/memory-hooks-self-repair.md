---
"ctxpipe": minor
---

A repository that you set up with CLI 0.2.0 now repairs its memory setup at the next agent session. You do not have to do a step.

CLI 0.3.0 removed the commands `memory mcp` and `memory hook`. The hooks and MCP entries of CLI 0.2.0 still call them, so these hooks failed at each session start and stop, and memory capture stopped. These commands now apply the same upgrade as `memory init` in the repository in which they run: they remove the 0.2.0 entries and write the current capture hooks for each host that had a 0.2.0 entry. They always exit with code 0, write nothing to stdout, and write one line to stderr that tells what they did. A second run changes nothing. The repair changes only a repository that has `.ai/memory`.

The hooks continue to run `npx -y ctxpipe …` with no version, so each hook run uses the newest release. `memory init` replaces a capture hook that has a version pin (`ctxpipe@<version>`) with the unpinned command.

`memory init` and the repair now write each file through a temporary file and a rename, so a process that reads the file at the same time never sees a partial file.
