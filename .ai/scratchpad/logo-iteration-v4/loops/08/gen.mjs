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

const three = (far, mid, near) => [
  { dx: far, dy: 0, fill: "#1A6B66" },
  { dx: mid, dy: 0, fill: "#2A9B94" },
  { dx: near, dy: 0, fill: TEAL },
]
const threeL = (far, mid, near) => [
  { dx: far, dy: 0, fill: "#CCFBF1" },
  { dx: mid, dy: 0, fill: "#5EEAD4" },
  { dx: near, dy: 0, fill: TEAL_LIGHT },
]

// Basis: L7A three step (1c / 2c / 3c).

// A tighter three
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: three(C * 2, C * 1.25, C * 0.6),
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: threeL(C * 2, C * 1.25, C * 0.6),
  }),
  barsMark({ fills: ["#1A6B66", "#2A9B94", TEAL, INK_DARK], stepX: 4, stepY: 0, barW: 7 }),
  barsMark({ fills: ["#52525B", "#71717A", "#A1A1AA", INK_DARK], stepX: 4, stepY: 0, barW: 7 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 2, barW: 3 }),
)

// B three + fat pipe (absorb L7C)
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: three(C * 3, C * 2, C),
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: threeL(C * 3, C * 2, C),
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 6, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 6, stepY: 0, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5, stepX: 3 }),
)

// C three, no pipe — the trail is the cursor
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: "none",
    pipeW: 0,
    letterEchoes: three(C * 3, C * 2, C),
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: "none",
    pipeW: 0,
    letterEchoes: threeL(C * 3, C * 2, C),
  }),
  barsMark({ fills: ["#1A6B66", "#2A9B94", TEAL], stepX: 5, stepY: 0, barW: 8 }),
  barsMark({ fills: ["#52525B", "#71717A", "#A1A1AA"], stepX: 5, stepY: 0, barW: 8 }),
  barsMark16({ fills: [TEAL, "#2A9B94"], stepX: 3 }),
)

// D three + tall pipe
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeH: 128,
    pipeY: -8,
    letterEchoes: three(C * 3, C * 2, C),
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeH: 128,
    pipeY: -8,
    letterEchoes: threeL(C * 3, C * 2, C),
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 6, stepY: 0, barW: 10 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 6, stepY: 0, barW: 10 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)
