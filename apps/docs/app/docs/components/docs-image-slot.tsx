import { ImageZoom } from "fumadocs-ui/components/image-zoom"

type ImageSlotProps = {
  title: string
  src: string
  description?: string
  alt?: string
}

/**
 * A docs image with zoom. Use it in MDX in place of Markdown image syntax:
 * fumadocs-mdx turns a Markdown image into a static import object, and the
 * plain `img` mapping prints that object as `src="[object Object]"`.
 */
export function ImageSlot({ title, src, description, alt }: ImageSlotProps) {
  return (
    <figure className="not-prose docs-image-slot">
      <ImageZoom src={src} alt={alt ?? title}>
        <img src={src} alt={alt ?? title} />
      </ImageZoom>
      {description ? <figcaption>{description}</figcaption> : null}
    </figure>
  )
}
