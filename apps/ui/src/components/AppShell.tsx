import { useRouter } from "@tanstack/react-router"
import type { ReactNode } from "react"

import { OverlayNavMenuButton } from "@/components/OverlayNavButton"
import { ShellLayoutProvider } from "@/components/ShellLayoutContext"
import { SideNav } from "@/components/SideNav"

type AppShellProps = {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <ShellLayoutProvider>
      <div className="relative flex min-h-screen min-w-0 bg-zinc-950 text-zinc-100">
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
