# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：按站位布设样带，逐条记录底质、珊瑚分类覆盖与鱼类计数，并评定白化等级。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore`（含观察员计数与实验室复核分账） |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord | 新建/编辑/删除礁区，按保护区状态与面积分档筛选，卡片汇总站位数、样带数与本礁区平均白化指数 |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验（纬度 ±90、经度 ±180）并显示度分秒，按水深区间筛选，展开样带 |
| `/sites/:id/belts` | 样带布设 | Belt、Site、CoralRecord、FishCount | 布设样带（编号、长度、朝向、调查日期、调查人），回显已录记录数、覆盖率与白化指数，朝向排序校验 |
| `/belts/:id/corals` | 底质与珊瑚分类计数 | CoralRecord、Belt | 按属名与形态逐条录入覆盖长度与白化等级，汇总覆盖率、白化指数、白化占比与等级分布，批量粘贴、批量改级 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数（观察员台账） | FishCount、Belt、LabReviewSheet | 按科名与体长段录入数量、按类别筛选与批量改类别；显示复核状态与实验室改判，待复核 / 待复检记录不折算密度，待复检后改动数量或体长段自动退回待复核 |
| `/lab/reviews` | 实验室镜检复核台 | LabReviewSheet、Belt、FishCount | 批量送达复核单（标本号、复核体长段、复核结论），按样带编号 + 科名对账，对不上挂起等人定或只重试实验室这份，同批复核单重送幂等 |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 | 白化等级分布与按样带/按礁区汇总（鱼类密度仅采纳已复核计数）、结构版本查看、全量 JSON 导入导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # reef / site / belt / coralRecord / fishCount / labReview / filter
        ├── stores/             # reefStore / beltStore / surveyStore
        ├── components/common/  # BleachTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCoverage
        ├── pages/              # ReefList / SiteList / BeltBoard / CoralEntry / FishEntry / LabReview / CoverageView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # bleach.ts（白化与覆盖度算法）/ db.ts（Dexie 封装）/ export.ts（导入导出与结论）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表（六张）**：`reefs`（礁区）、`sites`（站位）、`belts`（样带）、`corals`（珊瑚记录）、`fishes`（**观察员**鱼类与无脊椎动物计数）、`labReviews`（**实验室**镜检复核单）。
- **观察员 / 实验室分账口径**：
  - 鱼类计数（数量、体长段）归观察员的 `fishes`；标本号、复核体长段与复核结论只认实验室的 `labReviews`，观察员补记不顶回实验室改判。
  - 计数有三种复核状态：**待复核**（新录 / 补记，或待复检后又被改动数量、体长段）、**待复检**（实验室挂出）、**已复核**。只有「已复核」的记录才折算密度进汇总。
  - 复核单按「样带编号 + 科名」与观察员台账对账：唯一样带 + 唯一同科记录才落账；编号不唯一或一科多条无法定位时复核单**挂起等人定**；挂起后重试只动实验室这份，观察员记录保持不变。
  - 复核单按「批次号 + 样带编号 + 科名 + 标本号」幂等落账：**同一批复核单重送不多出结论**，挂起单仅重试对账。
- **升级迁移**：`db.version(1)` 保留初版结构；`v2` 补齐索引并回填历史必填字段；`db.version(3).stores(...).upgrade(...)` 新增 `labReviews` 表与 `fishes.reviewStatus` 索引——旧数据没记复核状态，升级时按现有记录补一版（计数统一补「已复核」，密度口径与升级前一致，并为每条现有计数回填一张「符合」复核单）。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 个礁区 / 4 个站位 / 5 条样带 / 14 条珊瑚记录 / 15 条计数 / 14 张复核单），覆盖「无 / 轻 / 中 / 重 / 死亡」全部白化等级与「待复核 / 待复检 / 已复核 / 挂起」全部对账状态，保证每个页面打开都有内容、层级路由也能命中真实 id。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新，页面只读消费。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%；白化指数 = 按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4），并按指数换算总体等级；鱼类密度 = 计数 / （样带长度 × 1 m）× 100（尾/100 m²），**仅统计已复核计数，体长段以实验室复核单改判为准**。
- **备份与恢复**：`/coverage` 页可导出包含六张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；读取 v2 旧备份（无 `labReviews` / 无复核状态）时自动按「已复核」补一版；备份时间写入 `localStorage`，页脚与汇总页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
