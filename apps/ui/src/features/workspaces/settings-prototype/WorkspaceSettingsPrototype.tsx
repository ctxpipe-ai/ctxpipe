/**
 * PROTOTYPE, throwaway (see prototype-variant.ts). Mounts one variant of
 * Workspace settings in the pane. The model holds the data and the actions;
 * a variant only lays them out.
 */
import type { WorkspaceDetail } from "../types"
import type { SettingsVariantKey } from "./prototype-variant"
import { useSettingsModel } from "./use-settings-model"
import { VariantA } from "./VariantA"
import { VariantB } from "./VariantB"
import { VariantC } from "./VariantC"
import { VariantD } from "./VariantD"

export function WorkspaceSettingsPrototype(props: {
  variant: Exclude<SettingsVariantKey, "current">
  orgSlug: string
  workspace: WorkspaceDetail
  onOpenFile: (path: string) => void
  onFixWithAgent?: (prompt: string) => void
}) {
  const model = useSettingsModel(props)
  return (
    <div
      data-settings-scroll
      className="@container min-h-0 flex-1 overflow-auto"
    >
      {props.variant === "A" ? <VariantA model={model} /> : null}
      {props.variant === "B" ? <VariantB model={model} /> : null}
      {props.variant === "C" ? <VariantC model={model} /> : null}
      {props.variant === "D" ? <VariantD model={model} /> : null}
      {model.dialogs}
    </div>
  )
}
