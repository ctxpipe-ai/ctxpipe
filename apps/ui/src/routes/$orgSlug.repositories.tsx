import { Outlet, createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/repositories")({
  component: RepositoriesLayout,
})

function RepositoriesLayout() {
  return <Outlet />
}
