import type { ReactNode } from "react"
import { useState } from "react"
import { useRouter } from "@tanstack/react-router"
import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { SideNav } from "@/components/SideNav"
import { ShellLayoutProvider } from "@/components/ShellLayoutContext"

type AppShellProps = {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  const [animateOnMount] = useState(() => {
    if (typeof window === "undefined") return false
    const shouldAnimate =
      sessionStorage.getItem("ctxpipe:app-shell-fade-in") === "1"
    if (shouldAnimate) {
      sessionStorage.removeItem("ctxpipe:app-shell-fade-in")
    }
    return shouldAnimate
  })

  return (
    <ShellLayoutProvider>
      <div
        className={`${animateOnMount ? "app-shell-fade-in-onboarding" : ""} relative flex min-h-screen min-w-0 bg-zinc-950 text-zinc-100`}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-0 z-0 opacity-50"
          style={{
            backgroundImage:
              "radial-gradient(circle at 20% -10%, rgba(64, 224, 208, 0.14), transparent 45%), radial-gradient(circle at 90% 110%, rgba(59, 130, 246, 0.12), transparent 40%), linear-gradient(rgba(255,255,255,0.008) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.008) 1px, transparent 1px)",
            backgroundSize: "auto, auto, 24px 24px, 24px 24px",
            backgroundPosition: "center, center, center, center",
          }}
        />
        <SideNav />
        <AppShellMain>{children}</AppShellMain>
      </div>
    </ShellLayoutProvider>
  )
}

function AppShellMain(props: { children: ReactNode }) {
  const router = useRouter()
  const pathname = router.state?.location.pathname ?? ""
  const isWorkspaceSurface = pathname.includes("/ws/")

  return (
    <main
      className={[
        "relative z-10 flex min-h-screen min-w-0 flex-1 flex-col",
        // Room for the floating burger on non-workspace pages (workspace chrome owns its own).
        !isWorkspaceSurface ? "max-md:pl-11" : "",
      ].join(" ")}
    >
      {!isWorkspaceSurface ? (
        <div className="absolute left-1 top-[6.5px] z-40 md:hidden">
          <OverlayNavMenuButton />
        </div>
      ) : null}
      {props.children}
    </main>
  )
}
