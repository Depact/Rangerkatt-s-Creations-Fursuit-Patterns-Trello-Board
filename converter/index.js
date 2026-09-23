#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import sanitize from 'sanitize-filename';

async function pull(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

function slug(x) { return x.toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function one(x) { return x ?? ''; }
function clean(x) { return x?.trim() || ''; }
function alt(x) { return x.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\\*/g, '\\*'); }

/* --- helper: create 3-col preview grid markdown --- */
function createItemGridMarkdown(items, listName, count, sectionFile) {
  if (items.length === 0) return '';
  
  const makeCell = (item) => {
    if (!item) return '';
    const itemAnchor = slug(one(item.name));
    const firstItemImg = (item.attachments?.find(a => a?.mimeType?.startsWith('image/'))?.url) || '';
    const imageMd = firstItemImg 
      ? `![${one(item.name)}](${firstItemImg})`
      : '*No image*';
    // Link to section file + anchor
    return `[${one(item.name)}](${sectionFile}#${itemAnchor}) ${imageMd}`;
  };
  
  const rows = [];
  for (let i = 0; i < items.length; i += 3) {
    const cells = [
      makeCell(items[i]),
      makeCell(items[i + 1]),
      makeCell(items[i + 2])
    ];
    rows.push(`|${cells.join('|')}|`);
  }
  
  const header = `### ${listName} (${count} cards)\n\n|Preview|Preview|Preview|\n|---|---|---|`;
  return [header, ...rows].join('\n');
}

async function run(jsonFile, OUT) {
  const concurrency = Number(program.opts().concurrency);
  const isFile = OUT.endsWith('.md');
  const outDir = isFile ? path.dirname(OUT) : OUT;
  const board = await fs.readJson(jsonFile);

  /* --- lists --- */
  const lists = new Map(), order = [];
  if (board.lists && board.lists.length > 0) {
    for (const l of board.lists) {
      if (l?.id && l?.name) {
        lists.set(l.id, { id: l.id, name: l.name });
        order.push(l.id);
      }
    }
  } else {
    const seeList = l => {
      if (l?.id && l?.name && !lists.has(l.id)) {
        lists.set(l.id, { id: l.id, name: l.name });
        order.push(l.id);
      }
    };
    if (board.actions?.length) {
      for (const a of board.actions) {
        if (a?.list?.id) seeList(a.list);
        if (a?.memberList?.id) seeList(a.memberList);
      }
    }
    for (const a of board.actions ?? []) {
      if (a?.board && a.board !== board.id) continue;
      const lid = a.list?.id || a.memberList?.id;
      if (!lid) continue;
      if (lists.has(lid)) continue;
      const listName = a.list?.name || a.memberList?.name || 'Unknown List';
      lists.set(lid, { id: lid, name: listName });
      order.push(lid);
    }
  }

  /* --- Prepare data --- */
  const sections = [];
  for (const l of order) {
    const list = lists.get(l);
    if (!list?.name) continue;
    const items = board.cards?.filter(c => c.idList === l) || [];
    if (!items.length) continue;
    if (list.name === 'Label Codes:') continue;
    
    const sectionFile = `${slug(list.name)}.md`;
    sections.push({ list, items, sectionFile });
  }

  /* --- Create patterns directory --- */
  const patternsDir = path.join(outDir, 'patterns');
  await fs.ensureDir(patternsDir);

  /* --- Generate section files --- */
  const jobs = [];
  let totalCards = 0, totalRefs = 0;

  for (const { list, items, sectionFile } of sections) {
    const sectionPath = path.join(patternsDir, sectionFile);
    const listDir = sanitize(list.name).slice(0, 80) || 'list';
    const lines = [];
    
    lines.push(`# ${list.name}`, '');
    lines.push(`[← Back to Index](README.md)`, '');
    lines.push('---', '');

    for (const c of items) {
      totalCards++;
      const cardAnchor = slug(one(c.name));
      const cardDir    = sanitize(one(c.name)).slice(0, 100) || 'card';
      const relDir     = `../attachments/${listDir}/${cardDir}`;
      const imgRelDir  = relDir.split('\\').join('/');
      const absDir     = path.join(outDir, 'attachments', listDir, cardDir);
      const tags       = (c.labels ?? []).map(l => l.name).filter(Boolean).map(l => l.name);

      lines.push(`<a id="${cardAnchor}"></a>`, '');
      lines.push(tags.length ? `### ${one(c.name)} ${tags.join(' ')}` : `### ${one(c.name)}`, '');

      const desc = clean(c.desc);
      if (desc) lines.push(desc, '');

      let n = 0;
      for (const att of c.attachments ?? []) {
        if (!att.mimeType?.startsWith('image/')) continue;
        try { new URL(att.url); } catch { continue; }
        n++; totalRefs++;
        let ext = '.png';
        try { ext = path.extname(new URL(att.url).pathname) || '.png'; } catch {}
        if (ext.length > 6) ext = '.png';
        const file = `image-${String(n).padStart(2, '0')}${ext}`;
        jobs.push(pull(att.url, path.join(absDir, file))
          .then(() => stats.ok++)
          .catch(e => {
            console.error(`  ✗ Failed: ${att.url} — ${e.message}`);
            stats.fail++;
          }));
        lines.push(`![${alt(c.name)}](<${imgRelDir}/${file}>)`, '');
      }
      lines.push('---', '');
    }
    
    await fs.writeFile(sectionPath, lines.join('\n'));
  }

  /* --- Generate main README.md with preview grids --- */
  const readmeLines = [
    `# Rangerkatt's Creations Fursuit Patterns (Trello Board)`, '',
    `**Original Board Source board:** <${board.url}>`, '',
    'This repo goal is to make Rangerkatt\'s Creations easy to access, as my laptop struggle to open original page.', '',
    '## Table of Contents', '',
  ];

  for (const { list, items, sectionFile } of sections) {
    readmeLines.push(createItemGridMarkdown(items, list.name, items.length, `patterns/${sectionFile}`));
    readmeLines.push('');
  }

  readmeLines.push('---', '');
  readmeLines.push('## Sections', '');
  for (const { list, items, sectionFile } of sections) {
    readmeLines.push(`- [${list.name} (${items.length} cards)](patterns/${sectionFile})`);
  }

  const readmePath = isFile ? OUT : path.join(OUT, 'README.md');
  await fs.ensureDir(outDir);
  await fs.writeFile(readmePath, readmeLines.join('\n'));
  console.log(`✓ ${readmePath} + ${sections.length} section files  (${sections.length} lists · ${totalCards} cards · ${totalRefs} image refs)`);

  /* --- wait for downloads --- */
  const stats = { ok: 0, skip: 0, fail: 0 };
  if (jobs.length) {
    console.log(`\n↓ Fetching ${jobs.length} images → ${outDir}/attachments/`);
    await Promise.allSettled(jobs);
    console.log(`  ✓ ${stats.ok} downloaded  ·  ${stats.skip} cached  ·  ${stats.fail} failed`);
  }
}

program
  .name('trello-to-obsidian')
  .argument('<json>', 'Trello board JSON export')
  .argument('[out]',  'output file or folder', 'README.md')
  .option('-c, --concurrency <n>', 'parallel downloads', '6')
  .action(run);

await program.parseAsync();