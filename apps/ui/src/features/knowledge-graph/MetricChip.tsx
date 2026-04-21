import { FloatingPanel, PanelLabel } from "./FloatingPanel"

export function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <FloatingPanel className="px-3 py-1.5">
      <PanelLabel>{label}</PanelLabel>
      <p className="font-mono text-[13px] font-semibold tabular-nums text-zinc-100">
        {value.toLocaleString()}
      </p>
    </FloatingPanel>
  )
}
