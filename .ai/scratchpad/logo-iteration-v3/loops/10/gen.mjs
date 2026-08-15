import { heritageLockup } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const word = (ink, echo, echoFill) =>
  heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(
    /<\/?svg[^>]*>/g,
    "",
  )
const lock = (ink, echo, echoFill, block, cut = 10) => `
  ${word(ink, echo, echoFill)}
  <path fill="${block}" d="M172 24h${32 - cut}l${cut} ${cut}v${64 - cut}h-32z"/>
`

write(root + "a-ref-dark.svg", wrap(212, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", 10)))
write(root + "a-ref-light.svg", wrap(212, 112, lock("#09090B", 3.2, "#0F766E", "#0F766E", 10)))
write(root + "a-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M14 14h26l10 10v26H14z"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M14 14h26l10 10v26H14z"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M2 2h9l3 3v9H2z"/>`))

write(root + "b-heavy-dark.svg", wrap(216, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", 6)))
write(root + "b-heavy-light.svg", wrap(216, 112, lock("#09090B", 3.2, "#0F766E", "#0F766E", 6)))
write(root + "b-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M14 14h30l6 6v30H14z"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M14 14h30l6 6v30H14z"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M2 2h11l1 1v11H2z"/>`))

write(root + "c-sharp-dark.svg", wrap(212, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", 16)))
write(root + "c-sharp-light.svg", wrap(212, 112, lock("#09090B", 3.2, "#0F766E", "#0F766E", 16)))
write(root + "c-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M14 14h18l18 18v18H14z"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M14 14h18l18 18v18H14z"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M2 2h7l5 5v7H2z"/>`))

write(root + "d-quiet-echo-dark.svg", wrap(212, 112, lock("#F4F4F5", 2.4, "#40E0D0", "#40E0D0", 10)))
write(root + "d-quiet-echo-light.svg", wrap(212, 112, lock("#09090B", 2, "#0F766E", "#0F766E", 10)))
write(root + "d-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M14 14h26l10 10v26H14z"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M14 14h26l10 10v26H14z"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M2 2h9l3 3v9H2z"/>`))
