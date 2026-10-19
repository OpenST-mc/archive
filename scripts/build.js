// 稿件库构建脚本：物化标签目录树，生成稳定 id 与存档 sha256，重建索引产物
//
// 设计约定（详见根 README「目录与数据契约」）：
//   1. 标签即目录：scripts/config.snapshot.json 的 TAG_CONFIG 每个标签都物化为文件夹，
//      子标签位于父标签文件夹之内；空标签目录以 .gitkeep 占位。
//   2. 稿件落位：取 tags 命中的最深层标签目录；同层级命中多个时优先父链标签同样命中者，
//      再按 TAG_CONFIG 书写顺序取先出现者；完全未命中则落入「其他杂物」（杂项桶）。
//   3. 统一 id：每稿件的 .meta.json 保存一个 `sub-<epoch 毫秒>` 稳定 id：存量稿件沿用迁移时
//      冻结的原 sub id，新稿件首次构建时由 CI/CD 用仓库时间生成（同毫秒自增保证唯一），
//      此后永不改变；不再依赖客户端生成。
//   4. 版本：存档文件的 sha256 随版本更新写入 .meta.json，历史版本通过 git 历史获取。
//   5. 图片产物：preview.webp（详情用，≤1000px）与 thumb.webp（卡片用，≤480px）均为 CI 构建产物。
//
// 产物：
//   data/index.json          全量稿件条目（id/sha256/...）
//   data/tags/<标签>.json    每个标签一份的浏览索引
//   _meta/index-by-id.json   稳定 id -> {name, category, files, sha256}
//   _meta/image-cache.json   图片派生缓存（源图内容哈希）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const ARCHIVE_EXTS = ['.litematic', '.zip', '.rar']; // 按优先级排列
const RESERVED = ['scripts', 'data', '_meta', 'docs', 'node_modules'];
const PREVIEW_MAX = 1000;
const THUMB_MAX = 480;
const THUMB_QUALITY = 75;
const META_FILE = '.meta.json';
const KEEP_FILE = '.gitkeep';
// 与 website 深链 / Worker 校验保持一致的 sub-id 规范格式
const SUB_ID_RE = /^sub-\d+(-\d+)?$/;
// website config.ts 中该一级键名为「生产/合成」，目录物化时去斜杠存储
const MAIN_ALIASES = { '生产/合成': '生产合成' };
const FALLBACK_MAIN = '其他杂物';

// ---------- 标签树 ----------

const TAG_CONFIG = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts/config.snapshot.json'), 'utf-8'),
).TAG_CONFIG;

function dirName(tag) {
  return tag.replace(/\//g, '-');
}

// 标签树节点 {tag, rel, depth, ancestors}，按 config 书写顺序排列
const TAG_NODES = [];
for (const [main, value] of Object.entries(TAG_CONFIG)) {
  TAG_NODES.push({ tag: main, rel: dirName(main), depth: 1, ancestors: [] });
  if (Array.isArray(value)) {
    for (const leaf of value) {
      TAG_NODES.push({ tag: leaf, rel: `${dirName(main)}/${dirName(leaf)}`, depth: 2, ancestors: [main] });
    }
  } else {
    for (const [sub, leaves] of Object.entries(value)) {
      TAG_NODES.push({ tag: sub, rel: `${dirName(main)}/${dirName(sub)}`, depth: 2, ancestors: [main] });
      for (const leaf of leaves) {
        TAG_NODES.push({
          tag: leaf,
          rel: `${dirName(main)}/${dirName(sub)}/${dirName(leaf)}`,
          depth: 3,
          ancestors: [main, sub],
        });
      }
    }
  }
}

// 稿件的目标父目录：最深层命中 > 父链支持度 > config 顺序；完全未命中则回退杂项桶
function locateItem(tags) {
  const set = new Set(tags);
  for (const t of tags) {
    if (MAIN_ALIASES[t]) set.add(MAIN_ALIASES[t]);
  }
  let best = null;
  for (const node of TAG_NODES) {
    if (!set.has(node.tag)) continue;
    const support = node.ancestors.reduce((n, a) => n + (set.has(a) ? 1 : 0), 0);
    if (!best || node.depth > best.node.depth || (node.depth === best.node.depth && support > best.support)) {
      best = { node, support };
    }
  }
  return best ? { rel: best.node.rel, matched: true } : { rel: dirName(FALLBACK_MAIN), matched: false };
}

// ---------- 工具 ----------

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  } catch {
    return [];
  }
}

function posixDir(relDir) {
  const d = path.posix.dirname(relDir);
  return d === '.' ? '' : d;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function pickArchive(files) {
  const matches = files.filter((f) => ARCHIVE_EXTS.some((ext) => f.toLowerCase().endsWith(ext)));
  matches.sort((a, b) => {
    const ai = ARCHIVE_EXTS.findIndex((ext) => a.toLowerCase().endsWith(ext));
    const bi = ARCHIVE_EXTS.findIndex((ext) => b.toLowerCase().endsWith(ext));
    return ai - bi || a.localeCompare(b);
  });
  return matches[0] || '';
}

function loadMeta(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf-8'));
    return m && typeof m.id === 'string' && m.id ? m : null;
  } catch {
    return null;
  }
}

function loadImageCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, '_meta/image-cache.json'), 'utf-8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeMeta(dir, meta) {
  const p = path.join(dir, META_FILE);
  const text = JSON.stringify(meta, null, 2) + '\n';
  let current = '';
  try {
    current = fs.readFileSync(p, 'utf-8');
  } catch {
    current = '';
  }
  if (current !== text) {
    fs.writeFileSync(p, text);
    return true;
  }
  return false;
}

// 首次生成：由 CI/CD 以仓库时间产出 `sub-<epoch 毫秒>`，同毫秒自增避免碰撞
function makeSubId(idOwners, state) {
  let ms = Math.max(Date.now(), state.lastMs + 1);
  while (idOwners.has(`sub-${ms}`)) ms += 1;
  state.lastMs = ms;
  return `sub-${ms}`;
}

// ---------- 扫描 ----------

function walkItems() {
  const items = [];
  const visit = (relBase) => {
    const abs = path.join(ROOT, relBase);
    let entries;
    try {
      entries = fs.readdirSync(abs).filter((e) => !e.startsWith('.'));
    } catch {
      return;
    }
    if (entries.includes('info.json')) {
      let info = null;
      try {
        info = JSON.parse(fs.readFileSync(path.join(abs, 'info.json'), 'utf-8'));
      } catch (e) {
        console.warn(`跳过解析失败: ${relBase}: ${e.message}`);
      }
      items.push({
        relDir: relBase ? relBase.split(path.sep).join('/') : '',
        dir: abs,
        info,
      });
      return;
    }
    for (const e of entries.sort()) {
      if (relBase === '' && RESERVED.includes(e)) continue;
      const childRel = relBase ? path.join(relBase, e) : e;
      const st = fs.statSync(path.join(ROOT, childRel));
      if (st.isDirectory()) visit(childRel);
    }
  };
  visit('');
  return items;
}

// ---------- 落位 ----------

function relocateItems(items) {
  let moved = 0;
  for (const item of items) {
    if (!item.info) continue;
    const tags = Array.isArray(item.info.tags) ? item.info.tags.filter((t) => typeof t === 'string') : [];
    const located = locateItem(tags);
    if (!located.matched) {
      console.warn(`标签未命中任何分类，落入「${FALLBACK_MAIN}」: ${item.relDir}（tags: ${tags.join(' / ') || '空'}）`);
    }
    const targetRel = located.rel;
    if (posixDir(item.relDir) === targetRel) continue;

    const destParent = path.join(ROOT, ...targetRel.split('/'));
    fs.mkdirSync(destParent, { recursive: true });
    const folder = path.posix.basename(item.relDir);
    const dest = path.join(destParent, folder);
    if (fs.existsSync(dest)) throw new Error(`落位冲突：${item.relDir} -> ${targetRel}/${folder}`);
    try {
      fs.renameSync(item.dir, dest);
    } catch {
      fs.cpSync(item.dir, dest, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(item.dir, { recursive: true, force: true });
    }
    console.log(`落位: ${item.relDir} -> ${targetRel}/${folder}`);
    item.dir = dest;
    item.relDir = `${targetRel}/${folder}`;
    moved++;
  }
  return moved;
}

// ---------- 标签目录物化 ----------

function materializeTagDirs() {
  let created = 0;
  for (const node of TAG_NODES) {
    const abs = path.join(ROOT, ...node.rel.split('/'));
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created++;
    }
    if (node.depth < 2) continue;
    const keep = path.join(abs, KEEP_FILE);
    if (!fs.existsSync(keep)) {
      fs.writeFileSync(keep, '');
      created++;
    }
  }
  return created;
}

// ---------- 单稿件构建 ----------

async function buildOne(item, idOwners, idState, imageCache, stats) {
  const { dir, relDir } = item;
  const info = item.info;
  const files = listFiles(dir);

  // 存档 sha256：内容寻址，随版本更新
  const archiveFile = pickArchive(files);
  const sha = archiveFile ? sha256File(path.join(dir, archiveFile)) : '';
  if (!archiveFile) console.warn(`缺少存档文件: ${relDir}`);

  // 稳定 id：已存在则原样保留（main 已预扫描登记）；缺失/损坏时由 CI 生成一次
  let meta = loadMeta(dir);
  if (meta && !SUB_ID_RE.test(meta.id)) {
    console.warn(`.meta.json id 格式非法，重新生成: ${relDir} (${meta.id})`);
    meta = null;
  }
  if (!meta) {
    const id = makeSubId(idOwners, idState);
    meta = { id, sha256: sha };
    idOwners.set(id, relDir);
    writeMeta(dir, meta);
    stats.newMetas++;
    console.log(`生成 .meta.json: ${relDir} (id=${id})`);
  } else if (meta.sha256 !== sha) {
    meta.sha256 = sha;
    writeMeta(dir, meta);
    stats.shaUpdates++;
    console.log(`更新存档 sha256: ${relDir} -> ${sha.slice(0, 12)}…`);
  }

  // 图片派生：以源图内容哈希判定是否重建（CI 全新检出无 mtime 依赖）
  const srcImg = files.find(
    (f) => IMG_EXTS.includes(path.extname(f).toLowerCase()) && f.toLowerCase().startsWith('preview'),
  );
  const previewPath = path.join(dir, 'preview.webp');
  const thumbPath = path.join(dir, 'thumb.webp');
  const srcPath = srcImg ? path.join(dir, srcImg) : '';
  const srcHash = srcImg ? sha256File(srcPath) : '';
  const cached = imageCache[meta.id];
  const sourceChanged = Boolean(srcImg) && (!cached || cached.source !== srcImg || cached.sourceSha256 !== srcHash);
  if (srcImg) {
    imageCache[meta.id] = { source: srcImg, sourceSha256: srcHash };
  } else {
    delete imageCache[meta.id];
  }

  // 详情图统一产出 preview.webp；源图本身就是 preview.webp 时跳过（避免二次有损压缩）
  let previewUpdated = false;
  if (srcImg && srcImg.toLowerCase() !== 'preview.webp' && (sourceChanged || !fs.existsSync(previewPath))) {
    try {
      await sharp(srcPath)
        .resize(PREVIEW_MAX, PREVIEW_MAX, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80, effort: 2 })
        .toFile(previewPath);
      previewUpdated = true;
      stats.previews++;
      console.log(`优化图片: ${relDir}/${srcImg}`);
    } catch (e) {
      console.warn(`图片转换失败 ${relDir}: ${e.message}`);
    }
  } else if (srcImg && srcImg.toLowerCase() === 'preview.webp' && sourceChanged) {
    previewUpdated = true;
  }
  const hasWebp = Boolean(srcImg) && fs.existsSync(previewPath);

  // 卡片缩略图：≤480px webp，站点列表直接使用，避免加载详情大图
  let hasThumb = false;
  if (hasWebp) {
    if (previewUpdated || !fs.existsSync(thumbPath)) {
      try {
        await sharp(previewPath)
          .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: THUMB_QUALITY, effort: 4 })
          .toFile(thumbPath);
        stats.thumbs++;
        console.log(`生成缩略图: ${relDir}/thumb.webp`);
      } catch (e) {
        console.warn(`缩略图生成失败 ${relDir}: ${e.message}`);
      }
    }
    hasThumb = fs.existsSync(thumbPath);
  } else if (fs.existsSync(thumbPath)) {
    fs.rmSync(thumbPath);
    console.log(`清理缩略图: ${relDir}/thumb.webp`);
  }

  const folder = path.posix.basename(relDir);
  const category = posixDir(relDir);
  const prefix = category ? `${category}/${folder}` : folder;
  return {
    id: meta.id,
    name: info.name || folder,
    author: info.author || 'Unknown',
    tags: Array.isArray(info.tags) ? info.tags : [],
    description: info.description || '',
    category,
    preview: hasWebp ? `/content/${prefix}/preview.webp` : '',
    thumb: hasThumb ? `/content/${prefix}/thumb.webp` : '',
    filename: archiveFile,
    sha256: sha,
    folder,
  };
}

// ---------- 主流程 ----------

async function main() {
  console.time('构建耗时');
  const items = walkItems();

  const moved = relocateItems(items);
  const created = materializeTagDirs();

  const idOwners = new Map();
  const idState = { lastMs: 0 };
  for (const it of items) {
    if (!it.info) continue;
    const meta = loadMeta(it.dir);
    if (!meta || !SUB_ID_RE.test(meta.id)) continue;
    if (idOwners.has(meta.id)) throw new Error(`id 重复：${it.relDir} 与 ${idOwners.get(meta.id)} 共用 ${meta.id}`);
    idOwners.set(meta.id, it.relDir);
    const m = /^sub-(\d+)/.exec(meta.id);
    if (m) idState.lastMs = Math.max(idState.lastMs, Number(m[1]));
  }

  const stats = { newMetas: 0, shaUpdates: 0, previews: 0, thumbs: 0 };
  const imageCache = loadImageCache();
  const seenIds = new Set();
  const entries = [];
  for (const it of items) {
    if (!it.info) continue;
    const r = await buildOne(it, idOwners, idState, imageCache, stats);
    entries.push(r);
    seenIds.add(r.id);
  }
  for (const id of Object.keys(imageCache)) {
    if (!seenIds.has(id)) delete imageCache[id];
  }
  entries.sort((a, b) => a.folder.localeCompare(b.folder, 'zh-Hans-CN'));

  // 全量索引
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const indexEntries = entries.map(({ folder, ...rest }) => rest);
  fs.writeFileSync(path.join(ROOT, 'data/index.json'), JSON.stringify(indexEntries, null, 2));

  // 按标签分片索引
  const tagDir = path.join(ROOT, 'data/tags');
  fs.rmSync(tagDir, { recursive: true, force: true });
  fs.mkdirSync(tagDir, { recursive: true });
  for (const t of new Set(entries.flatMap((r) => r.tags))) {
    const shard = indexEntries.filter((r) => r.tags.includes(t));
    fs.writeFileSync(path.join(tagDir, encodeURIComponent(t) + '.json'), JSON.stringify(shard, null, 2));
  }

  // Worker 用稳定 id 定位表：记录真实相对路径与文件清单
  fs.mkdirSync(path.join(ROOT, '_meta'), { recursive: true });
  const byId = {};
  for (const it of items) {
    if (!it.info) continue;
    const meta = loadMeta(it.dir);
    if (!meta) continue;
    const entry = {
      name: it.info.name || path.posix.basename(it.relDir),
      category: posixDir(it.relDir),
      files: listFiles(it.dir),
      sha256: meta.sha256 || '',
    };
    byId[meta.id] = entry;
  }
  fs.writeFileSync(path.join(ROOT, '_meta/index-by-id.json'), JSON.stringify(byId, null, 2));

  // 图片派生缓存：源图内容哈希，保证 CI 全新检出也能正确增量重建
  const sortedCache = {};
  for (const id of Object.keys(imageCache).sort()) sortedCache[id] = imageCache[id];
  fs.writeFileSync(path.join(ROOT, '_meta/image-cache.json'), JSON.stringify(sortedCache, null, 2) + '\n');

  console.log(
    `构建完成：${entries.length} 个稿件；落位 ${moved} 个；新建 .meta.json ${stats.newMetas} 份` +
      `；sha256 更新 ${stats.shaUpdates} 个；重建预览 ${stats.previews} 张、缩略图 ${stats.thumbs} 张` +
      `；标签分片 ${fs.readdirSync(tagDir).length} 份；新建目录/占位 ${created} 处`,
  );
  console.timeEnd('构建耗时');
}

main();
