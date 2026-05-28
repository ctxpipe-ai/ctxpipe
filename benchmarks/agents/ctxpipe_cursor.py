from __future__ import annotations

import json
import os
import shlex
from typing import Any

from harbor.agents.installed.cursor_cli import CursorCli


class CtxpipeCursorCliAgent(CursorCli):
    """Cursor CLI agent that injects Bearer auth headers for ctxpipe MCP."""

    def _build_register_mcp_servers_command(self) -> str | None:
        mcp_url = os.environ.get("CTXPIPE_MCP_URL")
        mcp_token = os.environ.get("CTXPIPE_API_TOKEN")
        if not mcp_url or not mcp_token:
            raise ValueError(
                "CTXPIPE_MCP_URL and CTXPIPE_API_TOKEN are required for ctxpipe runs."
            )

        servers: dict[str, dict[str, Any]] = {
            "ctxpipe": {
                "url": mcp_url,
                "headers": {"Authorization": f"Bearer {mcp_token}"},
            }
        }

        # Preserve any stdio MCP entries explicitly passed to the trial.
        for server in self.mcp_servers:
            if server.transport != "stdio":
                continue
            servers[server.name] = {"command": server.command, "args": server.args}

        config = json.dumps({"mcpServers": servers}, indent=2)
        escaped = shlex.quote(config)
        return f"mkdir -p ~/.cursor && echo {escaped} > ~/.cursor/mcp.json"
