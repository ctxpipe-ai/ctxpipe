import { createFileRoute, redirect } from "@tanstack/react-router"

// Old bookmark. This page was removed, so open the organization home.
export const Route = createFileRoute("/$orgSlug/repositories/$")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$orgSlug",
      params: { orgSlug: params.orgSlug },
      replace: true,
    })
  },
})
