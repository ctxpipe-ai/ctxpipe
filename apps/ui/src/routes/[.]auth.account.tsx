import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/.auth/account")({
  beforeLoad: ({ location }) => {
    const path = location.pathname.replace(/\/+$/, "")
    if (path !== "/.auth/account") return
    throw redirect({
      to: "/.auth/account/$accountView",
      params: { accountView: "settings" },
      replace: true,
    })
  },
  component: () => <Outlet />,
})
