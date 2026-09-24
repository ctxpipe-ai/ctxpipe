---
"ctxpipe": patch
"@ctxpipe/aws-cdk": patch
---

Get local memory into git and the graph: the Stop hook, `memory status` and `memory doctor` now report durable `.ai/memory` files left uncommitted, and the installed rule and skills tell agents to commit memory with the work it came from and to summarise that work in the pull request description. Ingestion now reads `.ai/memory/lessons-learned.md` as an instruction source (below `AGENTS.md`), and extracts instruction files over 48,000 characters in heading-bounded chunks instead of truncating them. `memory init` no longer replaces a team's `.ai/memory/README.md` because it mentions the current `memory-search` skill, and capture no longer proposes a glossary entry whenever a message mentions the glossary.
