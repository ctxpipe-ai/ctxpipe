import { useMatchRoute, useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Link } from "react-aria-components"

type SideNavItemProps = {
  to: "/$orgSlug" | "/$orgSlug/connectors"
  params: { orgSlug: string | null }
  label: string
  icon: ReactNode
  expanded: boolean
  exact?: boolean
  status?: {
    label: string
    tone: "indexing" | "failed"
  }
}

export function SideNavItem({
  to,
  params,
  label,
  icon,
  expanded,
  exact = false,
  status,
}: SideNavItemProps) {
  const router = useRouter()
  const matchRoute = useMatchRoute()
  if (!params.orgSlug) return null

  const href = router.buildLocation(
    to === "/$orgSlug/connectors"
      ? {
          to,
          params: { orgSlug: params.orgSlug },
          search: {
            error: undefined,
            error_description: undefined,
            pendingAccountClaim: undefined,
            notionConnectionId: undefined,
          },
        }
      : { to, params: { orgSlug: params.orgSlug } },
  ).href
  const isActive = Boolean(
    matchRoute({
      to,
      params: { orgSlug: params.orgSlug },
      fuzzy: !exact,
    }),
  )

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      aria-label={
        expanded ? undefined : status ? `${label}, ${status.label}` : label
      }
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
      <span className="flex h-5 *:h-full *:stroke-[1.4] px-5 shrink-0 items-center justify-center text-zinc-400 group-hover:text-zinc-200 group-aria-[current=page]:text-white">
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
      {status ? (
        <span
          className={[
            "shrink-0",
            expanded ? "ml-2" : "absolute left-10 top-2 ring-2 ring-zinc-950",
            status.tone === "failed"
              ? "ctx-indexing-failed-dot"
              : "ctx-indexing-dot",
          ].join(" ")}
          aria-hidden
        />
      ) : null}
      {expanded && status ? (
        <span className="sr-only">, {status.label}</span>
      ) : null}
    </Link>
  )
}
