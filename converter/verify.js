#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mdFile = path.join(__dirname, '..', 'Fursuit Patterns.md');
const md = await fs.readFile(mdFile, 'utf8');

// Check for duplicate anchors
const anchors = [...md.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]);
const seen = new Map();
for (const a of anchors) {
  seen.set(a, (seen.get(a) ?? 0) + 1);
}
const dupes = [...seen.entries()].filter(([, c]) => c > 1);
console.log('=== ANCHOR DUPLICATES ===');
if (dupes.length) {
  for (const [a, c] of dupes) console.log(`  ${a}: ${c}x`);
} else {
  console.log('  None — all anchors unique');
}

// Check for numeric anchors
const numericAnchors = [...md.matchAll(/href="#card-\d+/g)].map(m => m[0]);
console.log('\n=== NUMERIC ANCHORS ===');
console.log(`  ${numericAnchors.length} found${numericAnchors.length ? ': ' + numericAnchors.slice(0, 5).join(', ') : ''}`);

// Check for Source sub fragments
const sourceFrags = [...md.matchAll(/<sub>Source:/g)].length;
console.log('\n=== SOURCE FRAGMENTS ===');
console.log(`  ${sourceFrags} found`);

// Check for broken image references
const imgRefs = [...md.matchAll(/!\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g)].map(m => m[1]);
console.log('\n=== IMAGE REFERENCES ===');
console.log(`  ${imgRefs.length} image references`);
let broken = 0;
for (const ref of imgRefs) {
  const full = path.join(__dirname, '..', ref.replace(/^<|>$/g, ''))
  if (!(await fs.pathExists(full))) {
    if (broken < 10) console.log(`  MISSING: ${ref}`);
    broken++;
  }
}
console.log(`  ${broken} broken (of ${imgRefs.length})`);

// Check unique TOC anchors vs body anchors
const tocLinks = [...md.matchAll(/- \[.*?\]\(#(.+?)\)/g)].map(m => m[1]);
const tocSet = new Set(tocLinks);
console.log('\n=== TOC ANCHOR CHECK ===');
console.log(`  TOC links: ${tocLinks.length}, unique: ${tocSet.size}`);
const missingFromBody = [...tocSet].filter(a => !anchors.includes(a));
if (missingFromBody.length) {
  console.log(`  ${missingFromBody.length} TOC anchors not found in body:`);
  missingFromBody.slice(0, 20).forEach(a => console.log(`    #${a}`));
} else {
  console.log('  All TOC anchors found in body');
}
