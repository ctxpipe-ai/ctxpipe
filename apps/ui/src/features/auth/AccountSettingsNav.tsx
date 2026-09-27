import { Link } from "@tanstack/react-router"
import { betterAuthShellClassNames } from "@/features/auth/betterAuthShellClassNames"
import { cn } from "@/lib/utils"

const NAV_ITEMS = [
  { view: "settings", label: "Account" },
  { view: "security", label: "Security" },
  { view: "api-keys", label: "API Keys" },
  { view: "organizations", label: "Organisations" },
] as const

export function AccountSettingsNav(props: { current: string }) {
  return (
    <nav
      aria-label="User account"
      className={cn(
        "flex w-full flex-col gap-1 md:w-48 lg:w-60",
        betterAuthShellClassNames.sidebar?.base,
      )}
    >
      {NAV_ITEMS.map((item) => {
        const isActive = props.current === item.view
        return (
          <Link
            key={item.view}
            to="/.auth/account/$accountView"
            params={{ accountView: item.view }}
          >
            <span
              className={cn(
                "flex w-full justify-start px-3 py-2 text-sm font-normal tracking-normal transition-colors hover:bg-white/[0.05]",
                betterAuthShellClassNames.sidebar?.button,
                isActive ? "font-medium text-teal-400" : "text-foreground/70",
                isActive && betterAuthShellClassNames.sidebar?.buttonActive,
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
