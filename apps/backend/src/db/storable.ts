/**
 * Postgres refuses a NUL character in `text` and in a `jsonb` value, and it
 * refuses a lone surrogate in a `jsonb` value. Return `value` with each NUL
 * removed and each lone surrogate replaced with U+FFFD, in keys and in
 * values. Postgres cannot keep these characters, so nothing that it can keep
 * is lost. The JSON round trip keeps the form that Postgres stores (for
 * example, a Date becomes its ISO string).
 */
export function storable<T>(value: T, text = JSON.stringify(value)): T {
  if (value === undefined) return value
  // The UI project also compiles this file, and its lib has no
  // `String.prototype.toWellFormed`.
  const clean = (text: string) =>
    text
      .replaceAll("\u0000", "")
      .replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        "\ufffd",
      )
  return JSON.parse(text, (_key, item: unknown) => {
    if (typeof item === "string") return clean(item)
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [clean(key), entry]),
      )
    return item
  })
}
