# MCP client configuration

The backend exposes the MCP interface at `/mcp` (Streamable HTTP transport).

## Connecting a client

- **Base URL**: `https://your-backend-host/mcp` (or `https://localhost:3000/mcp` in development)
- **Transport**: Streamable HTTP (MCP spec)

Configure your MCP client (e.g. Cursor, Claude Desktop) with this URL. Authentication (e.g. bearer token) can be added later via Better Auth and middleware.
