import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export const packageVersion: string = require("../package.json").version

/**
 * The command prefix that generated hooks and instructions use. It pins the
 * CLI to the version that wrote them, so a new release does not run in a repo
 * until a user runs `memory init` again.
 */
export const pinnedCli = `npx -y ctxpipe@${packageVersion}`
