import { useMatchRoute, useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { Link } from "react-aria-components"
import {
  sideNavActiveBarClassName,
  sideNavIconGutterClassName,
  sideNavLabelClassName,
  sideNavRowClassName,
} from "./sideNavStyles"
import { SideNavTooltip } from "./SideNavTooltip"

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

  const tooltipLabel = status ? `${label}, ${status.label}` : label

  return (
    <SideNavTooltip label={tooltipLabel} enabled={!expanded}>
      <Link
        href={href}
        aria-current={isActive ? "page" : undefined}
        aria-label={expanded ? undefined : tooltipLabel}
        className={sideNavRowClassName({ active: isActive })}
      >
        <span aria-hidden="true" className={sideNavActiveBarClassName} />
        <span className={sideNavIconGutterClassName}>{icon}</span>
        <span
          className={[sideNavLabelClassName(expanded), "truncate pr-2"].join(
            " ",
          )}
          aria-hidden={!expanded}
        >
          {label}
        </span>
        {status ? (
          <span
            className={[
              "shrink-0 transition-opacity duration-200",
              expanded ? "mr-2 opacity-100" : "absolute right-1 top-1.5 opacity-100 ring-2 ring-zinc-950",
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
    </SideNavTooltip>
  )
}
