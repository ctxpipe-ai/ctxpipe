import { useMatchRoute, useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Link } from "react-aria-components"

type SideNavItemProps = {
  to: "/$orgSlug" | "/$orgSlug/account" | "/$orgSlug/account/$accountView"
  params: { orgSlug: string | null; accountView?: string }
  label: string
  icon: ReactNode
  expanded: boolean
  exact?: boolean
}

export function SideNavItem({
  to,
  params,
  label,
  icon,
  expanded,
  exact = false,
}: SideNavItemProps) {
  const router = useRouter()
  const matchRoute = useMatchRoute()
  if (!params.orgSlug) return null

  const href = router.buildLocation({
    to,
    params: params.accountView
      ? {
          orgSlug: params.orgSlug,
          accountView: params.accountView,
        }
      : { orgSlug: params.orgSlug },
  }).href
  const isActive = Boolean(
    matchRoute({
      to,
      params: params.accountView
        ? {
            orgSlug: params.orgSlug,
            accountView: params.accountView,
          }
        : { orgSlug: params.orgSlug },
      fuzzy: !exact,
    }),
  )

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      aria-label={expanded ? undefined : label}
      className={[
        "group relative flex h-10 items-center text-sm font-medium transition-colors",
        "hover:bg-teal-900/30 hover:text-zinc-50",
        isActive ? "text-zinc-100" : "text-zinc-300",
      ].join(" ")}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-1/2 h-10 w-0.5 -translate-y-1/2 rounded-r bg-primary-400 opacity-0 transition-opacity group-aria-[current=page]:opacity-100"
      />
      <span className="flex h-5 *:h-full *:stroke-[1.4] pr-4 pl-4 shrink-0 items-center justify-center text-zinc-400 group-hover:text-zinc-200 group-aria-[current=page]:text-white">
        {icon}
      </span>
      <span
        className={[
          "whitespace-nowrap transition-all duration-200",
          expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
        ].join(" ")}
      >
        {label}
      </span>
    </Link>
  )
}
