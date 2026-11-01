import { known } from "./known.mjs"

process.stdout.write(known())
if (process.argv.includes("--wait")) setInterval(() => {}, 1000)
