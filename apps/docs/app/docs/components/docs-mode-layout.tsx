"use client"

import type { ReactNode } from "react"
import type * as PageTree from "fumadocs-core/page-tree"
import { usePathname } from "fumadocs-core/framework"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { DocsCustomNav } from "./docs-custom-nav"
import { DocsSidebarModeLinks } from "./docs-sidebar-mode-links"

type DocsModeLayoutProps = {
  children: ReactNode
  docsTree: PageTree.Root
  selfHostingTree: PageTree.Root
}

function normalisePathname(pathname: string) {
  return pathname.endsWith("/") && pathname !== "/"
    ? pathname.slice(0, -1)
    : pathname || "/"
}

function isSelfHostingPath(pathname: string) {
  const p = normalisePathname(pathname)
  return p === "/docs/self-hosting" || p.startsWith("/docs/self-hosting/")
}

export function DocsModeLayout({
  children,
  docsTree,
  selfHostingTree,
}: DocsModeLayoutProps) {
  const pathname = usePathname()
  const tree = isSelfHostingPath(pathname) ? selfHostingTree : docsTree

  return (
    <DocsLayout
      tree={tree}
      tabMode="auto"
      nav={{
        enabled: true,
        component: <DocsCustomNav />,
      }}
      searchToggle={{
        components: {
          /* Full-width search lives in DocsCustomNav; keep sidebar header uncluttered */
          lg: <span className="hidden" aria-hidden />,
        },
      }}
      sidebar={{
        tabs: false,
        /* collapse lives in the top nav (SidebarCollapseTrigger); skip rendering
           the in-sidebar duplicate trigger and the CollapsibleControl float */
        collapsible: false,
        /* keep folders expanded by default so all pages are visible initially */
        defaultOpenLevel: 99,
        /*
         * SidebarHeader is still rendered (title link + hidden search slot) but
         * adds nothing visible when nav.title is unset. Remove its padding here
         * instead of a global #nd-sidebar > div:first-child selector.
         */
        className:
          "[&>div:first-child]:!min-h-0 [&>div:first-child]:!gap-0 [&>div:first-child]:!p-0",
      }}
      links={[
        {
          type: "custom",
          children: <DocsSidebarModeLinks />,
        },
      ]}
      themeSwitch={{ enabled: false }}
    >
      {children}
    </DocsLayout>
  )
}
