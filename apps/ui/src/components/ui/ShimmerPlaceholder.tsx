import { cn } from "@/lib/utils"

function ShimmerPlaceholder({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "relative inline-block overflow-hidden rounded bg-zinc-700",
        "before:absolute before:inset-0 before:-translate-x-full before:bg-linear-to-r before:from-transparent before:via-white/10 before:to-transparent before:animate-[shimmer_1.5s_ease-in-out_infinite]",
        className,
      )}
      {...props}
    />
  )
}

export { ShimmerPlaceholder }
