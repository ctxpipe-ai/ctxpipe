#!/usr/bin/env node
// discover-roots <source checkout>: write the roots of the checkout as JSON
// that matches ../schema.json. The script reads only tracked files at HEAD.
import { discoverRoots } from "./roots-lib.mjs"

const source = process.argv[2] || "."
process.stdout.write(`${JSON.stringify(discoverRoots(source))}\n`)
