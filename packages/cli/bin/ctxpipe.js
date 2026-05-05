#!/usr/bin/env node

const args = process.argv.slice(2)
const command = args[0]

function printHelp() {
  console.log(`ctxpipe

Usage:
  ctxpipe init
  ctxpipe doctor
  ctxpipe mcp add --help

This early CLI package reserves the ctxpipe command while the interactive setup
experience is being built.
`)
}

switch (command) {
  case undefined:
  case "-h":
  case "--help":
    printHelp()
    break
  case "init":
    console.log(
      "ctxpipe init is coming soon. For now, see https://docs.ctxpipe.ai/docs/mcp/mcp-docs",
    )
    break
  case "doctor":
    console.log("ctxpipe doctor is coming soon.")
    break
  case "mcp":
    if (args[1] === "add" && (args[2] === "--help" || args[2] === "-h")) {
      console.log("ctxpipe mcp add is coming soon.")
      break
    }
    printHelp()
    process.exitCode = 1
    break
  default:
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exitCode = 1
}
