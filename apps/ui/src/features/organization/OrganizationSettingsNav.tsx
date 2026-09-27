import { Link } from "@tanstack/react-router"
import { organizationViewClassNames } from "@/features/organization/organizationViewTheme"
import { cn } from "@/lib/utils"

const NAV_ITEMS = [
  { view: "settings", label: "Settings" },
  { view: "members", label: "Members" },
  { view: "api-keys", label: "API Keys" },
] as const

export function OrganizationSettingsNav(props: {
  orgSlug: string
  current: string
}) {
  const { orgSlug, current } = props

  return (
    <nav
      aria-label="Organisation settings"
      className={cn(
        "flex w-full flex-col gap-1 md:w-48 lg:w-60",
        organizationViewClassNames.sidebar?.base,
      )}
    >
      {NAV_ITEMS.map((item) => {
        const isActive = current === item.view
        return (
          <Link
            key={item.view}
            to="/$orgSlug/organization/$organizationView"
            params={{ orgSlug, organizationView: item.view }}
          >
            <span
              className={cn(
                "flex w-full justify-start px-3 py-2 text-sm font-normal tracking-normal transition-colors hover:bg-white/[0.05]",
                organizationViewClassNames.sidebar?.button,
                isActive ? "font-medium text-teal-400" : "text-foreground/70",
                isActive && organizationViewClassNames.sidebar?.buttonActive,
              )}
            >
              {item.label}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
