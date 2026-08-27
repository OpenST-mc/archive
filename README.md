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

归类优先级（命中即停）：

| 分类 | 标签命中 |
|---|---|
| 地狱门加载器 | 地狱门加载器 |
| 不可堆叠 | 不可堆叠分类 / 不可堆叠分离 / 不可堆叠相关 |
| 分盒分类 | 潜影盒分类相关、潜影盒分类、潜影盒分盒器、分盒器相关、理想分盒器 (矿车)、车头及拐弯设计 (Keygen & U-turn)、多物品分类 (MIS)、多物品相关 |
| 打包机 | 潜影盒打包机、自适应打包、堆分打包、可访问打包、合成站、生产/合成 |
| 整流器 | 矿车整流器、堆分整流器、整流器 |
| 展示类 | 潜影盒展示、细雪展示、自出盒展示、无残留展示 |
| 大宗仓库 | 编码大宗仓库、编码大宗、远程大宗、四边形大宗、编码四边形大宗、盒分大宗、全物品仓库、多物品仓库、不满盒临时存储、仓库成品 |
| 全物品 | 全物品单片、编码全物品单片、其他编码单片、10箱单片、无实体输入 |
| 编码解码 | 二进制、解码器、编码器、其他编码器 |

标签全部未命中时按名称关键词兜底（顺序同上），仍未命中归入「其他」。

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
