import type { ReactNode, SVGProps } from "react"

export type DocsIconName =
  | "arrow"
  | "book"
  | "chat"
  | "cloud"
  | "code"
  | "database"
  | "git"
  | "graph"
  | "plug"
  | "rocket"
  | "search"
  | "server"
  | "shield"
  | "terminal"
  | "users"
  | "wrench"

const paths: Record<DocsIconName, ReactNode> = {
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  book: (
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Zm16 0A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" />
  ),
  chat: (
    <path d="M5 17.5 3.5 21l4.3-1.6c1.2.4 2.6.6 4.2.6 5 0 9-3.4 9-8s-4-8-9-8-9 3.4-9 8c0 2.1.7 4 2 5.5ZM8 10h8M8 14h5" />
  ),
  cloud: (
    <path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 8.7 4.7 4.7 0 0 0 7 18Z" />
  ),
  code: <path d="m9 7-5 5 5 5m6-10 5 5-5 5m-4 2 2-14" />,
  database: (
    <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  ),
  git: (
    <path d="M6 3v12a3 3 0 1 0 2 2.83V8h7a3 3 0 1 0 0-2H8V3H6Zm11 3a1 1 0 1 1 0 2 1 1 0 0 1 0-2ZM7 17a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z" />
  ),
  graph: (
    <path d="M5 5h4v4H5V5Zm10 0h4v4h-4V5ZM9 15h6v4H9v-4ZM9 7h6m-8 2 4 6m6-6-4 6" />
  ),
  plug: (
    <path d="M8 3v5m8-5v5M6 8h12v2a6 6 0 0 1-5 5.92V21h-2v-5.08A6 6 0 0 1 6 10V8Z" />
  ),
  rocket: (
    <path d="M14 5c2.5-2.5 5.5-2 5.5-2s.5 3-2 5.5l-4.5 4.5-4-4L14 5Zm-6 5-3 1-2 3 5-1m5 3-1 5-3-2 1-3m4-10 3 3M6 18l-2 2" />
  ),
  search: (
    <path d="m20 20-4.5-4.5M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />
  ),
  server: (
    <path d="M4 4h16v6H4V4Zm0 10h16v6H4v-6ZM7 7h.01M7 17h.01M11 7h6m-6 10h6" />
  ),
  shield: (
    <path d="M12 3 4.5 6v5.5c0 4.6 3.1 7.9 7.5 9.5 4.4-1.6 7.5-4.9 7.5-9.5V6L12 3Zm-3 9 2 2 4-4" />
  ),
  terminal: <path d="m5 7 4 4-4 4m6 1h8" />,
  users: (
    <path d="M16 20v-1.5a4.5 4.5 0 0 0-4.5-4.5h-3A4.5 4.5 0 0 0 4 18.5V20m6-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-1a3 3 0 0 0 0-6m3 16v-1.5a4.5 4.5 0 0 0-3-4.24" />
  ),
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5-5l2.2 2.2-2.4 2.4-2.2-2.2a4 4 0 0 0 5 5L19 15.4a2.55 2.55 0 1 1-3.6 3.6l-6.7-6.7" />
  ),
}

export function DocsIcon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: DocsIconName }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <title>{name} icon</title>
      {paths[name]}
    </svg>
  )
}

export function docsIconForHref(href?: string): DocsIconName {
  if (!href) return "arrow"
  if (href.includes("getting-started") || href.includes("quickstart"))
    return "rocket"
  if (href.includes("connection") || href.includes("connector")) return "plug"
  if (href.includes("git-repositories") || href.includes("github")) return "git"
  if (href.includes("mcp") || href.includes("memory")) return "terminal"
  if (href.includes("chat")) return "chat"
  if (href.includes("knowledge-graph") || href.includes("graph-database"))
    return "graph"
  if (href.includes("organization") || href.includes("team")) return "users"
  if (
    href.includes("security") ||
    href.includes("privacy") ||
    href.includes("auth")
  )
    return "shield"
  if (href.includes("deployment") || href.includes("self-hosting"))
    return "server"
  if (href.includes("model")) return "cloud"
  if (href.includes("operation") || href.includes("upgrade")) return "wrench"
  if (href.includes("open-source") || href.includes("docs")) return "book"
  return "arrow"
}
