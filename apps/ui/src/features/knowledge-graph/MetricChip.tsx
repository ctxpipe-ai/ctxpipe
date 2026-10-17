import { FloatingPanel, PanelLabel } from "./FloatingPanel"

export function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <FloatingPanel className="px-3 py-1.5">
      <PanelLabel>{label}</PanelLabel>
      <p className="font-mono text-sm font-medium tabular-nums text-foreground">
        {value.toLocaleString()}
      </p>
    </FloatingPanel>
  )
}
