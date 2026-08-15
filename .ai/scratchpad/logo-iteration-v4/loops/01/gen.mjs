import {
  CELL,
  lockup,
  barsMark,
  barsMark16,
  plateMark,
  plateMark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../echo.mjs"
import { write } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const C = CELL

function family(letter, dark, light, m64, m64mono, m16) {
  write(root + `${letter}-dark.svg`, dark)
  write(root + `${letter}-light.svg`, light)
  write(root + `${letter}-mark.svg`, m64)
  write(root + `${letter}-mark-mono.svg`, m64mono)
  write(root + `${letter}-mark16.svg`, m16)
}

// A solid register — 1-cell SE, no mush, pipe echoed, canvas open
family(
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [{ dx: C, dy: C, fill: TEAL }],
    pipeEchoes: [{ dx: C, dy: C, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [{ dx: C, dy: C, fill: TEAL_LIGHT }],
    pipeEchoes: [{ dx: C, dy: C, fill: "#99F6E4" }],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 6, stepY: 6 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 6, stepY: 6 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)

// B trail — three fading afterimages
family(
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: C * 3, dy: C * 3, fill: TEAL, opacity: 0.22 },
      { dx: C * 2, dy: C * 2, fill: TEAL, opacity: 0.4 },
      { dx: C, dy: C, fill: TEAL, opacity: 0.7 },
    ],
    pipeEchoes: [
      { dx: C * 3, dy: C * 3, fill: TEAL, opacity: 0.22 },
      { dx: C * 2, dy: C * 2, fill: TEAL, opacity: 0.4 },
      { dx: C, dy: C, fill: TEAL, opacity: 0.7 },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: C * 3, dy: C * 3, fill: TEAL_LIGHT, opacity: 0.2 },
      { dx: C * 2, dy: C * 2, fill: TEAL_LIGHT, opacity: 0.38 },
      { dx: C, dy: C, fill: TEAL_LIGHT, opacity: 0.65 },
    ],
    pipeEchoes: [
      { dx: C * 3, dy: C * 3, fill: TEAL_LIGHT, opacity: 0.2 },
      { dx: C * 2, dy: C * 2, fill: TEAL_LIGHT, opacity: 0.38 },
      { dx: C, dy: C, fill: TEAL_LIGHT, opacity: 0.65 },
    ],
  }),
  barsMark({
    fills: [TEAL, TEAL, TEAL, INK_DARK],
    opacities: [0.25, 0.45, 0.7, 1],
    stepX: 5,
    stepY: 4,
    barW: 8,
  }),
  barsMark({
    fills: ["#A1A1AA", "#A1A1AA", "#A1A1AA", INK_DARK],
    opacities: [0.25, 0.45, 0.7, 1],
    stepX: 5,
    stepY: 4,
    barW: 8,
  }),
  barsMark16({
    fills: [TEAL, TEAL, INK_DARK],
    opacities: [0.35, 0.7, 1],
    stepX: 2,
    barW: 3,
  }),
)

// C east register — print misregister, X only
family(
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [{ dx: C * 2, dy: 0, fill: TEAL }],
    pipeEchoes: [{ dx: C * 2, dy: 0, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [{ dx: C * 2, dy: 0, fill: TEAL_LIGHT }],
    pipeEchoes: [{ dx: C * 2, dy: 0, fill: "#99F6E4" }],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 8, stepY: 0 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 8, stepY: 0 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 4 }),
)

// D knockout field — teal plate, letters cut, ghost offset
family(
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [{ dx: C, dy: C, fill: "#2A9B94" }],
    field: { fill: TEAL, x: -4, y: 12, w: 178, h: 90 },
    cutLettersFromField: true,
    hideLetters: true,
    pipeEchoes: [{ dx: C, dy: C, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [{ dx: C, dy: C, fill: "#99F6E4" }],
    field: { fill: TEAL_LIGHT, x: -4, y: 12, w: 178, h: 90 },
    cutLettersFromField: true,
    hideLetters: true,
    pipeEchoes: [{ dx: C, dy: C, fill: "#99F6E4" }],
  }),
  plateMark({ fill: TEAL, ghost: "#2A9B94", cut: "#09090B" }),
  plateMark({ fill: INK_DARK, ghost: "#71717A", cut: "#09090B" }),
  plateMark16({ fill: TEAL, ghost: "#2A9B94", cut: "#09090B" }),
)
