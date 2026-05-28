#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { join } from "node:path";

const changesetDir = join(process.cwd(), ".changeset");
const entries = await readdir(changesetDir, { withFileTypes: true });
const pending = entries.filter(
  (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md",
);

if (pending.length === 0) {
  console.error("No pending changesets to publish. Add a .changeset/*.md file on the selected ref.");
  process.exit(1);
}

console.log(`Found ${pending.length} pending changeset(s): ${pending.map((f) => f.name).join(", ")}`);
