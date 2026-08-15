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

// Basis: L4B clean pipe (east+south on letters, one solid pipe).

// A heavy east — 3c east, 1c south
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C, fill: "#2A9B94" },
      { dx: C * 3, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C, fill: "#5EEAD4" },
      { dx: C * 3, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 10, stepY: 0 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 10, stepY: 0 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 4 }),
)

// B x-only — echo lives on the last letter, next to the pipe
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C * 2, dy: 0, fill: TEAL },
    ],
    echoClip: { x: 112, y: 0, w: 80, h: 120 },
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C * 2, dy: 0, fill: TEAL_LIGHT },
    ],
    echoClip: { x: 112, y: 0, w: 80, h: 120 },
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 6, stepY: 6 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 6, stepY: 6 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)

// C south-heavy — 2c south, 1c east
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 0, stepY: 6, barW: 10 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 0, stepY: 6, barW: 10 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 0 }),
)

// D stacked — ctx with split above a teal pipe bar (flag / prompt line)
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 178,
    pipeH: 10,
    pipeX: 0,
    pipeY: 104,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C * 2, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 178,
    pipeH: 10,
    pipeX: 0,
    pipeY: 104,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C * 2, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: [TEAL], barW: 40, stepX: 0, stepY: 0 }),
  barsMark({ fills: [INK_DARK], barW: 40, stepX: 0, stepY: 0 }),
  barsMark16({ fills: [TEAL], barW: 12, stepX: 0 }),
)
