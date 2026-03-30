import type { ReactNode } from "react"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { source } from "@/lib/source"
import { DocsCustomNav } from "./components/docs-custom-nav"
import { DocsSidebarModeLinks } from "./components/docs-sidebar-mode-links"

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
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
        /*
         * SidebarHeader is still rendered (title link + hidden search slot) but
         * adds nothing visible when nav.title is unset.  Remove its padding here
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
