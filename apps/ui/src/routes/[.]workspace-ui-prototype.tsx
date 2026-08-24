import { createFileRoute, notFound } from "@tanstack/react-router"

export const Route = createFileRoute("/.workspace-ui-prototype")({
  ssr: false,
  beforeLoad: () => {
    throw notFound()
  },
  component: () => null,
})
