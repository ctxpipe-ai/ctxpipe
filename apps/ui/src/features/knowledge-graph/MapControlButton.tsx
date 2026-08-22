import type { ReactNode } from "react"
import { Button } from "@/components/ui/Button"

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
    <Button variant="ghost" size="icon-sm" onPress={onClick} aria-label={label}>
      {children}
    </Button>
  )
}
