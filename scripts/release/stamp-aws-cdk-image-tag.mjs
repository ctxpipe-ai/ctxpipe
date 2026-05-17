#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const targetFile = resolve("packages/aws-cdk/src/pinned-service-image-tag.ts");
const tagArgPrefix = "--tag=";
const tagArg = process.argv.find((arg) => arg.startsWith(tagArgPrefix));
const dryRun = process.argv.includes("--dry-run");

const imageTag =
  tagArg?.slice(tagArgPrefix.length) || process.env.IMAGE_TAG || process.env.GITHUB_SHA;

if (!imageTag) {
  throw new Error("Missing image tag. Pass --tag=<tag> or set IMAGE_TAG/GITHUB_SHA.");
}

if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(imageTag)) {
  throw new Error(`Invalid image tag: ${imageTag}`);
}

const file = await readFile(targetFile, "utf8");
const pattern = /(export const PINNED_SERVICE_IMAGE_TAG\s*=\s*)"([^"]+)"(\s*as const;)/m;
const match = file.match(pattern);

if (!match) {
  throw new Error(`Could not find PINNED_SERVICE_IMAGE_TAG assignment in ${targetFile}.`);
}

const currentTag = match[2];
if (currentTag === imageTag) {
  console.log(`PINNED_SERVICE_IMAGE_TAG already set to ${imageTag}`);
  process.exit(0);
}

const updated = file.replace(pattern, `$1"${imageTag}"$3`);

if (dryRun) {
  console.log(`Dry run: would update PINNED_SERVICE_IMAGE_TAG from ${currentTag} to ${imageTag}`);
  process.exit(0);
}

await writeFile(targetFile, updated);
console.log(`Updated PINNED_SERVICE_IMAGE_TAG from ${currentTag} to ${imageTag}`);
