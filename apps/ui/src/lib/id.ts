import { base32nopad } from "@scure/base"
import { parse as uuidParse, v7 as uuidv7 } from "uuid"

export function createObjectId(prefix: string): string {
  return `${prefix}_${base32nopad.encode(uuidParse(uuidv7())).toLowerCase()}`
}
