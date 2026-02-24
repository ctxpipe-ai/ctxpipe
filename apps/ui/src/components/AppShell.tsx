import { type ReactNode, useEffect, useState } from "react"
import { SideNav, collapsedMainClass, expandedMainClass } from "@/components/SideNav"

type AppShellProps = {
  children?: ReactNode
  defaultExpanded?: boolean
  persistKey?: string | null
}

export function AppShell({
  children,
  defaultExpanded = true,
  persistKey = "ctxpipe:app-shell-expanded",
}: AppShellProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  useEffect(() => {
    if (!persistKey || typeof window === "undefined") {
      return
    }
    const stored = window.localStorage.getItem(persistKey)
    if (stored === null) {
      return
    }
    setExpanded(stored === "1")
  }, [persistKey])

  useEffect(() => {
    if (!persistKey || typeof window === "undefined") {
      return
    }
    window.localStorage.setItem(persistKey, expanded ? "1" : "0")
  }, [expanded, persistKey])

  return (
    <div className="relative min-h-screen overflow-x-clip bg-zinc-950 text-zinc-100">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% -10%, rgba(45, 212, 191, 0.14), transparent 45%), radial-gradient(circle at 90% 110%, rgba(59, 130, 246, 0.12), transparent 40%), linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)",
          backgroundSize: "auto, auto, 24px 24px, 24px 24px",
          backgroundPosition: "center, center, center, center",
        }}
      />
      <SideNav expanded={expanded} onToggle={() => setExpanded((value) => !value)} />

      <main
        className={[
          "relative min-h-screen px-4 py-6 sm:px-8 sm:py-8",
          expanded ? expandedMainClass : collapsedMainClass,
        ].join(" ")}
      >
        {children ?? (
          <section className="mx-auto flex min-h-[70vh] h-full max-w-5xl items-center justify-center">
            <div className="w-full rounded-2xl border border-zinc-800/90 bg-zinc-900/70 p-8 shadow-2xl shadow-black/30 backdrop-blur-sm sm:p-10">
              <p className="font-mono text-xs uppercase tracking-[0.24em] text-primary-300">
                ctxpipe ui
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">
                Welcome back
              </h1>
              <p className="mt-4 max-w-2xl text-zinc-300">
                This shell is now ready for product pages. Use the navigation on
                the left to access account and settings views.
              </p>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
