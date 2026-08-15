import { createFileRoute } from "@tanstack/react-router"
import type {
  SceneKey,
  VariantKey,
} from "@/features/workspace-ui-prototype/mock"
import { WorkspaceUiPrototype } from "@/features/workspace-ui-prototype/WorkspaceUiPrototype"

function parseVariant(value: unknown): VariantKey {
  return value === "B" || value === "C" ? value : "A"
}

function parseScene(value: unknown): SceneKey {
  return value === "one-ws" ||
    value === "empty-org" ||
    value === "empty-ws" ||
    value === "readonly"
    ? value
    : "populated"
}

export const Route = createFileRoute("/.workspace-ui-prototype")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    variant: parseVariant(search.variant),
    scene: parseScene(search.scene),
  }),
  component: WorkspaceUiPrototypeRoute,
})

function WorkspaceUiPrototypeRoute() {
  const { variant, scene } = Route.useSearch()
  return <WorkspaceUiPrototype variant={variant} scene={scene} />
}
