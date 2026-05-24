# Basic Memory Sentiment

Sources searched: Reddit, MCP directory pages, Basic Memory docs, third-party MCP listings.

Representative sources:

- Reddit project thread: https://www.reddit.com/r/modelcontextprotocol/comments/1j9w0qy
- Reddit Python thread: https://www.reddit.com/r/Python/comments/1jctt1v
- MCP Directory: https://mcp.directory/servers/basic-memory
- Docs: https://docs.basicmemory.com/

## Overall Sentiment

Basic Memory has positive sentiment among users who want persistent AI-readable notes, but some friction appears around agents reliably writing the expected semantic structures. It is seen as transparent and practical rather than magical.

Confidence: medium.

## Positive Themes

- Users like the "bilingual" idea: human-readable Markdown plus agent-readable semantic observations and relations.
- Local-first storage and Obsidian/editor compatibility are major trust wins.
- MCP integration makes it easy to use across assistants.
- It is useful beyond coding: research, writing, personal knowledge, and project continuity.

## Negative Or Cautious Themes

- A Reddit commenter noted that when asking the agent to save local markdown, it sometimes did not save observations and relations correctly.
- It may require user discipline and prompt conventions.
- For coding-agent memory, it can be too general unless layered with active-context/task structures.
- AGPL licensing may be a concern for commercial embedding.

## Perceived Pros

- Inspectable, portable, and local.
- Good tool surface for reading/writing/searching notes.
- Graph traversal gives more structure than flat markdown.

## Perceived Cons

- Agent write quality is uneven.
- Knowledge-base organization is user responsibility.
- Not specifically branch-aware or coding-workflow-aware.

## Sentiment Summary

Basic Memory is one of the more credible local knowledge-memory systems because it avoids opaque storage and uses MCP well. For our design, the important lessons are file-first source of truth, secondary rebuildable index, and explicit semantic relation syntax.

