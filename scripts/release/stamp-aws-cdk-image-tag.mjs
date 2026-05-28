#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stampScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/aws-cdk/scripts/stamp-image-tag.mjs",
);

const result = spawnSync(process.execPath, [stampScript, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
