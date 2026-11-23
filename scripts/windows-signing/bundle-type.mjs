#!/usr/bin/env node
// Writes, or checks, the installer type Tauri records inside the app's .exe.
//
// Why this exists: while bundling, tauri-bundler overwrites a placeholder in the
// main binary (__TAURI_BUNDLE_TYPE_VAR_UNK) with the installer type, so the
// updater knows whether it was installed by NSIS or MSI
// (crates/tauri-bundler/src/bundle.rs patch_binary, CLI 2.11.x). That edit
// happens INSIDE `tauri bundle`, so an exe signed before bundling would come
// out with a broken signature. We make the same edit ourselves, have SignPath
// sign the result, and `tauri bundle` then finds no placeholder, logs a
// warning and leaves the signed exe alone.
//
// The three tokens must match tauri-bundler byte for byte. If a Tauri upgrade
// changes them, `check` below fails the build rather than shipping an app
// whose updater cannot tell its installer type.
//
//   node bundle-type.mjs patch <in.exe> <nsis|msi> <out.exe>
//   node bundle-type.mjs check <file.exe> <nsis|msi>

import { readFileSync, writeFileSync } from 'node:fs';

const PLACEHOLDER = '__TAURI_BUNDLE_TYPE_VAR_UNK';
const TOKENS = { nsis: '__TAURI_BUNDLE_TYPE_VAR_NSS', msi: '__TAURI_BUNDLE_TYPE_VAR_MSI' };

function fail(msg) {
  console.error(`bundle-type: ${msg}`);
  process.exit(1);
}

function count(buf, needle) {
  const n = Buffer.from(needle);
  let at = buf.indexOf(n);
  let found = 0;
  while (at !== -1) {
    found++;
    at = buf.indexOf(n, at + 1);
  }
  return found;
}

const [mode, file, type, out] = process.argv.slice(2);
const token = TOKENS[type];
if (!token) fail(`unknown installer type "${type}" (expected nsis or msi)`);

const data = readFileSync(file);

if (mode === 'patch') {
  if (!out) fail('patch needs an output path');
  const n = count(data, PLACEHOLDER);
  if (n !== 1) fail(`${file}: expected exactly one ${PLACEHOLDER}, found ${n}`);
  const at = data.indexOf(Buffer.from(PLACEHOLDER));
  const patched = Buffer.from(data);
  Buffer.from(token).copy(patched, at);
  writeFileSync(out, patched);
  console.log(`${out}: ${PLACEHOLDER} -> ${token} at offset ${at}`);
} else if (mode === 'check') {
  const want = count(data, token);
  const left = count(data, PLACEHOLDER);
  const other = Object.entries(TOKENS).filter(([t]) => t !== type).reduce((s, [, tok]) => s + count(data, tok), 0);
  if (want !== 1 || left !== 0 || other !== 0) {
    fail(`${file}: expected one ${token} and no other bundle-type token (found ${want} ${type}, ${left} placeholder, ${other} other)`);
  }
  console.log(`${file}: records installer type ${type}`);
} else {
  fail('usage: bundle-type.mjs patch <in.exe> <nsis|msi> <out.exe> | check <file.exe> <nsis|msi>');
}
