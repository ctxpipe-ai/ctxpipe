from __future__ import annotations

import json
import os
import shlex
from typing import Any
from urllib import error, request

from harbor.agents.installed.cursor_cli import CursorCli


class CtxpipeCursorCliAgent(CursorCli):
    """Cursor CLI agent that injects Bearer auth headers for ctxpipe MCP."""

    def _assert_ctxpipe_mcp_reachable(self, mcp_url: str, mcp_token: str) -> None:
        """Fail fast when hosted MCP is unreachable or rejects the token."""
        payload = {
            "jsonrpc": "2.0",
            "id": "ctxpipe-arm-preflight",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "harbor-ctxpipe-preflight", "version": "1.0.0"},
            },
        }
        req = request.Request(
            mcp_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {mcp_token}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=10):
                return
        except error.HTTPError as exc:
            raise RuntimeError(
                f"ctxpipe MCP preflight failed with HTTP {exc.code}; refusing to start trial."
            ) from exc
        except error.URLError as exc:
            raise RuntimeError(
                "ctxpipe MCP preflight request failed; refusing to start trial."
            ) from exc

    def _build_register_mcp_servers_command(self) -> str | None:
        mcp_url = os.environ.get("CTXPIPE_MCP_URL")
        mcp_token = os.environ.get("CTXPIPE_API_TOKEN")
        if not mcp_url or not mcp_token:
            raise ValueError(
                "CTXPIPE_MCP_URL and CTXPIPE_API_TOKEN are required for ctxpipe runs."
            )
        self._assert_ctxpipe_mcp_reachable(mcp_url, mcp_token)

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
