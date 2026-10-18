import { cn } from "@/lib/utils"

export function StatusTag({
  label,
  className,
  pulse,
}: {
  label: string
  className: string
  pulse?: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs",
        className,
      )}
    >
      <span
        className={
          pulse
            ? "size-1.5 shrink-0 animate-pulse rounded-full bg-current"
            : "size-1.5 shrink-0 rounded-full bg-current"
        }
        aria-hidden
      />
      {label}
    </span>
  )
}
