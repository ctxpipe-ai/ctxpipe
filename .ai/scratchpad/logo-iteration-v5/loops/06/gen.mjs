import { slabLockup, markWindow, mark16, TEAL, TEAL_LIGHT, INK_DARK } from "../../term.mjs"
import { family } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const slab = { titleH: 20, padY: 18, scale: 0.58 }

function marks(screen) {
  return [
    markWindow({ frame: INK_DARK, screen, pipe: "#09090B", title: true }),
    markWindow({ frame: INK_DARK, screen: INK_DARK, pipe: INK_DARK, title: true }),
    mark16({ frame: INK_DARK, pipe: screen, screen }),
  ]
}

family(
  root,
  "a",
  slabLockup({ title: "#3F3F46", glass: TEAL, ...slab }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT, ...slab }),
  ...marks(TEAL),
)
family(
  root,
  "b",
  slabLockup({ title: "#52525B", glass: "#A1A1AA", ...slab }),
  slabLockup({ title: "#D4D4D8", glass: "#3F3F46", ...slab }),
  ...marks("#A1A1AA"),
)
family(
  root,
  "c",
  slabLockup({ title: TEAL, glass: "#27272A", ...slab }),
  slabLockup({ title: TEAL_LIGHT, glass: "#E4E4E7", ...slab }),
  ...marks(TEAL),
)
family(
  root,
  "d",
  slabLockup({ title: "#27272A", glass: "#0F766E", ...slab }),
  slabLockup({ title: "#A1A1AA", glass: "#115E59", ...slab }),
  ...marks("#0F766E"),
)
