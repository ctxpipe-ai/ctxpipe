#!/usr/bin/env node

import { runCli } from "../dist/cli.js"

runCli(process.argv.slice(2)).catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`ctxpipe: ${message}`)
  process.exitCode = 1
})
