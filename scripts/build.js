// 稿件库构建脚本：递归扫描分类目录，压缩预览图并生成索引产物
// 目录约定（对齐站点 config.js TAG_CONFIG）：
//   <一级分类>/<二级标签>/<稿件目录>/info.json     —— 标准两层
//   <一级分类>/<稿件目录>/info.json               —— 无明确二级时的特例，允许
// 产物：
//   _meta/index-by-id.json   id -> {category, files[]}（category 为含斜杠的相对父路径）
//   data/index.json          全量稿件条目数组
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

// 深度优先收集所有含 info.json 的叶子目录；返回 {category(相对父路径), id, dir}
function walkItems() {
  const items = [];
  const visit = (relBase) => {
    const abs = path.join(ROOT, relBase);
    let entries;
    try {
      entries = fs.readdirSync(abs).filter(e => !e.startsWith('.'));
    } catch { return; }
    if (entries.includes('info.json')) {
      const dirName = path.posix.basename(relBase);
      const parent = path.posix.dirname(relBase);
      items.push({
        category: parent === '.' ? '' : parent,
        id: dirName,
        dir: abs
      });
      // 目录本身即稿件时不再深入
      return;
    }
    for (const e of entries.sort()) {
      const childRel = relBase ? `${relBase}/${e}` : e;
      const st = fs.statSync(path.join(ROOT, childRel));
      if (st.isDirectory() && !isReserved(e)) visit(childRel);
    }
  };
  visit('');
  return items;
}

async function buildOne(item) {
  const { category, id, dir } = item;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, 'info.json'), 'utf-8'));
  } catch (e) {
    console.warn(`跳过解析失败: ${category}/${id}: ${e.message}`);
    return null;
  }

  const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
  const srcImg = files.find(f =>
    IMG_EXTS.includes(path.extname(f).toLowerCase()) &&
    f.toLowerCase().startsWith('preview'));

  // 预览图统一产出 preview.webp，仅在原图比现有产物新或缺省时重转
  let hasWebp = false;
  if (srcImg) {
    const srcPath = path.join(dir, srcImg);
    const webpPath = path.join(dir, 'preview.webp');
    try {
      let stale = true;
      try {
        stale = fs.statSync(srcPath).mtime > fs.statSync(webpPath).mtime;
      } catch { stale = true; }
      if (stale || !fs.existsSync(webpPath)) {
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

  const prefix = category ? `${category}/${id}` : id;
  return {
    id,
    name: info.name || id,
    author: info.author || 'Unknown',
    tags: info.tags || [],
    description: info.description || '',
    category,
    preview: hasWebp ? `/content/${prefix}/preview.webp` : '',
    filename: archiveFile || '',
    sub_id: info.id || ''
  };
}

async function main() {
  console.time('构建耗时');
  const items = walkItems();
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

  // Worker 用 id 定位表：记录真实相对路径与文件清单
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
