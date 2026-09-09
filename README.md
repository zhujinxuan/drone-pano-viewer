# drone-pano-viewer

无人机全景照片本地查看器——在浏览器中浏览、量测、标注风电场踏勘拍摄的 360° 等距柱状全景，无需上传云端。

## 功能

- **键盘批量过片**——数百张全景装入播放列表，`[` / `]` 切换，刷新后自动回到上次位置
- **实时量测 HUD**——方位角、俯角、视场角、准星所指地面点的平地距离，10 Hz 刷新
- **全景内标注**——在全景画面上直接打点、画线、画面；顶点投影为 WGS84 坐标，逐顶点附带误差估计
- **GeoJSON 发件箱**——标注持久化到单个 `annotations.geojson` 文件，任何程序或 AI agent 可直接读取（单写者、消费端只读）
- **北偏置校正**——旋转球体补偿拼接偏转，罗盘、HUD、量测全部联动
- **DJI EXIF/XMP 原生解析**——定位、高度、拍摄元数据在客户端解析；geohash8 文件名兼作稳定标识与粗定位索引

基于 [photo-sphere-viewer](https://github.com/mistic100/Photo-Sphere-Viewer)（MIT）构建。通过本地 Vite 开发服务器在浏览器中运行——数据不出本机。

## 安装

### 前置条件

- [Node.js](https://nodejs.org/) ≥ 18
- 一个存放 2:1 等距柱状全景 JPG 的目录（如 DJI 机内合成 `_V.JPG`，约 14400×7200）

### 人工安装

```bash
git clone https://github.com/zhujinxuan/drone-pano-viewer.git ~/.agents/skills/drone-pano-viewer
cd ~/.agents/skills/drone-pano-viewer/app
npm install
```

### AI agent 安装

打开你的 AI 编程助手（omp、Claude Code、Cursor 等），告诉它：

> **"从 https://github.com/zhujinxuan/drone-pano-viewer 安装 drone-pano-viewer 技能"**

agent 会自动克隆到 `~/.agents/skills/drone-pano-viewer` 并执行 `npm install`。安装完成后 agent 读取 `SKILL.md` 获取完整的调用契约——人不需要读 `SKILL.md`，本 README 覆盖了你需要知道的一切。

## 使用

```bash
cd ~/.agents/skills/drone-pano-viewer/app
npm run pano -- view /path/to/panoramas
```

浏览器自动打开。用 `[` / `]` 在照片间切换。

### 常用选项

```bash
# 按 geohash8 标识指定起始全景
npm run pano -- view /path/to/panos --id wzbjs1gm

# 从距指定坐标最近的全景开始
npm run pano -- view /path/to/panos --near 124.5,45.2

# 按播放列表批量评审
npm run pano -- view /path/to/panos --playlist my-review.json

# 指定标注文件路径
npm run pano -- view /path/to/panos --annotations /path/to/labels.geojson
```

### 播放列表格式

```json
[
  { "id": "wzbjs1gm", "title": "FS03 · 机位北侧" },
  { "id": "wzbjsr6x", "title": "FS07 · 电力线走廊" }
]
```

ID 必须匹配全景文件名词干（`.jpg` 前的 8 位 geohash）。未知 ID 会立即报错。

### 文件命名

| 模式 | 含义 |
|------|------|
| `<geohash8>.jpg` | 标准——词干即全景 ID，解码得 ±20 m 位置 |
| `nogps-<名称>.jpg` | 无 GPS 定位——只能通过 `--id` 访问，不支持 `--near` |

目录可任意嵌套（如 `{目录}/{日期}/{geohash8}.jpg`），扫描递归进行。

## 工作原理

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  命令行入口   │────▶│  Vite 中间件      │────▶│  浏览器查看器         │
│  pano view   │     │  GET /api/photos  │     │  photo-sphere-viewer │
│  pano list   │     │  标注 GET / POST   │     │  HUD · 罗盘 · EXIF   │
└─────────────┘     └─────────────────┘     └──────────┬──────────┘
                             │                           │
                    ┌────────▼─────────┐        ┌────────▼──────────┐
                    │ annotations.json  │◀───────│  人：交互标注       │
                    │ （唯一状态文件）    │        └───────────────────┘
                    ────────┬─────────┘
                             │ 只读消费
                    ┌────────▼─────────┐
                    │  AI agent / GIS   │
                    │  摄取 · 入库 · 分析 │
                    └──────────────────┘
```

服务器从不解析图像——EXIF/XMP 提取完全在浏览器端完成。标注文件是唯一的状态载体；没有数据库、没有后端服务、没有账号体系。

## 仓库结构

```
app/                    Vite + React 应用
  cli.ts                命令行入口（pano view / pano list）
  src/                  React 组件、查看器逻辑、EXIF 解析
  package.json          依赖与脚本
docs/adr/               架构决策记录
CONTEXT.md              领域词汇表
SKILL.md                Agent 调用契约（参数、协议、文件规则）
AGENTS.md               Agent 工作区配置
```

## 已知限制

- **平地假设**——距离量测假定地面在起飞高程处水平；丘陵场址精度下降，浅俯角时尤为明显
- **要求 2:1 纵横比**——非等距柱状投影的全景在球面上会畸变
- **单写者**——两个浏览器标签页同时编辑标注会丢失更新（原子重命名，最后写入胜出）
- **尚无 RTK 实测验证**——误差模型参数为设计值，实地标定列入计划

## 许可证

MIT
