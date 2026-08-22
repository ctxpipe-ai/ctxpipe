import { slabLockup, markWindow, mark16, TEAL, TEAL_LIGHT, INK_DARK } from "../../term.mjs"
import { family } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname

function marks() {
  return [
    markWindow({ frame: INK_DARK, screen: TEAL, pipe: "#09090B", title: true }),
    markWindow({ frame: INK_DARK, screen: INK_DARK, pipe: INK_DARK, title: true }),
    mark16({ frame: INK_DARK, pipe: TEAL, screen: TEAL, cursor: "#09090B" }),
  ]
}

// A ref
family(
  root,
  "a",
  slabLockup({ title: "#3F3F46", glass: TEAL, titleH: 20, padY: 18, scale: 0.58 }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT, titleH: 20, padY: 18, scale: 0.58 }),
  ...marks(),
)
// B more glass
family(
  root,
  "b",
  slabLockup({ title: "#3F3F46", glass: TEAL, titleH: 20, padY: 22, padX: 16, scale: 0.56 }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT, titleH: 20, padY: 22, padX: 16, scale: 0.56 }),
  ...marks(),
)
// C heavier zinc
family(
  root,
  "c",
  slabLockup({ title: "#27272A", glass: TEAL, titleH: 22, padY: 18, scale: 0.58 }),
  slabLockup({ title: "#A1A1AA", glass: TEAL_LIGHT, titleH: 22, padY: 18, scale: 0.58 }),
  ...marks(),
)
// D tighter
family(
  root,
  "d",
  slabLockup({ title: "#3F3F46", glass: TEAL, titleH: 18, padY: 14, padX: 12, scale: 0.6 }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT, titleH: 18, padY: 14, padX: 12, scale: 0.6 }),
  ...marks(),
)
