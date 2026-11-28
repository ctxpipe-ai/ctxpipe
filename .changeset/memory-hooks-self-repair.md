---
"ctxpipe": minor
---

fix: A repository that you set up with CLI 0.2.0 now repairs its memory setup at the next agent session. You do not have to do a step.

CLI 0.3.0 removed the commands `memory mcp` and `memory hook`. The hooks and MCP entries of CLI 0.2.0 still call them. Thus these hooks failed at each session start and stop, and memory capture stopped.

These commands now remove each 0.2.0 entry where it is: in the repository and in your home directory. For a `ctxpipe-memory` server in `~/.claude.json`, they run `claude mcp remove <name> --scope user`. With no `claude` command, that entry stays, and the stderr line gives the command to run. In a repository that has `.ai/memory`, they also apply the `memory init` upgrade. They write the current capture hooks of the repository for each host that had a 0.2.0 entry in the repository. In another directory, they only remove the 0.2.0 entries. They always exit with code 0 and write nothing to stdout. They write one line to stderr that tells what they did. A second run changes nothing.

A 0.2.0 entry in your home directory is only removed. It does not become a capture hook. A user-scope capture hook writes `.ai/memory/events/` into each directory where a session starts, also into a directory with no memory. If a repository got its capture only from a home entry, run `npx ctxpipe memory init` in it.

In a repository with `.ai/memory`, the repair also writes these files, as `memory init` does:

- the memory rules and skills that the capture follow-ups name
- the `.ai/memory` seed files that are missing
- the `.gitignore` line for `.ai/memory/events`

Outside a repository with `.ai/memory`, the repair changes only the files that hold a 0.2.0 entry. It stops with no change when a path goes through a symlink, or when a JSON file that it changes does not parse.

The hooks continue to run `npx -y ctxpipe …` with no version. Thus each hook run uses the newest release. `memory init` replaces a capture hook that has a version pin (`ctxpipe@<version>`) with the unpinned command.

`memory init` and the repair now write each file through a temporary file and a rename. Thus a process that reads the file at the same time never sees a partial file.
