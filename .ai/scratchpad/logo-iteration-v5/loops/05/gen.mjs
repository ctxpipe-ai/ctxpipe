import {
  slabLockup,
  markWindow,
  mark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
} from "../../term.mjs"
import { family } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const CELL = 4.864

function marks(screen) {
  return [
    markWindow({ frame: INK_DARK, screen, pipe: "#09090B", title: true }),
    markWindow({ frame: INK_DARK, screen: INK_DARK, pipe: INK_DARK, title: true }),
    mark16({ frame: INK_DARK, pipe: screen, screen }),
  ]
}

// A craft slab — thicker zinc, more glass above letters
family(
  root,
  "a",
  slabLockup({ title: "#3F3F46", glass: TEAL, titleH: 20, padY: 18, scale: 0.58 }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT, titleH: 20, padY: 18, scale: 0.58 }),
  ...marks(TEAL),
)

// B echo-cut on the slab
family(
  root,
  "b",
  slabLockup({
    title: "#3F3F46",
    glass: TEAL,
    titleH: 20,
    padY: 18,
    padX: 18,
    scale: 0.54,
    echoes: [
      { dx: CELL * 2, dy: 0, fill: "#0F766E" },
      { dx: CELL, dy: 0, fill: "#14B8A6" },
    ],
  }),
  slabLockup({
    title: "#D4D4D8",
    glass: TEAL_LIGHT,
    titleH: 20,
    padY: 18,
    padX: 18,
    scale: 0.54,
    echoes: [
      { dx: CELL * 2, dy: 0, fill: "#99F6E4" },
      { dx: CELL, dy: 0, fill: "#5EEAD4" },
    ],
  }),
  ...marks(TEAL),
)

// C title tick on the zinc
family(
  root,
  "c",
  slabLockup({ title: "#3F3F46", glass: TEAL, titleH: 20, padY: 18, titleTick: true }),
  slabLockup({ title: "#A1A1AA", glass: TEAL_LIGHT, titleH: 20, padY: 18, titleTick: true }),
  ...marks(TEAL),
)

// D raised ink on teal glass (not cut)
family(
  root,
  "d",
  slabLockup({ title: "#3F3F46", glass: TEAL, titleH: 20, padY: 18, raisedInk: "#09090B" }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT, titleH: 20, padY: 18, raisedInk: "#F4F4F5" }),
  ...marks(TEAL),
)
