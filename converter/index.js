#!/usr/bin/env node
import { program } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import pLimit from 'p-limit';
import sanitize from 'sanitize-filename';

async function pull(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function run(jsonFile, OUT) {
  const concurrency = Number(program.opts().concurrency);
  const isFile = OUT.endsWith('.md');
  const outDir = isFile ? path.dirname(OUT) : OUT;
  const board = await fs.readJson(jsonFile);

  /* --- lists (prefer board.lists, fallback to actions if export has no `lists`) --- */
  const lists = new Map(), order = [];
  if (board.lists && board.lists.length > 0) {
    for (const l of board.lists) {
      if (l?.id && l?.name) {
        lists.set(l.id, { id: l.id, name: l.name });
        order.push(l.id);
      }
    }
  } else {
    // Recover lists from actions if the export has no `lists`
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

  /* --- helper function for item grid (markdown table for GitHub compatibility) --- */
  const createItemGridMarkdown = (items, listName, count) => {
    if (items.length === 0) return '';
    
    // Build rows: 3 items per row (3 columns)
    // Each cell combines link + image: [Name](#anchor) ![Name](url)
    const makeCell = (item) => {
      if (!item) return '';
      const itemAnchor = slug(one(item.name));
      const firstItemImg = (item.attachments?.find(a => a?.mimeType?.startsWith('image/'))?.url) || '';
      const imageMd = firstItemImg 
        ? `![${one(item.name)}](${firstItemImg})`
        : '*No image*';
      return `[${one(item.name)}](${itemAnchor}) ${imageMd}`;
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
  };

  /* --- Pre-collect ALL card anchors so preview links work globally --- */
  const allCardAnchors = [];
  for (const l of order) {
    const list = lists.get(l);
    if (!list?.name) continue;
    const items = board.cards?.filter(c => c.idList === l) || [];
    for (const c of items) {
      const cardAnchor = slug(one(c.name));
      allCardAnchors.push(`<a id="${cardAnchor}"></a>`, '');
    }
  }

  /* --- build body in one pass --- */
  const body = [];
  const jobs = [];
  const preview = [];
  let li = 0, cards = 0, refs = 0;

  for (const l of order) {
    const list = lists.get(l);
    if (!list?.name) continue;
    const items = board.cards?.filter(c => c.idList === l) || [];
    if (!items.length) continue;
    if (list.name === 'Label Codes:') continue;
    li++;

    /* --- collect preview items (first 4) --- */
    const previewItems = items.slice(0, Math.min(4, items.length));
    preview.push({ 
      name: list.name, 
      count: items.length, 
      items: previewItems 
    });

    const listAnchor = slug(list.name);

    /* --- Preview grid OUTSIDE spoiler (visible by default) --- */
    if (items.length > 0) {
      body.push(createItemGridMarkdown(items, list.name, items.length));
      body.push('');
    }

    const listDir = sanitize(list.name).slice(0, 80) || 'list';

    /* Anchor BEFORE details so links work when collapsed */
    body.push(`<a id="${listAnchor}"></a>`, '');

    body.push(
      `<details>`,
      `  <summary>${list.name} (${items.length} cards)</summary>`,
      '',
      `## ${list.name}`, '',
      '---', '',
    );
    let ci = 0;

    for (const c of items) {
      ci++; cards++;
      const cardDir    = sanitize(one(c.name)).slice(0, 100) || 'card';
      const relDir     = `attachments/${listDir}/${cardDir}`;
      const imgRelDir  = relDir.split('/').join('/');
      const absDir     = path.join(outDir, relDir);
      const tags       = (c.labels ?? []).map(l => l.name).filter(Boolean).map(l => l.name);

      body.push(tags.length ? `### ${one(c.name)} ${tags.join(' ')}` : `### ${one(c.name)}`, '');

      const desc = clean(c.desc);
      if (desc) body.push(desc, '');

      let n = 0;
      for (const att of c.attachments ?? []) {
        if (!att.mimeType?.startsWith('image/')) continue;
        // Skip invalid URLs
        try { new URL(att.url); } catch { continue; }
        n++; refs++;
        let ext = '.png';
        try { ext = path.extname(new URL(att.url).pathname) || '.png'; } catch {}
        if (ext.length > 6) ext = '.png';
        const file = `image-${String(n).padStart(2, '0')}${ext}`;
        jobs.push(pull(att.url, path.join(absDir, file)));
        body.push(`![${alt(c.name)}](<${imgRelDir}/${file}>)`, '');
      }
      body.push('---', '');
    }
    body.push('</details>', '');
  }

  /* --- header (no Quick Navigate grid) --- */
  const header = [
    `# Rangerkatt's Creations Fursuit Patterns (Trello Board)`, '',
    `**Original Board Source board:** <${board.url}>`,
    'This repo goal is to make Rangerkatt\'s Creations easy to access, as my laptop struggle to open original page.', '',
  ];

  /* --- write note --- */
  const allContent = [...header, ...allCardAnchors, '', ...body].join('\n');
  const noteFile = isFile ? OUT : path.join(OUT, `${sanitize(board.name)}.md`);
  await fs.ensureDir(outDir);
  await fs.writeFile(noteFile, allContent);
  console.log(`✓ ${noteFile}  (${li} lists · ${cards} cards · ${refs} image refs)`);

  /* --- wait for downloads --- */
  const stats = { ok: 0, skip: 0, fail: 0 };
  if (jobs.length) {
    console.log(`\n↓ Fetching ${jobs.length} images → ${outDir}/attachments/`);
    await Promise.all(jobs);
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
function clean(x) { return x?.trim() || ''; }
function one(x) { return x ?? ''; }
function slug(x) { return x.toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function alt(x) { return x.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\\*/g, '\\*'); }