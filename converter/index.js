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

/* --- helper: detect image by URL extension --- */
function isImageUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const ext = u.pathname.split('.').pop()?.toLowerCase() || '';
    return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext);
  } catch {
    return false;
  }
}

/* --- helper: extract first image URL from attachments or description --- */
function getFirstImageUrl(item) {
  const fromAttach = item.attachments?.find(a => a?.mimeType?.startsWith('image/') || isImageUrl(a?.url))?.url;
  if (fromAttach) return fromAttach;
  if (item.desc) {
    const urls = item.desc.match(/https?:\/\/[^\s)]+/g) || [];
    const imgUrl = urls.find(u => isImageUrl(u));
    if (imgUrl) return imgUrl;
  }
  return '';
}

/* --- helper: fetch HTML page and extract first image --- */
async function fetchPageImage(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const html = await res.text();
    // Look for og:image, twitter:image, or first <img>
    const metaMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (metaMatch) return metaMatch[1];
    const imgMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) {
      const imgUrl = new URL(imgMatch[1], url).href;
      return imgUrl;
    }
  } catch {}
  return null;
}

/* --- helper: create 2-col preview grid markdown using LOCAL paths --- */
function mdImg(alt, url) {
  const needsWrap = /[\s()#?%&]/.test(url);
  return `![${alt}](${needsWrap ? '<' + url + '>' : url})`;
}

function createItemGridMarkdown(items, listName, count, sectionFile, localImages) {
  if (items.length === 0) return '';
  
  const makeCell = (item) => {
    if (!item) return '';
    const itemAnchor = slug(one(item.name));
    const localImg = localImages.get(item.id);
    const imageMd = localImg 
      ? mdImg(one(item.name), localImg)
      : '*No image*';
    return `[${one(item.name)}](${sectionFile}#${itemAnchor}) ${imageMd}`;
  };
  
  const rows = [];
  for (let i = 0; i < items.length; i += 2) {
    const cells = [
      makeCell(items[i]),
      makeCell(items[i + 1])
    ];
    rows.push(`|${cells.join('|')}|`);
  }
  
  const header = `# ${listName} (${count} cards)\n\n|Preview|Preview|\n|---|---|`;
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

  /* --- First pass: collect all image URLs to download (attachments + external) --- */
  const downloadJobs = []; // { url, destPath, cardId, listDir, cardDir, imageIndex }
  const cardImageMap = new Map(); // cardId -> [local relative paths]
  const stats = { ok: 0, fail: 0 };
  let totalRefs = 0;

  for (const { list, items, sectionFile } of sections) {
    const listDir = sanitize(list.name).slice(0, 80) || 'list';
    
    for (const c of items) {
      const cardAnchor = slug(one(c.name));
      const cardDir    = sanitize(one(c.name)).slice(0, 100) || 'card';
      const readmeRel  = `attachments/${listDir}/${cardDir}`.split('\\').join('/');   // for README (at root)
      const sectionRel = `../attachments/${listDir}/${cardDir}`.split('\\').join('/'); // for section files (in patterns/)
      const absDir     = path.join(outDir, 'attachments', listDir, cardDir);
      
      await fs.ensureDir(absDir);
      
      const readmePaths = [];
      const sectionPaths = [];
      let n = 0;

      // 1. Download attachment images
      for (const att of c.attachments ?? []) {
        if (!att.mimeType?.startsWith('image/') && !isImageUrl(att.url)) continue;
        try { new URL(att.url); } catch { continue; }
        n++; totalRefs++;
        let ext = '.png';
        try { ext = path.extname(new URL(att.url).pathname) || '.png'; } catch {}
        if (ext.length > 6) ext = '.png';
        const file = `image-${String(n).padStart(2, '0')}${ext}`;
        const destPath = path.join(absDir, file);
        readmePaths.push(`${readmeRel}/${file}`);
        sectionPaths.push(`${sectionRel}/${file}`);
        downloadJobs.push({ url: att.url, destPath, cardId: c.id });
      }

      // 2. If no attachment images, try external URLs from description
      if (readmePaths.length === 0 && c.desc) {
        const urls = c.desc.match(/https?:\/\/[^\s)]+/g) || [];
        for (const url of urls) {
          // Skip non-product URLs (trello, etc.)
          if (url.includes('trello.com') || url.includes('github.com')) continue;
          
          // Try direct image URL first
          if (isImageUrl(url)) {
            n++; totalRefs++;
            let ext = '.png';
            try { ext = path.extname(new URL(url).pathname) || '.png'; } catch {}
            if (ext.length > 6) ext = '.png';
            const file = `image-${String(n).padStart(2, '0')}${ext}`;
            const destPath = path.join(absDir, file);
            readmePaths.push(`${readmeRel}/${file}`);
            sectionPaths.push(`${sectionRel}/${file}`);
            downloadJobs.push({ url, destPath, cardId: c.id });
            break;
          }
          
          // Try fetching product page for image
          const pageImage = await fetchPageImage(url);
          if (pageImage && isImageUrl(pageImage)) {
            n++; totalRefs++;
            let ext = '.png';
            try { ext = path.extname(new URL(pageImage).pathname) || '.png'; } catch {}
            if (ext.length > 6) ext = '.png';
            const file = `image-${String(n).padStart(2, '0')}${ext}`;
            const destPath = path.join(absDir, file);
            readmePaths.push(`${readmeRel}/${file}`);
            sectionPaths.push(`${sectionRel}/${file}`);
            downloadJobs.push({ url: pageImage, destPath, cardId: c.id });
            break;
          }
        }
      }

      cardImageMap.set(c.id, { readme: readmePaths, section: sectionPaths });
    }
  }

  /* --- Download all images with concurrency limit --- */
  async function downloadWithConcurrency(jobs, limit) {
    const executing = [];
    for (const job of jobs) {
      const p = pull(job.url, job.destPath)
        .then(() => { stats.ok++; })
        .catch(e => { 
          console.error(`  ✗ Failed: ${job.url} — ${e.message}`);
          stats.fail++; 
        });
      executing.push(p);
      if (executing.length >= limit) {
        await Promise.race(executing);
        // Remove settled
        for (let i = executing.length - 1; i >= 0; i--) {
          if (executing[i] === p) break; // simple approach
        }
      }
    }
    await Promise.allSettled(executing);
  }

  if (downloadJobs.length) {
    console.log(`\n↓ Fetching ${downloadJobs.length} images → ${outDir}/attachments/`);
    // Simple batching for concurrency
    const BATCH = concurrency;
    for (let i = 0; i < downloadJobs.length; i += BATCH) {
      const batch = downloadJobs.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(job => 
        pull(job.url, job.destPath)
          .then(() => stats.ok++)
          .catch(e => { 
            console.error(`  ✗ Failed: ${job.url} — ${e.message}`);
            stats.fail++; 
          })
      ));
    }
    console.log(`  ✓ ${stats.ok} downloaded  ·  ${stats.fail} failed`);
  }

  /* --- Second pass: Generate section files with LOCAL paths --- */
  let totalCards = 0;
  
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
      const tags       = (c.labels ?? []).map(l => l.name).filter(Boolean).map(l => l.name);

      lines.push(`<a id="${cardAnchor}"></a>`, '');
      lines.push(tags.length ? `### ${one(c.name)} ${tags.join(' ')}` : `### ${one(c.name)}`, '');

      const desc = clean(c.desc);
      if (desc) lines.push(desc, '');

      // Use local downloaded images (section paths)
      const paths = cardImageMap.get(c.id) || { section: [] };
      for (const localPath of paths.section) {
        lines.push(`${mdImg(alt(c.name), localPath)}`, '');
      }
      // If still no images, note it
      if (paths.section.length === 0) {
        lines.push('*No images available*', '');
      }
      lines.push('---', '');
    }
    
    await fs.writeFile(sectionPath, lines.join('\n'));
  }

  /* --- Generate main README.md with preview grids using LOCAL paths --- */
  const readmeLines = [
    `# Rangerkatt's Creations Fursuit Patterns (Trello Board)`, '',
    `**Original Board Source board:** <${board.url}>`, '',
    'This repo goal is to make Rangerkatt\'s Creations easy to access, as my laptop struggle to open original page.', '',
    '## Table of Contents', '',
  ];

  for (const { list, items, sectionFile } of sections) {
    // Build localImages map for this section
    const localImages = new Map();
    for (const item of items) {
      const paths = cardImageMap.get(item.id) || { readme: [] };
      if (paths.readme.length > 0) {
        localImages.set(item.id, paths.readme[0]); // first image for preview
      }
    }
    readmeLines.push(createItemGridMarkdown(items, list.name, items.length, `patterns/${sectionFile}`, localImages));
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
}

program
  .name('trello-to-obsidian')
  .argument('<json>', 'Trello board JSON export')
  .argument('[out]',  'output file or folder', 'README.md')
  .option('-c, --concurrency <n>', 'parallel downloads', '6')
  .action(run);

await program.parseAsync();