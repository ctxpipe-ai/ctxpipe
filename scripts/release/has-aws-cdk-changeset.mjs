#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const changesetDir = join(process.cwd(), ".changeset");
const entries = await readdir(changesetDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
  .map((entry) => entry.name);

for (const file of files) {
  const contents = await readFile(join(changesetDir, file), "utf8");
  if (contents.includes('"@ctxpipe/aws-cdk"')) {
    console.log(`@ctxpipe/aws-cdk is listed in ${file}`);
    process.exit(0);
  }
}

process.exit(1);
