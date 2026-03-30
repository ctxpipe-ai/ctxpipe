"use client"

import type { CSSProperties } from "react"
import Link from "fumadocs-core/link"
import { usePathname } from "fumadocs-core/framework"
import { FileText, FolderOpen } from "fumadocs-ui/internal/icons"
import { cn } from "fumadocs-ui/utils/cn"

function isSelfHostingPath(pathname: string) {
  const p = pathname.replace(/\/$/, "") || "/"
  return p === "/docs/self-hosting" || p.startsWith("/docs/self-hosting/")
}

const row = cn(
  "relative flex flex-row items-center gap-2 rounded-none p-2 ps-(--sidebar-item-offset) text-start",
  "[overflow-wrap:anywhere] [&_svg]:size-4 [&_svg]:shrink-0",
)

export function DocsSidebarModeLinks() {
  const pathname = usePathname()
  const selfHosting = isSelfHostingPath(pathname)
  const docsActive = !selfHosting && pathname.startsWith("/docs")

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
          href="/docs"
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
          <FolderOpen />
          <span>Self hosting</span>
        </Link>
      </div>
      <div className="min-h-0" aria-hidden />
    </div>
  )
}
