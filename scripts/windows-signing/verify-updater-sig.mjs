#!/usr/bin/env node
// Verifies a Tauri updater signature (.sig) against a file and the updater
// public key in tauri.conf.json, with no minisign binary needed.
//
// Used after Windows code signing: SignPath changes the installer's bytes, so
// the .sig the bundler wrote before that no longer matches. We re-sign with
// `tauri signer sign` and prove here that the .sig belongs to the SIGNED file;
// a mismatch would make every Windows app refuse the update.
//
//   node verify-updater-sig.mjs <file> <file.sig> <tauri.conf.json>
//
// Formats (minisign): the config's pubkey and the .sig are base64 of minisign's
// text files. Public key blob = "Ed" + key id (8) + key (32). Signature blob =
// "Ed" (pure) or "ED" (BLAKE2b-512 prehashed) + key id (8) + signature (64);
// the global signature covers signature (64) + the trusted comment.

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

function fail(msg) {
  console.error(`verify-updater-sig: ${msg}`);
  process.exit(1);
}

const [file, sigFile, confFile] = process.argv.slice(2);
if (!file || !sigFile || !confFile) fail('usage: verify-updater-sig.mjs <file> <file.sig> <tauri.conf.json>');

const conf = JSON.parse(readFileSync(confFile, 'utf8'));
const pubText = Buffer.from(conf?.plugins?.updater?.pubkey ?? '', 'base64').toString('utf8');
const pubLine = pubText.split(/\r?\n/).filter(Boolean)[1];
if (!pubLine) fail(`no updater pubkey in ${confFile}`);
const pub = Buffer.from(pubLine, 'base64');
if (pub.length !== 42 || pub.subarray(0, 2).toString() !== 'Ed') fail('updater pubkey is not a minisign Ed25519 key');
const pubKeyId = pub.subarray(2, 10);
const key = createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: pub.subarray(10).toString('base64url') },
  format: 'jwk',
});

const sigText = Buffer.from(readFileSync(sigFile, 'utf8').trim(), 'base64').toString('utf8');
const lines = sigText.split(/\r?\n/);
const sig = Buffer.from(lines[1] ?? '', 'base64');
const trusted = lines[2] ?? '';
const globalSig = Buffer.from(lines[3] ?? '', 'base64');
if (sig.length !== 74 || !trusted.startsWith('trusted comment: ') || globalSig.length !== 64) {
  fail(`${sigFile} is not a minisign signature`);
}
const alg = sig.subarray(0, 2).toString();
if (!sig.subarray(2, 10).equals(pubKeyId)) fail(`${sigFile} was made with a different key than tauri.conf.json's updater pubkey`);

const data = readFileSync(file);
const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : alg === 'Ed' ? data : null;
if (!message) fail(`unknown signature algorithm "${alg}"`);

if (!verify(null, message, key, sig.subarray(10))) fail(`${sigFile} does NOT match ${file}`);
const comment = Buffer.from(trusted.slice('trusted comment: '.length), 'utf8');
if (!verify(null, Buffer.concat([sig.subarray(10), comment]), key, globalSig)) fail(`${sigFile}: trusted comment signature is invalid`);

console.log(`${file}: updater signature OK (${trusted})`);
