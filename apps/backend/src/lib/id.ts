import { base32nopad } from "@scure/base"
import { parse as uuidParse, v7 as uuidv7 } from "uuid"

/**
 * Generate an ID in the format `<prefix>_<base32 encoded uuidv7 bytes>`.
 * @param prefix - e.g. "repo", "org" (underscore is added automatically)
 */
export function generateObjectId(prefix: string): string {
  return `${prefix}_${base32nopad.encode(uuidParse(uuidv7())).toLowerCase()}`
}
