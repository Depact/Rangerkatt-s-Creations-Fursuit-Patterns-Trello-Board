// Readme regeneration script - only generates markdown, skips image downloads
import { program } from 'commander';
import fs from 'fs-extra';
import path from 'node:path';
import sanitize from 'sanitize-filename';

program
  .name('regenerate-readme')
  .argument('<json>', 'Trello board JSON export')
  .argument('[out]',  'output folder', 'Fursuit Patterns')
  .action(run);

async function run(jsonFile, OUT) {
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
    const seeList = l => {
      if (l?.id && l?.name && !lists.has(l.id)) {
        lists.set(l.id, { id: l.id, name: l.name });
        order.push(l.id);
      }
    };
    for (const a of board.actions ?? [])
      [a?.data?.list, a?.data?.listBefore, a?.data?.listAfter].forEach(seeList);
    for (const c of board.cards ?? [])
      if (!lists.has(c.idList)) seeList({ id: c.idList, name: `List-${c.idList.slice(0, 6)}` });
  }

  /* --- group & sort --- */
  const grouped = new Map();
  for (const c of board.cards ?? []) {
    if (c.closed) continue;
    if (!grouped.has(c.idList)) grouped.set(c.idList, []);
    grouped.get(c.idList).push(c);
  }
  for (const arr of grouped.values()) arr.sort((a, b) => a.pos - b.pos);

  /* --- format helpers --- */
  const slug  = s => (s ?? '').toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const one   = s => (s ?? '').replace(/\s+/g, ' ').trim();
  const tag   = s => '#' + s.toLowerCase()
    .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const alt   = s => one(s).replace(/[[\]()|!]/g, '') || 'image';
  const clean = d => !d ? '' : d
    .replace(/\\_/g, '_')
    .replace(/\]\(([^)]+?)\s+["'‌]+\)/g, ']($1)')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  /* --- helper function for item grid --- */
  const createItemGridHTML = (items) => {
    return items.slice(0, Math.min(5, items.length)).map(item => {
      const itemAnchor = slug(one(item.name));
      const firstItemImg = (item.attachments?.find(a => a?.mimeType?.startsWith('image/'))?.url) || '';
      
      const imageSection = firstItemImg 
        ? `<div style="text-align:center;"><img src="${firstItemImg}" alt="${one(item.name)}" style="max-width:100%;height:auto;border-radius:4px;object-fit:cover;max-height:80px;" loading="lazy" /></div>`
        : '<div style="height:60px;background:#ddd;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#999;font-size:11px;">No image</div>';
      
      return `
        <div style="border:1px solid #e0e0e0;border-radius:6px;padding:8px;background:#fafafa;">
          <a href="#${itemAnchor}" style="text-decoration:none;color:inherit;display:block;">
            <div style="font-size:12px;font-weight:500;margin-bottom:4px;line-height:1.2;">${one(item.name)}</div>
            <div style="font-size:10px;color:#666;margin-bottom:6px;">${(item.attachments?.filter(a => a?.mimeType?.startsWith('image/')).length || 0)} images</div>
            ${imageSection}
          </a>
        </div>
      `;
    }).join('');
  };

  /* --- build body in one pass --- */
  const body = [];
  const preview = [];
  let li = 0, cards = 0, refs = 0;

  for (const listId of order) {
    const list  = lists.get(listId);
    const items = grouped.get(listId) ?? [];
    if (!items.length) continue;
    if (list.name === 'Label Codes:') continue;
    li++;

    // Collect preview data for grid (first image per list)
    const firstCard = items[0];
    const firstImgUrl = (firstCard?.attachments?.find(a => a?.mimeType?.startsWith('image/'))?.url) || '';
    preview.push({ name: list.name, count: items.length, firstImgUrl });

    const listAnchor = slug(list.name);
    body.push(
      `<details>`,
      `  <summary>${list.name} (${items.length} cards)</summary>`,
      '',
      `<a id="${listAnchor}"></a>`,
      '',
      `## ${list.name}`, '',
      '---', '',
    );

    /* --- Enhanced section preview grid with item previews --- */
    if (items.length > 0) {
      body.push('### Preview Grid - First Items', '');
      body.push('<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin:16px 0;">');
      body.push(createItemGridHTML(items));
      body.push('</div>');
      body.push('');
    }

    const listDir = sanitize(list.name).slice(0, 80) || 'list';
    let ci = 0;

    for (const c of items) {
      ci++; cards++;
      const cardAnchor = slug(one(c.name));
      const cardDir    = sanitize(one(c.name)).slice(0, 100) || 'card';
      const relDir     = `attachments/${listDir}/${cardDir}`;
      const imgRelDir  = relDir.split('/').join('/');
      const absDir     = path.join(OUT, relDir);
      const tags       = (c.labels ?? []).map(l => l.name).filter(Boolean).map(tag);

      body.push(`<a id="${cardAnchor}"></a>`);
      body.push(tags.length ? `### ${one(c.name)} ${tags.join(' ')}` : `### ${one(c.name)}`, '');

      const desc = clean(c.desc);
      if (desc) body.push(desc, '');

      let n = 0;
      for (const att of c.attachments ?? []) {
        if (!att.mimeType?.startsWith('image/')) continue;
        n++; refs++;
        let ext = '.png';
        try { ext = path.extname(new URL(att.url).pathname) || '.png'; } catch {}
        if (ext.length > 6) ext = '.png';
        const file = `image-${String(n).padStart(2, '0')}${ext}`;
        // Just add the markdown reference - don't download
        body.push(`![${alt(c.name)}](<${imgRelDir}/${file}>)`, '');
      }
      body.push('---', '');
    }
  }

  /* --- header + preview grid --- */
  const grid = preview.length ? ['## Quick Navigate', '', '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:16px;">', ...preview.map(p =>
    `<div style="border:1px solid #ddd;border-radius:8px;padding:12px;"><strong><a href="#${slug(p.name)}">${p.name}</a></strong><br>${p.count} cards${p.firstImgUrl ? `<br><img src="${p.firstImgUrl}" style="max-width:100%;border-radius:4px;margin-top:8px;" loading="lazy">` : ''}</div>`
  ), '</div>', ''] : [];

  const header = [
    `# Rangerkatt's Creations Fursuit Patterns (Trello Board)`, '',
    `**Original Board Source board:** <${board.url}>`,
    'This repo goal is to make Rangerkatt\'s Creations easy to access, as my laptop struggle to open original page.', '',
    ...grid,
    '',
  ];

  /* --- write note --- */
  await fs.ensureDir(OUT);
  const noteFile = path.join(OUT, `${sanitize(board.name)}.md`);
  await fs.writeFile(noteFile, [...header, ...body].join('\n'));
  console.log(`✓ ${noteFile}  (${li} lists · ${cards} cards · ${refs} image refs)`);
}

await program.parseAsync();