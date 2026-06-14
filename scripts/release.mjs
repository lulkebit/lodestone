#!/usr/bin/env node
// Bump the version everywhere it lives and prepare a changelog section.
//
//   npm run release -- patch        # 0.2.0 -> 0.2.1
//   npm run release -- minor        # 0.2.0 -> 0.3.0
//   npm run release -- major        # 0.2.0 -> 1.0.0
//   npm run release -- 1.4.2        # explicit version
//
// Keeps package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml in
// sync, then ensures CHANGELOG.md has a dated section to fill in. Pushing the
// resulting `v<version>` tag triggers the GitHub release build.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
if (!arg) {
  console.error("usage: npm run release -- <major|minor|patch|x.y.z>");
  process.exit(1);
}

const pkgPath = join(root, "package.json");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const changelogPath = join(root, "CHANGELOG.md");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;

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

// package.json
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tauri.conf.json (JSON.stringify keeps key order)
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// Cargo.toml — only the version inside [package]
let cargo = readFileSync(cargoPath, "utf8");
cargo = cargo.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/,
  `$1${next}$2`
);
writeFileSync(cargoPath, cargo);

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
console.log("Aktualisiert: package.json, tauri.conf.json, Cargo.toml, CHANGELOG.md\n");
console.log("Nächste Schritte:");
console.log(`  1. CHANGELOG.md für ${next} ausformulieren`);
console.log(`  2. git add -A && git commit -m "Release v${next}"`);
console.log(`  3. git tag v${next} && git push origin HEAD --tags`);
console.log("\nDer Tag-Push startet den GitHub-Release-Build automatisch.\n");
