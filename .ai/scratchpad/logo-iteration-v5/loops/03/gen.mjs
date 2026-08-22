import {
  terminal,
  markWindow,
  mark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../term.mjs"
import { family } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const CELL = 4.864

function knockMarks(screen) {
  return [
    markWindow({ frame: INK_DARK, screen, pipe: "#09090B", title: true }),
    markWindow({ frame: INK_DARK, screen: INK_DARK, pipe: INK_DARK, title: true }),
    mark16({ frame: INK_DARK, pipe: screen, screen }),
  ]
}

// A craft knockout — taller quiet title, tuned frame
family(
  root,
  "a",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: TEAL,
    pipe: TEAL,
    titleBar: 14,
    bezel: 2.5,
    pad: 14,
    scale: 0.58,
    screenCut: true,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: TEAL_LIGHT,
    pipe: TEAL_LIGHT,
    titleBar: 14,
    bezel: 2.5,
    pad: 14,
    scale: 0.58,
    screenCut: true,
  }),
  ...knockMarks(TEAL),
)

// B raised — ink ctx| sitting ON the teal glass (not cut)
family(
  root,
  "b",
  terminal({
    ink: "#09090B",
    frame: INK_DARK,
    screen: TEAL,
    pipe: "#09090B",
    titleBar: 14,
    bezel: 2.5,
    pad: 14,
    scale: 0.58,
  }),
  terminal({
    ink: "#F4F4F5",
    frame: INK_LIGHT,
    screen: TEAL_LIGHT,
    pipe: "#F4F4F5",
    titleBar: 14,
    bezel: 2.5,
    pad: 14,
    scale: 0.58,
  }),
  ...knockMarks(TEAL),
)

// C echo-cut — knockout + darker teal trail
family(
  root,
  "c",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: TEAL,
    pipe: TEAL,
    titleBar: 14,
    bezel: 2.5,
    pad: 16,
    scale: 0.54,
    screenCut: true,
    echoes: [
      { dx: CELL * 2, dy: 0, fill: "#0F766E" },
      { dx: CELL, dy: 0, fill: "#14B8A6" },
    ],
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: TEAL_LIGHT,
    pipe: TEAL_LIGHT,
    titleBar: 14,
    bezel: 2.5,
    pad: 16,
    scale: 0.54,
    screenCut: true,
    echoes: [
      { dx: CELL * 2, dy: 0, fill: "#99F6E4" },
      { dx: CELL, dy: 0, fill: "#5EEAD4" },
    ],
  }),
  ...knockMarks(TEAL),
)

// D deep glass — more inset, clearer title slab
family(
  root,
  "d",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: TEAL,
    pipe: TEAL,
    titleBar: 16,
    bezel: 3,
    pad: 18,
    scale: 0.5,
    screenCut: true,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: TEAL_LIGHT,
    pipe: TEAL_LIGHT,
    titleBar: 16,
    bezel: 3,
    pad: 18,
    scale: 0.5,
    screenCut: true,
  }),
  ...knockMarks(TEAL),
)
