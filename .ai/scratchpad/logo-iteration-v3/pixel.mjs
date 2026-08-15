/** Shipped `apps/ui/public/ctx_.svg` geometry, reusable. */

export const LETTERS =
  "M4.86399 87.552V77.824H-1.33514e-05V48.64H4.86399V38.912H9.72799V34.048H14.592V29.184H43.776V34.048H48.64V38.912H53.504V43.776H58.368V53.504H48.64V48.64H43.776V43.776H38.912V38.912H19.456V43.776H14.592V48.64H9.72799V77.824H14.592V82.688H19.456V87.552H38.912V82.688H43.776V77.824H48.64V72.96H58.368V82.688H53.504V87.552H48.64V92.416H43.776V97.28H14.592V92.416H9.72799V87.552H4.86399ZM77.853 87.552V38.912H68.125V29.184H77.853V14.592H87.581V29.184H107.037V38.912H87.581V87.552H107.037V97.28H87.581V92.416H82.717V87.552H77.853ZM116.75 97.28V82.688H121.614V77.824H126.478V72.96H131.342V68.096H136.206V58.368H131.342V53.504H126.478V48.64H121.614V43.776H116.75V29.184H126.478V38.912H131.342V43.776H136.206V48.64H141.07V58.368H145.934V48.64H150.798V43.776H155.662V38.912H160.526V29.184H170.254V43.776H165.39V48.64H160.526V53.504H155.662V58.368H150.798V68.096H155.662V72.96H160.526V77.824H165.39V82.688H170.254V97.28H160.526V87.552H155.662V77.824H145.934V68.096H141.07V77.824H131.342V87.552H126.478V97.28H116.75Z"

export function heritageLockup({
  ink = "#F4F4F5",
  pipe = "#40E0D0",
  pipeW = 9.728,
  pipeX = 184.864,
  pipeY0 = 0,
  pipeY1 = 111.872,
  echo = 0,
  echoFill = "#40E0D0",
} = {}) {
  const echoPath =
    echo === 0
      ? ""
      : `<g transform="translate(${echo} ${echo})" fill="${echoFill}" opacity="0.85"><path d="${LETTERS}"/></g>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="195" height="112" viewBox="0 0 195 112" fill="none">
  ${echoPath}
  <path fill="${ink}" d="${LETTERS}"/>
  <rect x="${pipeX}" y="${pipeY0}" width="${pipeW}" height="${pipeY1 - pipeY0}" fill="${pipe}"/>
</svg>
`
}

export function heritageMark({ fill = "#40E0D0", w = 10, size = 64 } = {}) {
  const x = (size - w) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
  <rect x="${x}" y="4" width="${w}" height="${size - 8}" fill="${fill}"/>
</svg>
`
}

export function heritageMark16({ fill = "#40E0D0", w = 4 } = {}) {
  const x = Math.round((16 - w) / 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" shape-rendering="crispEdges">
  <rect x="${x}" y="1" width="${w}" height="14" fill="${fill}"/>
</svg>
`
}
