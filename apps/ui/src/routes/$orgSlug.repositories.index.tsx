import { createFileRoute, notFound } from "@tanstack/react-router"

export const Route = createFileRoute("/$orgSlug/repositories/")({
  beforeLoad: () => {
    throw notFound()
  },
})
