import { heritageLockup, heritageMark, heritageMark16, LETTERS } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname

write(
  root + "a-heritage-dark.svg",
  heritageLockup({ ink: "#F4F4F5", pipe: "#40E0D0" }),
)
write(
  root + "a-heritage-light.svg",
  heritageLockup({ ink: "#09090B", pipe: "#0F766E" }),
)
write(root + "a-mark.svg", heritageMark({ fill: "#40E0D0", w: 10 }))
write(root + "a-mark-mono.svg", heritageMark({ fill: "#F4F4F5", w: 10 }))
write(root + "a-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 4 }))

write(
  root + "b-cursor-dark.svg",
  heritageLockup({ ink: "#F4F4F5", pipe: "#40E0D0", pipeW: 22, pipeX: 176 }),
)
write(
  root + "b-cursor-light.svg",
  heritageLockup({ ink: "#09090B", pipe: "#0F766E", pipeW: 22, pipeX: 176 }),
)
write(root + "b-mark.svg", heritageMark({ fill: "#40E0D0", w: 18 }))
write(root + "b-mark-mono.svg", heritageMark({ fill: "#F4F4F5", w: 18 }))
write(root + "b-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 6 }))

const stampInner = (ink, pipe) => `
  <rect x="4" y="4" width="248" height="88" fill="none" stroke="${ink}" stroke-width="3"/>
  <rect x="4" y="4" width="8" height="88" fill="${pipe}"/>
  <g transform="translate(22, -8) scale(0.92)">${heritageLockup({ ink, pipe }).replace(/<\/?svg[^>]*>/g, "")}</g>
`
write(root + "c-stamp-dark.svg", wrap(256, 96, stampInner("#F4F4F5", "#40E0D0")))
write(root + "c-stamp-light.svg", wrap(256, 96, stampInner("#09090B", "#0F766E")))
write(
  root + "c-mark.svg",
  wrap(
    64,
    64,
    `<rect x="6" y="6" width="52" height="52" fill="none" stroke="#40E0D0" stroke-width="4"/><rect x="18" y="14" width="10" height="36" fill="#F4F4F5"/>`,
  ),
)
write(
  root + "c-mark-mono.svg",
  wrap(
    64,
    64,
    `<rect x="6" y="6" width="52" height="52" fill="none" stroke="#F4F4F5" stroke-width="4"/><rect x="18" y="14" width="10" height="36" fill="#F4F4F5"/>`,
  ),
)
write(
  root + "c-mark16.svg",
  wrap(
    16,
    16,
    `<rect x="1" y="1" width="14" height="14" fill="none" stroke="#40E0D0" stroke-width="2"/><rect x="6" y="3" width="3" height="10" fill="#F4F4F5"/>`,
  ),
)

write(
  root + "d-echo-dark.svg",
  heritageLockup({
    ink: "#F4F4F5",
    pipe: "#40E0D0",
    echo: 4.864,
    echoFill: "#40E0D0",
  }),
)
write(
  root + "d-echo-light.svg",
  heritageLockup({
    ink: "#09090B",
    pipe: "#0F766E",
    echo: 4.864,
    echoFill: "#0F766E",
  }),
)
write(
  root + "d-mark.svg",
  wrap(
    64,
    64,
    `<rect x="22" y="8" width="10" height="44" fill="#40E0D0"/><rect x="28" y="12" width="10" height="44" fill="#F4F4F5"/>`,
  ),
)
write(
  root + "d-mark-mono.svg",
  wrap(
    64,
    64,
    `<rect x="22" y="8" width="10" height="44" fill="#A1A1AA"/><rect x="28" y="12" width="10" height="44" fill="#F4F4F5"/>`,
  ),
)
write(root + "d-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 5 }))

void LETTERS
