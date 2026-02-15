/**
 * Generate IDs in the format <prefix>_<base32 encoded uuid>.
 * Base32 uses RFC 4648 alphabet (A-Z, 2-7), no padding.
 */
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32Encode(bytes: Uint8Array): string {
  let result = ""
  let buffer = 0
  let bits = 0
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === undefined) continue
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      const idx = (buffer >> bits) & 31
      result += BASE32_ALPHABET[idx] ?? ""
    }
  }
  if (bits > 0) {
    const idx = (buffer << (5 - bits)) & 31
    result += BASE32_ALPHABET[idx] ?? ""
  }
  return result
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) {
    const b = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isNaN(b)) bytes[i] = b
  }
  return bytes
}

/**
 * Generate an ID in the format `<prefix>_<base32 encoded uuid>`.
 * @param prefix - e.g. "repo", "org" (underscore is added automatically)
 */
export function generateObjectId(prefix: string): string {
  return `${prefix}_${base32Encode(uuidToBytes(crypto.randomUUID()))}`
}
