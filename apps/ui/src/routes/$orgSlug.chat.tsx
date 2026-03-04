import { AppShell } from "@/components/AppShell"
import { Outlet, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/chat")({
  component: ChatRoute,
})

function ChatRoute() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
