import { IconLoader } from "@tabler/icons-react"

import { cn } from "@/lib/utils"

/**
 * A small icon that turns, with the `status` role and the label "Loading". Use
 * it only for a short wait inside a control, such as the send button of the
 * chat prompt. Use `InlineLoader` for a process wait (an install, a sign-in or
 * another outside step), `Button` with `isPending` for a button, and
 * `Skeleton` for content that loads.
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
