import { delimiter, isAbsolute, sep } from "node:path"

// Keeps only the absolute PATH directories outside node_modules. The merge
// gate manifest step starts commands (`git`, `pnpm --version`) after the
// install, and a dependency bin must not take their place.
export function restrictPath(env = process.env) {
  env.PATH = (env.PATH ?? "")
    .split(delimiter)
    .filter(
      (entry) =>
        isAbsolute(entry) &&
        !`${entry}${sep}`.includes(`${sep}node_modules${sep}`),
    )
    .join(delimiter)
}
