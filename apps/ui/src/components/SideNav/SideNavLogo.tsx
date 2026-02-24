import { Link } from "@tanstack/react-router"

type SideNavLogoProps = {
  expanded: boolean
}

export function SideNavLogo({ expanded }: SideNavLogoProps) {
  return (
    <Link
      to="/"
      title="Home"
      className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-zinc-100 transition-colors hover:bg-zinc-800/80"
    >
      <img
        src="/icons/icon-white-on-transparent-512x512.png"
        alt="ctxpipe"
        className="h-6 w-6 shrink-0 rounded border border-zinc-700/80 bg-zinc-900 p-0.5"
      />
      <span
        className={[
          "font-mono text-[11px] uppercase tracking-[0.24em] text-zinc-300 transition-all duration-200",
          expanded ? "opacity-100" : "w-0 overflow-hidden opacity-0",
        ].join(" ")}
      >
        ctxpipe
      </span>
    </Link>
  )
}
