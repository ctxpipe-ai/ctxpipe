import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"

type SideNavItemProps = {
  to: "/" | "/account" | "/account/$accountView" | "/repositories"
  params?: { accountView: string }
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
  return (
    <Link
      to={to}
      params={params}
      activeOptions={{ exact }}
      title={expanded ? undefined : label}
      className="group relative flex h-10 items-center rounded-md border border-transparent text-sm font-medium text-zinc-400 transition-colors hover:border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100"
      activeProps={{
        "aria-current": "page",
        className:
          "group relative flex h-10 items-center rounded-md border border-zinc-700/90 bg-zinc-800/80 text-sm font-medium text-zinc-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] transition-colors",
      }}
    >
      <span
        aria-hidden="true"
        className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary-400 opacity-0 transition-opacity group-aria-[current=page]:opacity-100"
      />
      <span className="flex w-10 shrink-0 items-center justify-center text-zinc-400 group-hover:text-zinc-200 group-aria-[current=page]:text-primary-300">
        {icon}
      </span>
      <span
        className={[
          "whitespace-nowrap text-[13px] transition-all duration-200",
          expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
        ].join(" ")}
      >
        {label}
      </span>
    </Link>
  )
}
