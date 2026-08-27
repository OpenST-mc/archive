// 稿件库构建脚本：扫描分类目录，压缩预览图并生成索引产物
// 产物：
//   _meta/index-by-id.json   id -> {category, files[]}（供网站 Worker 定位真实路径）
//   data/index.json          全量稿件条目数组（数据库主文件）
//   data/tags/<标签>.json    每个标签一份的浏览索引
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
const RESERVED = ['scripts', 'data', '_meta', 'docs', 'node_modules'];

function isReserved(name) {
  return name.startsWith('.') || RESERVED.includes(name);
}

function walkItemDirs() {
  const items = [];
  const cats = fs.readdirSync(ROOT)
    .filter(d => fs.statSync(path.join(ROOT, d)).isDirectory() && !isReserved(d));
  for (const cat of cats.sort()) {
    for (const id of fs.readdirSync(path.join(ROOT, cat)).sort()) {
      const dir = path.join(ROOT, cat, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      items.push({ category: cat, id, dir });
    }
  }
  return items;
}

async function buildOne(item) {
  const { category, id, dir } = item;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf-8'));
  } catch (e) {
    console.warn(`跳过无 info.json 或解析失败: ${category}/${id}: ${e.message}`);
    return null;
  }

  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  const srcImg = files.find(f =>
    IMG_EXTS.includes(path.extname(f).toLowerCase()) &&
    f.toLowerCase().startsWith('preview'));

  // 预览图统一产出 preview.webp，仅在原图比现有产物新时重转
  let hasWebp = false;
  if (srcImg) {
    const srcPath = path.join(dir, srcImg);
    const webpPath = path.join(dir, 'preview.webp');
    try {
      let stale = true;
      try {
        stale = fs.statSync(srcPath).mtime > fs.statSync(webpPath).mtime;
      } catch { stale = true; }
      if (stale && path.extname(srcImg).toLowerCase() !== '.webp') {
        await sharp(srcPath)
          .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80, effort: 2 })
          .toFile(webpPath);
        console.log(`优化图片: ${category}/${id}/${srcImg}`);
      } else if (!fs.existsSync(webpPath)) {
        await sharp(srcPath)
          .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80, effort: 2 })
          .toFile(webpPath);
        console.log(`优化图片: ${category}/${id}/${srcImg}`);
      }
      hasWebp = fs.existsSync(webpPath);
    } catch (e) {
      console.warn(`图片转换失败 ${category}/${id}: ${e.message}`);
    }
  }

  const archiveFile = files.find(f =>
    ['.litematic', '.zip', '.rar'].some(ext => f.toLowerCase().endsWith(ext)));

  return {
    id,
    name: info.name || id,
    author: info.author || 'Unknown',
    tags: info.tags || [],
    description: info.description || '',
    preview: hasWebp ? `${category}/${id}/preview.webp` : '',
    filename: archiveFile || '',
    sub_id: info.id || ''
  };
}

async function main() {
  console.time('构建耗时');
  const items = walkItemDirs();
  const entries = [];
  for (const it of items) {
    const r = await buildOne(it);
    if (r) entries.push(r);
  }
  entries.sort((a, b) => a.id.localeCompare(b.id, 'zh-Hans-CN'));

  // 全量索引
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data/index.json'), JSON.stringify(entries, null, 2));

  // 按标签分片索引
  const tagDir = path.join(ROOT, 'data/tags');
  fs.rmSync(tagDir, { recursive: true, force: true });
  fs.mkdirSync(tagDir, { recursive: true });
  for (const t of new Set(entries.flatMap(r => r.tags))) {
    const shard = entries.filter(r => r.tags.includes(t));
    fs.writeFileSync(path.join(tagDir, encodeURIComponent(t) + '.json'),
      JSON.stringify(shard, null, 2));
  }

  // Worker 用 id 定位表：记录真实分类路径与文件清单
  fs.mkdirSync(path.join(ROOT, '_meta'), { recursive: true });
  const byId = {};
  for (const it of items) {
    const files = fs.readdirSync(it.dir).filter(f => !f.startsWith('.'));
    byId[it.id] = { category: it.category, files };
  }
  fs.writeFileSync(path.join(ROOT, '_meta/index-by-id.json'), JSON.stringify(byId, null, 2));

  console.log(`构建完成：${entries.length} 个稿件，标签分片 ${fs.readdirSync(tagDir).length} 份`);
  console.timeEnd('构建耗时');
}

main();
