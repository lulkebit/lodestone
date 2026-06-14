#!/usr/bin/env node
// Print the CHANGELOG.md section for a single version to stdout.
// Used by the release workflow to fill the GitHub release body.
//
//   node scripts/extract-changelog.mjs 0.2.0
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (process.argv[2] || "").replace(/^v/, "");
if (!version) {
  console.error("usage: extract-changelog.mjs <version>");
  process.exit(1);
}

const md = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const out = [];
let collecting = false;
for (const line of md.split("\n")) {
  if (line.startsWith("## [")) {
    if (collecting) break;
    if (line.startsWith(`## [${version}]`)) {
      collecting = true;
      continue;
    }
  } else if (collecting) {
    out.push(line);
  }
}

process.stdout.write(out.join("\n").trim() || `Release ${version}`);
