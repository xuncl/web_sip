# CLAUDE.md

> Web SIP v1.0 — 自我提升平台

## 项目概述

**web_sip**：用游戏化 SIP 得分机制激励每日坚持的自我管理工具。

托管于 GitHub Pages（[xuncl.github.io/web_sip](https://xuncl.github.io/web_sip)），纯静态 HTML + 原生 JS，通过 GitHub API 读写 JSON 文件持久化数据，无需后端。

## 技术架构

| 层 | 技术 | 
|------|------|
| 前端 | 原生 HTML5 + CSS3 + JavaScript（无框架，零依赖） |
| 数据 | GitHub 仓库 JSON 文件（`data/YYYY-MM-DD.json`） |
| 存储 | 读取走 `raw.githubusercontent.com`（零 API 额度），写入走 `api.github.com` |
| 认证 | GitHub Fine-grained Personal Access Token（`repo` scope），存 `localStorage` |
| 部署 | GitHub Pages（`main` 分支 `/` 根目录） |

## 项目结构

```
web_sip/
├── index.html              # SPA 主入口
├── css/
│   └── style.css           # 移动端优先样式
├── js/
│   ├── config.js           # 全局配置（仓库名、API 端点）
│   ├── template.js         # 9 条初始任务模板
│   ├── sip-engine.js       # SIP 计算引擎（纯函数）
│   ├── storage.js          # localStorage 操作
│   ├── github-api.js       # GitHub API 读写封装
│   ├── state.js            # 状态管理（观察者模式）
│   ├── ui.js               # DOM 渲染 + 事件绑定
│   └── app.js              # 主入口，协调所有模块
├── data/
│   └── .gitkeep
├── CLAUDE.md
├── CHANGELOG.md
└── .gitignore
```

依赖方向：`app.js → ui.js → state.js → (sip-engine.js | github-api.js | storage.js)`

## 工作规矩

1. **语言**：尽量使用中文交流
2. **Python 命令**：使用 `python`，不要用 `python3`
3. **先规划后执行**：新功能必须先出规划并确认

## 工作流程

```
python -m http.server 8080      # 本地开发
git push origin main            # 部署到 GitHub Pages
```

## v1.0 功能清单

### SIP 得分引擎
- 每条任务三个参数：初始分值、增加分值、最高分值
- 完成 → 当日加分，次日 sipScore 递增（不超封顶）
- 未完成 + 关键任务 → 当日扣分，次日重置为初始分值
- 未完成 + 非关键任务 → 豁免（不扣不加，分值保持）
- 累计总分下限为 0

### 9 条初始任务
| 任务 | 初始 | 增量 | 封顶 | 类型 |
|------|:---:|:---:|:---:|------|
| 工作 | 2 | 1 | 15 | 🔴 关键 |
| 事业 | 2 | 1 | 15 | 🔴 关键 |
| 自我提升 | 2 | 1 | 15 | 🔴 关键 |
| 家庭生活 | 2 | 1 | 10 | 非关键 |
| 主动性 | 2 | 1 | 10 | 非关键 |
| 锻炼节食 | 2 | 1 | 10 | 非关键 |
| 早起 | 2 | 1 | 5 | 非关键 |
| 日摘 | 2 | 1 | 5 | 非关键 |
| 思考冥想 | 2 | 1 | 5 | 非关键 |

### 数据持久化
- 每日 JSON 存储于 GitHub 仓库 `data/YYYY-MM-DD.json`
- 打开自动加载当天数据，不存在时从历史推导
- 点击「更新到 GitHub」保存

### 严格模式
- 中断 1~30 天：逐日模拟全部未完成，关键任务扣分+重置，JSON 自动补录
- 中断 >30 天：总分归零，重新开始

### 日期导航
- ◀ ▶ 浏览任意日期
- 修改历史数据后自动级联更新到今天
- 历史/今天标签区分

### 其他
- 移动端优先响应式布局
- 4 种任务卡片视觉状态（完成/关键未完成/豁免/正常）
- 离线缓存兜底
- Token 管理（创建链接、本地存储、失效检测）
