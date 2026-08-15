import { write } from "./write.mjs"

export function family(root, letter, dark, light, m64, m64mono, m16) {
  write(root + `${letter}-dark.svg`, dark)
  write(root + `${letter}-light.svg`, light)
  write(root + `${letter}-mark.svg`, m64)
  write(root + `${letter}-mark-mono.svg`, m64mono)
  write(root + `${letter}-mark16.svg`, m16)
}
