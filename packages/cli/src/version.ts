import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export const packageVersion: string = require("../package.json").version
