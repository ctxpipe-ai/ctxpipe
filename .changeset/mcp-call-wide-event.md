---
---

Each MCP tool call and each tool bridge call sends its own wide event. The event holds the result size, the error code and the org of the call, and the request id of its request. `/mcp` keeps its SSE responses. evlog writes no "log.set() called after the wide event" warning.
