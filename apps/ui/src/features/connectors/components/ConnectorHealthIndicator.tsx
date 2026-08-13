import { type ConnectorHealth, connectorHealthLabel } from "../connectorHealth"

const TONE: Record<
  ConnectorHealth,
  { text: string; dot: string; pulse: boolean }
> = {
  checking: {
    text: "text-muted-foreground",
    dot: "bg-zinc-500",
    pulse: true,
  },
  not_connected: {
    text: "text-muted-foreground",
    dot: "bg-zinc-500",
    pulse: false,
  },
  connected: {
    text: "text-emerald-400",
    dot: "bg-emerald-400",
    pulse: true,
  },
  error: {
    text: "text-red-400",
    dot: "bg-red-400",
    pulse: true,
  },
}

export function ConnectorHealthIndicator({
  health,
}: {
  health: ConnectorHealth
}) {
  const tone = TONE[health]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 font-mono text-xs ${tone.text}`}
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${tone.dot} ${
          tone.pulse ? "ctx-status-pulse" : ""
        }`}
      />
      {connectorHealthLabel(health)}
    </span>
  )
}
