import {
  CELL,
  lockup,
  barsMark,
  barsMark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../echo.mjs"
import { family } from "../../family.mjs"

const root = new URL(".", import.meta.url).pathname
const C = CELL

// Basis: L5A heavy east (3c east + 1c south, clean pipe).

// A east only — commit to one direction
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [{ dx: C * 3, dy: 0, fill: TEAL }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [{ dx: C * 3, dy: 0, fill: TEAL_LIGHT }],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 10, stepY: 0 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 10, stepY: 0 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 4 }),
)

// B pipe joins — same heavy east, pipe gets the east ghost
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C, fill: "#2A9B94" },
      { dx: C * 3, dy: 0, fill: TEAL },
    ],
    pipeEchoes: [{ dx: C * 3, dy: 0, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C, fill: "#5EEAD4" },
      { dx: C * 3, dy: 0, fill: TEAL_LIGHT },
    ],
    pipeEchoes: [{ dx: C * 3, dy: 0, fill: "#99F6E4" }],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 10, stepY: 0 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 10, stepY: 0 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 4 }),
)

// C stepped east — 1.5c + 3c solid (double hit, east only)
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#2A9B94" },
      { dx: C * 1.5, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#99F6E4" },
      { dx: C * 1.5, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 6, stepY: 0, barW: 8 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 6, stepY: 0, barW: 8 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 3 }),
)

// D dock — heavy east, pipe pulled in so the ghost meets the cursor
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeX: 176,
    letterEchoes: [
      { dx: 0, dy: C, fill: "#2A9B94" },
      { dx: C * 3, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeX: 176,
    letterEchoes: [
      { dx: 0, dy: C, fill: "#5EEAD4" },
      { dx: C * 3, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 8, stepY: 0 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 8, stepY: 0 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 3 }),
)
