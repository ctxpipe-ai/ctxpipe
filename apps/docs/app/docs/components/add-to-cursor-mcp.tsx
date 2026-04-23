"use client"

/**
 * One-click MCP install for Cursor (same deep link pattern as cursor.directory / Railway docs).
 * @see https://cursor.com/en/install-mcp
 */
const CURSOR_INSTALL_MCP_BASE = "https://cursor.com/en/install-mcp"

/** Default hosted app origin for the MCP endpoint in the install link. */
const DEFAULT_MCP_ORIGIN = "https://app.ctxpipe.ai"

function buildInstallHref(mcpUrl: string): string {
  const configJson = JSON.stringify({
    type: "streamable-http",
    url: mcpUrl,
  })
  const config = btoa(configJson)
  const params = new URLSearchParams({ name: "ctxpipe", config })
  return `${CURSOR_INSTALL_MCP_BASE}?${params.toString()}`
}

export function AddToCursorMcp({
  orgSlugPlaceholder = "your-org",
  mcpOrigin = DEFAULT_MCP_ORIGIN,
}: {
  /** Shown in the helper text so users know what to substitute after install. */
  orgSlugPlaceholder?: string
  /** Use your self-hosted origin instead of the hosted app when documenting forks. */
  mcpOrigin?: string
}) {
  const mcpUrl = `${mcpOrigin.replace(/\/$/, "")}/mcp?orgSlug=${orgSlugPlaceholder}`
  const href = buildInstallHref(mcpUrl)

  return (
    <div className="not-prose my-6 space-y-3 rounded-lg border border-fd-border bg-fd-card p-4">
      <p className="text-sm text-fd-muted-foreground">
        One-click add in Cursor opens an install prompt with this server pre-filled. Replace{" "}
        <code className="rounded bg-fd-muted px-1 py-0.5 font-mono text-xs">
          {orgSlugPlaceholder}
        </code>{" "}
        in the URL with your organisation slug if needed (you can edit the entry in Cursor
        settings afterward).
      </p>
      <a
        href={href}
        className="inline-flex items-center gap-2 rounded-md bg-[#0a0a0a] px-3 py-2 text-sm font-medium text-white no-underline ring-1 ring-white/10 transition hover:bg-[#171717]"
      >
        <svg
          aria-hidden
          className="size-4 shrink-0"
          viewBox="0 0 24 24"
          fill="currentColor"
        >
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        Add to Cursor
      </a>
      <p className="text-xs text-fd-muted-foreground">
        If nothing happens, ensure Cursor is installed — the link is handled by the Cursor app
        on your machine. With several Cursor windows open, whichever instance registers the
        protocol handler typically receives the install flow; after confirming, reload MCP or
        restart Cursor if tools do not appear. This only updates your local{" "}
        <code className="rounded bg-fd-muted px-1 py-0.5 font-mono">.cursor/mcp.json</code> (or
        global Cursor MCP config); it does not change Git or replace{" "}
        <strong className="font-medium text-fd-foreground">Install MCP via PR</strong> in the
        product UI, which opens pull requests that add the same MCP entry to a repo for the
        whole team.
      </p>
    </div>
  )
}
