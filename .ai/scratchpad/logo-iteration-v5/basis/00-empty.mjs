import { emptyTerminal, INK_DARK, INK_LIGHT, TEAL, TEAL_LIGHT } from "../term.mjs"
import { write } from "../write.mjs"

const root = new URL(".", import.meta.url).pathname
write(root + "lockup-dark.svg", emptyTerminal({ frame: INK_DARK, screen: "#18181B", pipe: TEAL }))
write(root + "lockup-light.svg", emptyTerminal({ frame: INK_LIGHT, screen: "#E4E4E7", pipe: TEAL_LIGHT }))
