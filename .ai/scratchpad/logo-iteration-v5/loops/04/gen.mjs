import {
  terminal,
  titleNameLockup,
  slabLockup,
  squareKnock,
  markWindow,
  mark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../term.mjs"
import { family } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname

function marks(screen) {
  return [
    markWindow({ frame: INK_DARK, screen, pipe: "#09090B", title: true }),
    markWindow({ frame: INK_DARK, screen: INK_DARK, pipe: INK_DARK, title: true }),
    mark16({ frame: INK_DARK, pipe: screen, screen }),
  ]
}

// A square tile — app-icon knockout
family(
  root,
  "a",
  squareKnock({ frame: INK_DARK, glass: TEAL }),
  squareKnock({ frame: INK_LIGHT, glass: TEAL_LIGHT }),
  ...marks(TEAL),
)

// B name in chrome — ctx| lives in the title bar; glass is a cursor
family(
  root,
  "b",
  titleNameLockup({ frame: INK_DARK, glass: TEAL, cursor: "#09090B" }),
  titleNameLockup({ frame: INK_LIGHT, glass: TEAL_LIGHT, cursor: "#09090B" }),
  ...marks(TEAL),
)

// C slab — no hairline; zinc title + teal body cut
family(
  root,
  "c",
  slabLockup({ title: "#3F3F46", glass: TEAL }),
  slabLockup({ title: "#D4D4D8", glass: TEAL_LIGHT }),
  ...marks(TEAL),
)

// D wide banner — cinematic knockout (basis craft, wider pad)
family(
  root,
  "d",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: TEAL,
    pipe: TEAL,
    titleBar: 14,
    bezel: 2.5,
    pad: 22,
    scale: 0.62,
    screenCut: true,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: TEAL_LIGHT,
    pipe: TEAL_LIGHT,
    titleBar: 14,
    bezel: 2.5,
    pad: 22,
    scale: 0.62,
    screenCut: true,
  }),
  ...marks(TEAL),
)
