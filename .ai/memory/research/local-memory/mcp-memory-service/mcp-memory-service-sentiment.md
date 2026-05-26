# MCP Memory Service Sentiment

Sources searched: GitHub search results, Reddit MCP/Claude setup threads, broad web search.

Representative sources:

- Repo surfaced by search: https://github.com/doobidoo/mcp-memory-service
- Search mirror/fork: https://github.com/alphaplapplap/mcp-memory-service
- Claude Code guide references in public search results

## Overall Sentiment

Sentiment is hard to isolate because the project appears in many MCP memory discussions and forks, but not always under one canonical brand. The general reaction to SQLite-backed semantic memory MCP servers is positive among power users, with persistent concerns about setup complexity and reliability.

Confidence: low-medium.

## Positive Themes

- Users want universal memory across Claude, Cursor, VS Code, Continue, and related tools.
- SQLite/local vector search is seen as practical for personal machines.
- Automatic/natural triggers are attractive because models often forget to call memory tools.
- Team collaboration and auth are differentiators versus single-user toy servers.

## Negative Or Cautious Themes

- The ecosystem around MCP memory servers is noisy; users complain about many overlapping projects.
- More features mean more configuration and security review.
- Triggers/hooks can be hard to debug when they inject or omit context unexpectedly.
- Some users prefer simpler markdown/git-backed memory to another daemon/service.

## Perceived Pros

- Broad client compatibility.
- Local semantic search.
- More production-minded features than reference servers.

## Perceived Cons

- Canonical project identity and maintenance status require verification.
- May be overbuilt for repo-local coding memory.
- Team/cloud features complicate the local-first story.

## Sentiment Summary

MCP Memory Service is worth mining for patterns around local SQLite semantic search and trigger-based recall. It is less clean as a direct adoption candidate until the canonical repo, license, and current architecture are verified.

