/** Shipped pixel `ctx` + echo lockup factory. Letters stay the product paths. */

export const CELL = 4.864
export const LETTERS =
  "M4.86399 87.552V77.824H-1.33514e-05V48.64H4.86399V38.912H9.72799V34.048H14.592V29.184H43.776V34.048H48.64V38.912H53.504V43.776H58.368V53.504H48.64V48.64H43.776V43.776H38.912V38.912H19.456V43.776H14.592V48.64H9.72799V77.824H14.592V82.688H19.456V87.552H38.912V82.688H43.776V77.824H48.64V72.96H58.368V82.688H53.504V87.552H48.64V92.416H43.776V97.28H14.592V92.416H9.72799V87.552H4.86399ZM77.853 87.552V38.912H68.125V29.184H77.853V14.592H87.581V29.184H107.037V38.912H87.581V87.552H107.037V97.28H87.581V92.416H82.717V87.552H77.853ZM116.75 97.28V82.688H121.614V77.824H126.478V72.96H131.342V68.096H136.206V58.368H131.342V53.504H126.478V48.64H121.614V43.776H116.75V29.184H126.478V38.912H131.342V43.776H136.206V48.64H141.07V58.368H145.934V48.64H150.798V43.776H155.662V38.912H160.526V29.184H170.254V43.776H165.39V48.64H160.526V53.504H155.662V58.368H150.798V68.096H155.662V72.96H160.526V77.824H165.39V82.688H170.254V97.28H160.526V87.552H155.662V77.824H145.934V68.096H141.07V77.824H131.342V87.552H126.478V97.28H116.75Z"

const LETTER_MAX_X = 170.254
const PIPE_W0 = 9.728
const PIPE_H0 = 111.872
const PIPE_X0 = 184.864

export const TEAL = "#40E0D0"
export const TEAL_LIGHT = "#0F766E"
export const INK_DARK = "#F4F4F5"
export const INK_LIGHT = "#09090B"

export function lockup({
  ink = INK_DARK,
  pipe = TEAL,
  letterEchoes = [],
  pipeEchoes = [],
  pipeW = PIPE_W0,
  pipeH = PIPE_H0,
  pipeX = PIPE_X0,
  pipeY = 0,
  field = null,
  cutLettersFromField = false,
  hideLetters = false,
  extra = "",
  pad = 8,
} = {}) {
  const echoDx = letterEchoes.map((e) => e.dx ?? 0)
  const echoDy = letterEchoes.map((e) => e.dy ?? 0)
  const pipeEchoDx = pipeEchoes.map((e) => e.dx ?? 0)
  const pipeEchoDy = pipeEchoes.map((e) => e.dy ?? 0)
  const minX = Math.min(0, ...echoDx, pipeX, ...pipeEchoDx.map((d) => pipeX + d)) - pad
  const minY = Math.min(0, ...echoDy, pipeY, ...pipeEchoDy.map((d) => pipeY + d)) - pad
  const maxX =
    Math.max(
      LETTER_MAX_X,
      ...echoDx.map((d) => LETTER_MAX_X + d),
      pipeX + pipeW,
      ...pipeEchoDx.map((d) => pipeX + pipeW + d),
    ) + pad
  const maxY =
    Math.max(
      PIPE_H0,
      ...echoDy.map((d) => PIPE_H0 + d),
      pipeY + pipeH,
      ...pipeEchoDy.map((d) => pipeY + pipeH + d),
    ) + pad
  const w = maxX - minX
  const h = maxY - minY

  const letterEchoMarkup = letterEchoes
    .map((e) => {
      const op = e.opacity == null ? "" : ` opacity="${e.opacity}"`
      return `<g transform="translate(${e.dx ?? 0} ${e.dy ?? 0})" fill="${e.fill}"${op}><path d="${LETTERS}"/></g>`
    })
    .join("\n  ")

  const pipeEchoMarkup = pipeEchoes
    .map((e) => {
      const op = e.opacity == null ? "" : ` opacity="${e.opacity}"`
      return `<rect x="${pipeX + (e.dx ?? 0)}" y="${pipeY + (e.dy ?? 0)}" width="${pipeW}" height="${pipeH}" fill="${e.fill}"${op}/>`
    })
    .join("\n  ")

  let fieldMarkup = ""
  if (field) {
    const fx = field.x ?? 0
    const fy = field.y ?? 14
    const fw = field.w ?? LETTER_MAX_X + 8
    const fh = field.h ?? 88
    if (cutLettersFromField) {
      fieldMarkup = `<defs><mask id="cut"><rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="#fff"/><path d="${LETTERS}" fill="#000"/></mask></defs>
  <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="${field.fill}" mask="url(#cut)"/>`
    } else {
      fieldMarkup = `<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="${field.fill}"/>`
    }
  }

  const letters = hideLetters ? "" : `<path fill="${ink}" d="${LETTERS}"/>`
  const pipeRect = `<rect x="${pipeX}" y="${pipeY}" width="${pipeW}" height="${pipeH}" fill="${pipe}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(2)}" height="${h.toFixed(2)}" viewBox="${minX.toFixed(2)} ${minY.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}" fill="none">
  ${fieldMarkup}
  ${letterEchoMarkup}
  ${letters}
  ${pipeEchoMarkup}
  ${pipeRect}
  ${extra}
</svg>
`
}

export function crudeEcho({ ink, pipe, echoFill }) {
  return lockup({
    ink,
    pipe,
    letterEchoes: [{ dx: CELL, dy: CELL, fill: echoFill, opacity: 0.85 }],
    pad: 0,
  })
}

export function barsMark({
  fills,
  size = 64,
  barW = 10,
  gap = 6,
  stepX = 6,
  stepY = 4,
  opacities,
} = {}) {
  const n = fills.length
  const totalW = barW + (n - 1) * stepX
  const x0 = (size - totalW) / 2
  const h = size - 16
  const y0 = 8
  const rects = fills
    .map((fill, i) => {
      const op = opacities?.[i] == null ? "" : ` opacity="${opacities[i]}"`
      return `<rect x="${x0 + i * stepX}" y="${y0 + i * stepY}" width="${barW}" height="${h - i * stepY}" fill="${fill}"${op}/>`
    })
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">${rects}</svg>\n`
}

export function plateMark({ fill = TEAL, ghost = "#2A9B94", size = 64, cut = "#09090B" } = {}) {
  const s = size
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" fill="none">
  <rect x="8" y="8" width="48" height="48" fill="${fill}"/>
  <rect x="14" y="18" width="22" height="28" fill="${cut}"/>
  <rect x="18" y="22" width="22" height="28" fill="${ghost}"/>
</svg>
`
}

export function plateMark16({ fill = TEAL, ghost = "#2A9B94", cut = "#09090B" } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" shape-rendering="crispEdges">
  <rect x="1" y="1" width="14" height="14" fill="${fill}"/>
  <rect x="3" y="4" width="6" height="8" fill="${cut}"/>
  <rect x="5" y="5" width="6" height="8" fill="${ghost}"/>
</svg>
`
}

export function barsMark16({ fills, opacities, barW = 4, stepX = 3 } = {}) {
  const n = fills.length
  const totalW = barW + (n - 1) * stepX
  const x0 = Math.round((16 - totalW) / 2)
  const rects = fills
    .map((fill, i) => {
      const op = opacities?.[i] == null ? "" : ` opacity="${opacities[i]}"`
      return `<rect x="${x0 + i * stepX}" y="${2 + i}" width="${barW}" height="${12 - i}" fill="${fill}"${op}/>`
    })
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" shape-rendering="crispEdges">${rects}</svg>\n`
}
