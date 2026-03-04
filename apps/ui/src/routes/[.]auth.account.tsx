import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/.auth/account")({
  component: () => <Outlet />,
})
