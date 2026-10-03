import { createFileRoute } from "@tanstack/react-router"
import { AppShell } from "@/components/AppShell"
import { AccountSettingsBody } from "./[.]auth.account.$accountView"

export const Route = createFileRoute("/.auth/account/")({
  component: AccountIndexRoute,
})

function AccountIndexRoute() {
  return (
    <AppShell>
      <AccountSettingsBody accountView="settings" />
    </AppShell>
  )
}
