import { crudeEcho, TEAL, TEAL_LIGHT, INK_DARK, INK_LIGHT } from "../echo.mjs"
import { write } from "../write.mjs"

const root = new URL(".", import.meta.url).pathname
write(root + "lockup-dark.svg", crudeEcho({ ink: INK_DARK, pipe: TEAL, echoFill: TEAL }))
write(root + "lockup-light.svg", crudeEcho({ ink: INK_LIGHT, pipe: TEAL_LIGHT, echoFill: TEAL_LIGHT }))
