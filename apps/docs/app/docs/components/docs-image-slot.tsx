import { ImageZoom } from "fumadocs-ui/components/image-zoom"

type ImageSlotProps = {
  title: string
  description?: string
  src?: string
  alt?: string
  aspect?: "wide" | "standard" | "tall"
}

export function ImageSlot({
  title,
  description,
  src,
  alt,
  aspect = "wide",
}: ImageSlotProps) {
  const aspectClass =
    aspect === "tall"
      ? "docs-image-slot--tall"
      : aspect === "standard"
        ? "docs-image-slot--standard"
        : "docs-image-slot--wide"

  if (src) {
    return (
      <figure className={`not-prose docs-image-slot ${aspectClass}`}>
        <ImageZoom src={src} alt={alt ?? title}>
          <img src={src} alt={alt ?? title} />
        </ImageZoom>
        {description ? <figcaption>{description}</figcaption> : null}
      </figure>
    )
  }

  return (
    <figure className={`not-prose docs-image-slot ${aspectClass}`}>
      <div className="docs-image-slot__placeholder">
        <span className="docs-image-slot__eyebrow">Image slot</span>
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
    </figure>
  )
}
