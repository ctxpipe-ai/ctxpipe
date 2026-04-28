import { cn } from "@/lib/utils"
import { IconCircleCheck } from "@tabler/icons-react"

function SuccessIcon({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <IconCircleCheck
      role="img"
      aria-label="Success"
      className={cn("size-5 text-emerald-500", className)}
      {...props}
    />
  )
}

export { SuccessIcon }
