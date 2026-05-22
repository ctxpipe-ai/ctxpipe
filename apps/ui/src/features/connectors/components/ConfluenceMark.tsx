import { useId } from "react"
import { cn } from "@/lib/utils"

type ConfluenceMarkProps = {
  className?: string
  variant?: "brand" | "outline"
}

/** Confluence product mark (icon only) from Atlassian brand SVG. */
export function ConfluenceMark({
  className,
  variant = "brand",
}: ConfluenceMarkProps) {
  const rawId = useId().replace(/:/g, "")
  const gradA = `${rawId}-cf-a`
  const gradB = `${rawId}-cf-b`

  // Tight bbox of the two mark paths (~0.23–62.52 × ~3.77–63.52), expanded to a
  // square so `size-*` square viewports center the mark (wide loose viewBox skewed it).
  return (
    <svg
      viewBox="0.23 2.5 62.3 62.3"
      className={cn("shrink-0", className)}
      role="img"
      aria-label="Confluence"
    >
      <title>Confluence</title>
      {variant === "brand" ? (
        <defs>
          <linearGradient
            id={gradA}
            gradientUnits="userSpaceOnUse"
            x1="59.68"
            x2="20.35"
            y1="67.65"
            y2="45.05"
          >
            <stop offset=".18" stopColor="#0052cc" />
            <stop offset="1" stopColor="#2684ff" />
          </linearGradient>
          <linearGradient
            id={gradB}
            gradientUnits="userSpaceOnUse"
            gradientTransform="matrix(-1 0 0 -1 282.83 -1616.71)"
            href={`#${gradA}`}
            x1="279.76"
            x2="240.42"
            y1="-1616.34"
            y2="-1638.95"
          />
        </defs>
      ) : null}
      <path
        fill={variant === "brand" ? `url(#${gradA})` : "none"}
        stroke={variant === "outline" ? "currentColor" : undefined}
        strokeLinecap={variant === "outline" ? "round" : undefined}
        strokeLinejoin={variant === "outline" ? "round" : undefined}
        strokeWidth={variant === "outline" ? 4 : undefined}
        d="m2.23 49.53c-.65 1.06-1.38 2.29-2 3.27a2 2 0 0 0 .67 2.72l13 8a2 2 0 0 0 2.77-.68c.52-.87 1.19-2 1.92-3.21 5.15-8.5 10.33-7.46 19.67-3l12.89 6.13a2 2 0 0 0 2.69-1l6.19-14a2 2 0 0 0 -1-2.62c-2.72-1.28-8.13-3.83-13-6.18-17.52-8.51-32.41-7.96-43.8 10.57z"
      />
      <path
        fill={variant === "brand" ? `url(#${gradB})` : "none"}
        stroke={variant === "outline" ? "currentColor" : undefined}
        strokeLinecap={variant === "outline" ? "round" : undefined}
        strokeLinejoin={variant === "outline" ? "round" : undefined}
        strokeWidth={variant === "outline" ? 4 : undefined}
        d="m60.52 17.76c.65-1.06 1.38-2.29 2-3.27a2 2 0 0 0 -.67-2.72l-13-8a2 2 0 0 0 -2.85.66c-.52.87-1.19 2-1.92 3.21-5.15 8.5-10.33 7.46-19.67 3l-12.85-6.1a2 2 0 0 0 -2.69 1l-6.19 14a2 2 0 0 0 1 2.62c2.72 1.28 8.13 3.83 13 6.18 17.56 8.5 32.45 7.93 43.84-10.58z"
      />
    </svg>
  )
}
