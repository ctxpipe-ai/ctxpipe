import { IconLoader } from "@tabler/icons-react"

import { cn } from "@/lib/utils"

/**
 * A small icon that turns, with the `status` role and the label "Loading". Use
 * it next to a short text while a step waits for an outside event, such as an
 * install or a redirect. Use `Button` with `isPending` for a button,
 * `InlineLoader` for a process wait, and `Skeleton` for content that loads.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <IconLoader
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
