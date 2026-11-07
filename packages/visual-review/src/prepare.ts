import { decode, encode, type Image } from "@blazediff/codec-png-native"

// Each side of an image that goes to a vision model, in pixels. Jev takes the
// same range, and it keeps the total pixels within the limits of the models.
const minSide = 280
const maxSide = 1568
const gray = [128, 128, 128, 255] as const

/**
 * The width and height of PNG bytes, read from the header (the big-endian
 * numbers at bytes 16 to 23), or null when the bytes are not a PNG.
 */
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Scale `image` down to `width` × `height`. Each output pixel is the mean of
 * the source pixels that it covers.
 */
export function shrink(image: Image, width: number, height: number): Image {
  const out = { data: new Uint8Array(width * height * 4), width, height }
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor((y * image.height) / height)
    const y1 = Math.max(
      y0 + 1,
      Math.min(image.height, Math.floor(((y + 1) * image.height) / height)),
    )
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor((x * image.width) / width)
      const x1 = Math.max(
        x0 + 1,
        Math.min(image.width, Math.floor(((x + 1) * image.width) / width)),
      )
      let [r, g, b, a] = [0, 0, 0, 0]
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * image.width + sx) * 4
          r += image.data[i] ?? 0
          g += image.data[i + 1] ?? 0
          b += image.data[i + 2] ?? 0
          a += image.data[i + 3] ?? 0
        }
      }
      const count = (y1 - y0) * (x1 - x0)
      out.data.set(
        [r, g, b, a].map((value) => Math.round(value / count)),
        (y * width + x) * 4,
      )
    }
  }
  return out
}

/** The result of `prepareImage`. */
export type Prepared = {
  png: Uint8Array
  /**
   * The part of `png` that holds the picture, in fractions (0..1) of each
   * side. The picture is at the top left. Padding fills the rest. A box that
   * a judge draws on `png` maps to the original picture when it is divided
   * by these fractions.
   */
  content: { width: number; height: number }
}

/**
 * Bring PNG bytes within the side limits of the vision models: each side from
 * 280 to 1568 px. An image with a side over 1568 px is scaled down, with its
 * aspect ratio. Then a side under 280 px is padded with gray, and the picture
 * stays at the top left. An image that is within the limits comes back as it
 * is, and so do bytes that are not a PNG.
 */
export function prepareImage(bytes: Uint8Array): Prepared {
  const size = pngSize(bytes)
  const whole = { png: bytes, content: { width: 1, height: 1 } }
  if (
    !size ||
    (size.width >= minSide &&
      size.height >= minSide &&
      size.width <= maxSide &&
      size.height <= maxSide)
  )
    return whole
  let image = decode(bytes)
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height))
  if (scale < 1)
    image = shrink(
      image,
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    )
  const width = Math.max(minSide, image.width)
  const height = Math.max(minSide, image.height)
  const padded = { data: new Uint8Array(width * height * 4), width, height }
  for (let i = 0; i < padded.data.length; i += 4) padded.data.set(gray, i)
  for (let y = 0; y < image.height; y++)
    padded.data.set(
      image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
      y * width * 4,
    )
  return {
    png: encode(padded),
    content: { width: image.width / width, height: image.height / height },
  }
}
