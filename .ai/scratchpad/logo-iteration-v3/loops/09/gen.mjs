import { heritageLockup } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const word = (ink, echo, echoFill) =>
  heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(
    /<\/?svg[^>]*>/g,
    "",
  )
const lock = (ink, echo, echoFill, block) => `
  ${word(ink, echo, echoFill)}
  <path fill="${block}" d="M174 26h20l10 10v50h-30z"/>
`

write(root + "a-color-dark.svg", wrap(212, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "a-color-light.svg", wrap(212, 112, lock("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "a-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

write(root + "b-mono-dark.svg", wrap(212, 112, lock("#F4F4F5", 4.864, "#A1A1AA", "#F4F4F5")))
write(root + "b-mono-light.svg", wrap(212, 112, lock("#09090B", 4.864, "#71717A", "#09090B")))
write(root + "b-mark.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<path fill="#F4F4F5" d="M3 3h8l2 2v8H3z"/>`))

write(root + "c-ink-block-dark.svg", wrap(212, 112, lock("#40E0D0", 4.864, "#F4F4F5", "#F4F4F5")))
write(root + "c-ink-block-light.svg", wrap(212, 112, lock("#0F766E", 4.864, "#09090B", "#09090B")))
write(root + "c-mark.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

write(root + "d-darker-light.svg", wrap(212, 112, lock("#09090B", 3, "#115E59", "#115E59")))
write(root + "d-darker-dark.svg", wrap(212, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "d-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))
