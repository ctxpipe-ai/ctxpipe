"use client"

import type { CSSProperties } from "react"
import Link from "fumadocs-core/link"
import { usePathname } from "fumadocs-core/framework"
import { FileText } from "fumadocs-ui/internal/icons"
import { cn } from "fumadocs-ui/utils/cn"

function normalisePathname(pathname: string) {
  return pathname.endsWith("/") && pathname !== "/"
    ? pathname.slice(0, -1)
    : pathname || "/"
}

function isSelfHostingPath(pathname: string) {
  const p = normalisePathname(pathname)
  return p === "/docs/self-hosting" || p.startsWith("/docs/self-hosting/")
}

function isDocsPath(pathname: string) {
  const p = normalisePathname(pathname)
  return p === "/" || p === "/docs" || p.startsWith("/docs/")
}

const row = cn(
  "relative flex flex-row items-center gap-2 rounded-none p-2 ps-(--sidebar-item-offset) text-start",
  "[overflow-wrap:anywhere] [&_svg]:size-4 [&_svg]:shrink-0",
)

function ServerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
      <rect x="3" y="4" width="18" height="6" rx="1.25" />
      <rect x="3" y="14" width="18" height="6" rx="1.25" />
      <circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7" cy="17" r="0.9" fill="currentColor" stroke="none" />
      <path d="M11 7h7M11 17h7" strokeLinecap="round" />
    </svg>
  )
}

export function DocsSidebarModeLinks() {
  const pathname = usePathname()
  const selfHosting = isSelfHostingPath(pathname)
  const docsActive = !selfHosting && isDocsPath(pathname)

  return (
    <div
      className={cn(
        "docs-mode-links mb-3 min-h-28 border-b border-fd-border",
        /* Centre the two rows in the band between the chrome above and the tree below */
        "grid grid-rows-[1fr_auto_1fr]",
      )}
      style={
        {
          "--sidebar-item-offset": "calc(var(--spacing) * 2)",
        } as CSSProperties
      }
    >
      <div className="min-h-0" aria-hidden />
      <div className="flex flex-col gap-2 py-1">
        <Link
          href="/"
          data-active={docsActive}
          className={cn(
            row,
            docsActive
              ? "font-medium text-fd-primary"
              : "text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80",
          )}
        >
          <FileText />
          <span>Docs</span>
        </Link>
        <Link
          href="/docs/self-hosting"
          data-active={selfHosting}
          className={cn(
            row,
            selfHosting
              ? "font-medium text-fd-primary"
              : "text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80",
          )}
        >
          <ServerIcon />
          <span>Self hosting</span>
        </Link>
      </div>
      <div className="min-h-0" aria-hidden />
    </div>
  )
}
