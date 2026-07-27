# Official MCP Knowledge Graph Memory Server Sentiment

Sources searched: npm package, GitHub issues, Reddit MCP/ClaudeAI threads.

Representative sources:

- npm package: https://www.npmjs.com/package/@modelcontextprotocol/server-memory
- GitHub storage path issue: https://github.com/modelcontextprotocol/servers/issues/692
- Reddit custom path thread: https://www.reddit.com/r/ClaudeAI/comments/1h7bygl
- Reddit OpenWebUI update issue: https://www.reddit.com/r/OpenWebUI/comments/1mbblvm/memory_mcp_server_is_not_updating_the_memory_file/
- Reddit containerized memory server discussion: https://www.reddit.com/r/mcp/comments/1tfkbnj/i_built_a_containerised_persistent_memory_server/

## Overall Sentiment

Sentiment is mixed but generally respectful: users see it as a useful reference, not a complete production-grade memory system. The biggest complaints are around storage path behavior, stdio-only deployment limits, and primitive retrieval.

Confidence: medium.

## Positive Themes

- It established a common simple pattern: entities, relations, observations.
- It is easy to explain and modify.
- Community projects often build on it or explicitly say they are extending its ideas.
- A shared knowledge graph feels more structured than dumping raw notes into context.

## Negative Or Cautious Themes

- Users struggled to control where the memory file is stored.
- Some users reported memory not updating as expected in specific clients.
- Stdio-only operation is limiting for networked or multi-agent setups.
- Search/retrieval is simple and can feel random or insufficient for complex memory.

## Perceived Pros

- Low-friction reference implementation.
- Good schema seed for small personal memory.
- Useful for understanding MCP tool design.

## Perceived Cons

- Not enough for long-horizon coding projects.
- Operational rough edges around file location.
- No strong lifecycle, audit, or secret controls.

## Sentiment Summary

The official MCP Memory Server is best treated as the "hello world" of MCP memory. It is valuable as a conceptual baseline, but our future design would need stronger storage transparency, path control, retrieval quality, and coding-specific state.

