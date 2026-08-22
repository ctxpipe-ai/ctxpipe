import { heritageLockup, LETTERS } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const cOnly = LETTERS.split("ZM")[0] + "Z"
const word = (ink, echo, echoFill) =>
  heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(
    /<\/?svg[^>]*>/g,
    "",
  )

const stack = (ink, echo, echoFill, block) => `
  <g transform="translate(20,0) scale(0.85)">${word(ink, echo, echoFill)}</g>
  <path fill="${block}" d="M72 88h48l16 0v16H72z"/>
`
write(root + "a-stack-dark.svg", wrap(200, 112, stack("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "a-stack-light.svg", wrap(200, 112, stack("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "a-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

write(
  root + "b-all-teal-dark.svg",
  wrap(212, 112, `${word("#40E0D0", 4.864, "#F4F4F5")}<path fill="#40E0D0" d="M176 28h20l8 8v40h-28z"/>`),
)
write(
  root + "b-all-teal-light.svg",
  wrap(212, 112, `${word("#0F766E", 4.864, "#09090B")}<path fill="#0F766E" d="M176 28h20l8 8v40h-28z"/>`),
)
write(root + "b-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

const stair = (ink, echo, echoFill, block) => `
  ${word(ink, echo, echoFill)}
  <path fill="${block}" d="M176 28h12v8h8v8h8v40h-28z"/>
`
write(root + "c-stair-dark.svg", wrap(212, 112, stair("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "c-stair-light.svg", wrap(212, 112, stair("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "c-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h12v8h8v8h8v24H16z"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h12v8h8v8h8v24H16z"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h4v3h3v3h3v7H3z"/>`))

const combo = (ink, echo, echoFill, block) => `
  <g transform="translate(2,16) scale(0.65)" fill="${ink}"><path d="${cOnly}"/></g>
  <g transform="translate(68,0)">${word(ink, echo, echoFill)}</g>
  <path fill="${block}" d="M244 28h20l8 8v40h-28z"/>
`
write(root + "d-combo-dark.svg", wrap(280, 112, combo("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "d-combo-light.svg", wrap(280, 112, combo("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "d-mark.svg", wrap(64, 64, `<g transform="translate(2,6) scale(0.5)" fill="#F4F4F5"><path d="${cOnly}"/></g><path fill="#40E0D0" d="M40 16h12l8 8v24H40z"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<g transform="translate(2,6) scale(0.5)" fill="#F4F4F5"><path d="${cOnly}"/></g><path fill="#F4F4F5" d="M40 16h12l8 8v24H40z"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))
