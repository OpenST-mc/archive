# OpenST Archive

OpenST（Minecraft 储电社区）稿件数据库。由 `OpenST-mc/website` 仓库的 `archive/archive/**`
以保留 git 历史的方式整体迁移而来（2026-08 重构）。

## 目录结构

- `<分类>/<稿件目录>/`：每个规范化主分类一个文件夹，其下为各稿件
  - `info.json`：元数据（name / author / tags / description）
  - `preview.*` + `preview.webp`：预览原图与构建产物
  - `*.litematic` 或 `*.zip`：投影存档
- `data/index.json`：全量稿件条目（CI 构建产物）
- `data/tags/<标签>.json`：按标签分片的浏览索引（CI 构建产物）
- `_meta/index-by-id.json`：id → {category, files[]} 定位表，供网站后端 API 使用

## 主分类规则

一个稿件只归入一个主分类目录；全部标签仍完整保留在 info.json 与索引条目中，
站点按标签筛选通过 data/tags 分片实现，不依赖物理目录。

**目录体系严格对齐站点前端 `archive/scripts/config.js` 的 `TAG_CONFIG` 一级分类**
（版本维度不作目录）：

| 目录 | config.js 一级键 | 备注 |
|---|---|---|
| 非编码存储科技 / 潜影盒处理 / 编码存储科技 / 其他杂物 | 同名一级键 | 目录名与键名完全一致 |
| 生产合成 | 生产/合成 | 键名含 `/` 不能作目录名，去斜杠存储 |

归类算法（按顺序命中即停）：

1. 稿件标签精确等于某二级类名 → 归入该二级所属一级
2. 「生产/合成」的一级数组词（合成站、合成器相关）精确命中
3. 标签包含某个三级关键词（如「自适应打包」含于「潜影盒打包机」组）
4. 兜底：归入「其他杂物」（config.js 本身将其定义为杂项桶）

## CI/CD

`.github/workflows/build.yml`：push 触发 → 重建索引与 webp 预览图并提交回本仓库；
产物有实际变更时向 `OpenST-mc/website` 发送 `repository_dispatch(archive-update)`，
由网站侧流水线更新子模块指针并触发部署。

需要配置的 Secret：

- `SITE_DISPATCH_TOKEN`：可访问 OpenST-mc/website 的 PAT（classic，repo 权限）

## 本地构建

```bash
npm install
npm run build
```
