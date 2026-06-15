#!/usr/bin/env node
// Bump the version everywhere it lives and prepare a changelog section.
//
//   npm run release -- patch        # 0.2.0 -> 0.2.1
//   npm run release -- minor        # 0.2.0 -> 0.3.0
//   npm run release -- major        # 0.2.0 -> 1.0.0
//   npm run release -- 1.4.2        # explicit version
//
// src-tauri/Cargo.toml is the single source of truth for the version: the
// running app reads it via package_info() and tauri.conf.json inherits it (it
// has no version field). package.json is kept in sync only for the npm/Tauri
// CLI tooling. Also ensures CHANGELOG.md has a dated section to fill in. Pushing
// the resulting `v<version>` tag triggers the GitHub release build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run release -- <major|minor|patch|x.y.z>");
  process.exit(1);
}

const cargoPath = join(root, "src-tauri", "Cargo.toml");
const pkgPath = join(root, "package.json");
const changelogPath = join(root, "CHANGELOG.md");

// Read the current version from the source of truth.
let cargo = readFileSync(cargoPath, "utf8");
const cargoMatch = cargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]*)"/);
if (!cargoMatch) {
  console.error("Konnte die Version in src-tauri/Cargo.toml nicht finden.");
  process.exit(1);
}
const current = cargoMatch[1];

function bump(v, kind) {
  const [a, b, c] = v.split(".").map(Number);
  if (kind === "major") return `${a + 1}.0.0`;
  if (kind === "minor") return `${a}.${b + 1}.0`;
  if (kind === "patch") return `${a}.${b}.${c + 1}`;
  return null;
}

let next = bump(current, arg);
if (!next) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error(`Ungültige Version "${arg}". Nutze major|minor|patch oder x.y.z.`);
    process.exit(1);
  }
  next = arg;
}

// Cargo.toml — only the version inside [package]
cargo = cargo.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/,
  `$1${next}$2`
);
writeFileSync(cargoPath, cargo);

// package.json — kept in sync for npm / the Tauri CLI
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// CHANGELOG.md — add a dated section for `next` if it isn't there yet
let cl = readFileSync(changelogPath, "utf8");
const today = new Date().toISOString().slice(0, 10);
if (!cl.includes(`## [${next}]`)) {
  const section = `## [${next}] - ${today}\n\n### Hinzugefügt\n\n- …`;
  if (cl.includes("## [Unreleased]")) {
    cl = cl.replace("## [Unreleased]", `## [Unreleased]\n\n${section}`);
  } else {
    cl = cl.replace(/\n## \[/, `\n${section}\n\n## [`);
  }
  writeFileSync(changelogPath, cl);
}

console.log(`\n  ${current} → ${next}\n`);
console.log("Aktualisiert: Cargo.toml, package.json, CHANGELOG.md\n");
console.log("Nächste Schritte:");
console.log(`  1. CHANGELOG.md für ${next} ausformulieren`);
console.log(`  2. git add -A && git commit -m "Release v${next}"`);
console.log(`  3. git tag v${next} && git push origin HEAD --tags`);
console.log("\nDer Tag-Push startet den GitHub-Release-Build automatisch.\n");
