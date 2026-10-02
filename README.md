# 观测夜排程工作台 (Night Visibility Workbench)

本地运行的全栈 TypeScript 应用：为某个站点、某个夜晚安排天体拍摄块。
后端用 [astronomy-engine](https://github.com/cosinekitty/astronomy) 做太阳/目标位置计算，
前端是 React 时间轴编辑器，持久化在本机 SQLite。

## 启动

```bash
npm install

# 开发模式（后端 :8787 + 前端 Vite :5173，/api 自动代理）
npm run dev
# 打开 http://localhost:5173

# 生产模式（构建后由后端单端口托管）
npm run build
npm start          # 打开 http://localhost:8787
```

## 测试

```bash
npm test           # server: 天文计算 + API(并发/原子性); web: 计划编辑纯逻辑
```

## 结构

- `server/` — Express + better-sqlite3 + astronomy-engine
  - `POST /api/compute/night` — 无状态夜间计算：太阳天文夜边界、各目标高度曲线与
    可观测窗口（高度 ≥ 阈值 且 太阳 ≤ −18°)。响应**回显**全部输入参数供核对。
  - `POST /api/plans/ensure` / `GET /api/plans/:id` — 读取某站点某本地日期的计划。
  - `PUT /api/plans/:id/blocks` — 原子替换全部块。携带 `baseVersion` 乐观锁：
    版本不符返回 `409` 及服务器当前状态；保存前**服务端重新校验**
    （目标全程 ≥ 最低高度、在黑夜内、块间不重叠），违规返回 `422`，
    任何失败都不会留下写了一半的计划（事务）。
- `web/` — React + Vite
  - 时间轴：夜段阴影、各目标高度曲线、选中目标可观测窗口、可拖拽/缩放的拍摄块。
  - 拖动即时给出重叠/可见性反馈；未保存修改与服务端确认状态明确区分。
  - 计算请求带序号守卫 + 参数回显比对，切换站点/日期后晚到的旧响应会被丢弃。

## 约定

- 所有块以 **UTC 毫秒**存储；界面按站点 IANA 时区显示本地时间，跨午夜、
  跨夏令时不会漂移或截断。
- 目标 RA/Dec 按历元平位置直接用于高度计算（岁差量级对排程可忽略）。
- 同一计划被两个窗口同时编辑时，后提交者收到 409 与服务器现状，
  可一键加载最新版本，不会无声覆盖。
