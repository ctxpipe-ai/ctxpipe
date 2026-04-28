import type { ReactNode } from "react"
import { Button } from "react-aria-components"

export function MapControlButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void
  label: string
  children: ReactNode
}) {
  return (
    <Button
      onPress={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-none border border-zinc-800/95 bg-zinc-950/90 text-zinc-300 shadow-xl shadow-black/40 backdrop-blur-md transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100"
    >
      {children}
    </Button>
  )
}
