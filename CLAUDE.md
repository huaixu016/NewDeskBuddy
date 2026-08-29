# CLAUDE.md

NewDeskBuddy：桌面宠物（Tauri 2 重构版）。Rust 后端 + TypeScript/Vite 前端（无框架）。
对应 Python 版 DesktopPet 的「默认模式 + 噜噜模式 + 工作模式」，三个模式均已迁移。

## 常用命令

```cmd
npm install
npm run tauri dev      # 开发运行（CWD 在 src-tauri，config.txt/debug.log 也在这里）
npm run tauri build    # 打 NSIS 安装包
npx tsc --noEmit       # 前端类型检查
npx vite build         # 前端构建（四入口：index/menu/work/dialog）
cargo check            # 在 src-tauri/ 下检查 Rust 侧
```

## 架构

四个窗口：

- **pet**（`index.html` → `main.ts` → `app.ts`）：透明无边框置顶窗，canvas 逐帧绘制雪碧图，承载全部模式状态机与鼠标交互。`tauri.conf.json` 里 `visible: false`，`startApp()` 全部就绪（配置加载 + 雪碧图预载 + 首帧 + 布局）后才 `win.show()`，避免"先见键盘数、几秒后才见角色"。启动失败路径在 `main.ts` 里自己把窗口拉出来显示错误。**工作模式下隐藏，由 `applyMode('work')` 收口**。
- **menu**（`menu.html` → `menu-window.ts`）：Rust 侧启动即创建的常驻隐藏悬浮窗。右键时（pet 或 work 窗口）调 `open_menu_window` 推 `menu-state` 事件（带一份 pending 兜底）；选中项经全局 `menu-action` 事件回传 pet 分发；失焦自动隐藏。工作模式下菜单多出「修改工作配置 / 新增备忘录 / 新增计划」三项（条数满 50 时置灰）。
- **work**（`work.html` → `work.ts`）：工作模式面板，常驻隐藏。数据由 pet 窗口经 `work-state`（完整状态）与 `work-tick`（每秒轻量刷新）事件下发；用户交互经 `work-ui` 事件回传 pet（type：ready/scale/opacity/page/period-click/memo-toggle/memo-click/plan-click/menu，除 ready 外都附带面板中心坐标 cx/cy 供弹窗定位）。
- **dialog**（`dialog.html` → `dialog.ts`）：四个弹窗共用的常驻隐藏窗（work-config / memo / plan / period）。内容与位置由 pet 经 `dialog-state` 事件下发（带配置快照与中心坐标），编辑结果经 `dialog-result`（action：save/delete/apply/cancel）回传 pet 落盘；`dialog-close` 事件收起。

事件流：右键 → `open_menu_window` → `menu-state` → 菜单渲染/量尺寸/定位 → 点击 → `menu-action` → `app.ts handleMenuAction`。
工作模式：`applyMode('work')` → `enterWorkMode()`（load_memos/plans + `work-state` show:true）→ 面板 `showWindow()` 亮相；面板 ready 事件晚于 applyMode 时由 `handleWorkUi('ready')` 补推。

全局键盘计数：Rust `keyboard.rs` 的 `WH_KEYBOARD_LL` 钩子（独立线程消息循环），长按自动重复只计一次，经 `key-pressed` 事件推给前端（pet 与 work 各自监听维护显示）。计数不持久化。

## 模块速查

| 文件 | 职责 |
| --- | --- |
| `src/app.ts` | 模式状态机、鼠标交互（单击/双击/拖拽/降落）、布局、菜单动作分发；**工作模式数据中枢**（memos/plans 内存副本、每秒 tick、弹窗结果落盘） |
| `src/animator.ts` | canvas 逐帧动画器（`play` / `playOnce`） |
| `src/sprites.ts` | 雪碧图声明（文件/行列/尺寸）+ 预载 + 失败重载 |
| `src/window.ts` | 窗口移动/缩放/边界收敛 + OutBounce 降落动画（pet 窗口专用；work/dialog 各自直接用 `getCurrentWindow()`） |
| `src/menu-window.ts` / `src/menu.css` | 右键菜单悬浮窗（白底黑字，噜噜互动为悬停右侧弹出的子菜单） |
| `src/work.ts` / `src/work.css` / `work.html` | 工作模式面板（纯视图层，数据由 pet 下发） |
| `src/dialog.ts` / `src/dialog.css` / `dialog.html` | 四合一弹窗窗（工作配置/备忘录/计划/生理期） |
| `src/work-logic.ts` | 工作模式纯逻辑：生理期周期计算、计划状态推导、日赚累计、信息卡文案汇总 |
| `src/config.ts` | 配置前端包装；后端 `config.rs` 负责真正的读写与容错 |
| `src-tauri/src/main.rs` | 入口、窗口创建（menu/work/dialog）、菜单事件路由、退出路径 |
| `src-tauri/src/keyboard.rs` | 全局键盘钩子 |
| `src-tauri/src/store.rs` | memos.json / plans.json 的读写与收敛（条数上限 50、文案截断、id 去重、计划按时间排序） |

## 关键设计与已知陷阱（改代码前必读）

### 动画与雪碧图

- **canvas 而非 CSS background**：两张雪碧图互换时合成器可能出现一帧透明闪屏，canvas `drawImage` 同步出帧无此问题。
- **`animator` 的作废机制**：每次 `play()` 递增 `playbackId`；`playOnce` 的结束回调只在 `playbackId` 未变时触发。切序列/重复播放都会自动作废旧回调，改动时不要破坏这个链。
- **WebView2 大图 `img.decode()` 偶发失败**（文件本身完好）。`sprites.ts` 的预载：先等 `onload`，decode 失败重试 3 次，仍失败但像素已加载（`complete && naturalWidth>0`）照样入缓存（drawImage 绘制时同步解码）。必须**逐张顺序解码**，Promise.all 并发会让部分图片被判失败。播放失败时 `playLuluReaction` 会调 `retryLoad()` 后台补载，下次触发同一动作即可恢复。
- 雪碧图行列数在 `sprites.ts` 声明，须与实际图片尺寸匹配。噜噜序列是降采样 + WebP 产物：单帧 280px（显示 140 的 2 倍超采样）、q90，由 `node scripts/convert-sprites.mjs` 生成（依赖 devDependency sharp）；原 PNG 备份在 `assets-png-backup/`。两套猫单帧只有 240px，保持 PNG 原样。换新素材时重跑脚本即可，行列数不变、代码无需改动。

### 窗口与交互（app.ts / window.ts）

- **串行队列 `enqueue`**：模式切换、双击换装、按键数开关都进队列；裸 `void` 起的 async 布局任务交叠会把窗口尺寸改成错误模式的大小。新增会 `resizeTo` 的入口一律走 `enqueue`。
- **`resizeTo` 有 lastSize 缓存**：同尺寸跳过（透明窗口每次 set_size 都整体重合成，反应期间反复触发会闪）。
- **`onPointerUp` 在进 `await` 前必须同步清 `pressPos`/`isDragging`**：`maybeDrop`/`backToIdle` 期间用户可能已开始下一次按下，收尾时再清会抹掉新状态。
- **随机心情定时器**：`autoMood` 跳过本次换心情（正在反应/拖拽）时也必须重排下一次，否则自动切情绪永久停摆。
- **`luluReacting` 不会卡死**：序列不可用时 `playOnce` 返回 false，`playLuluReaction` 会立即回落待机，不能把它挂起来等一个不会来的结束回调。
- 退出有两条路径：菜单 `exit_app`（停钩子 + `app.exit(0)`），以及 pet 窗口 Destroyed（Alt+F4）——后者也必须 `exit(0)`，否则进程带着隐藏菜单窗僵死在后台。

### 菜单悬浮窗（menu-window.ts / menu.css）

- **窗口按内容量尺寸**，量尺寸时加 `measuring` 类强制显示子菜单，窗口要罩住"面板+子菜单"的并集，否则子菜单被窗口边缘裁掉。
- **`#menu-root` 和面板必须 `width: fit-content`**：面板若是块级会撑满窗口，量出的尺寸和面板宽度互相拉扯（面板变宽 → 子菜单锚点右移 → 超出窗口）。
- **子菜单紧贴分组右缘（`left: 100%`，不留缝）**：留缝会让鼠标划过缝隙时 hover 丢失、子菜单闪没。屏幕右缘放不下时整体改左弹（`submenu-left` 类），面板贴光标。
- **`body` 不能 `overflow: hidden`**：右弹子菜单是绝对定位、不撑高父级，body 高度只有面板那么高，body 裁剪会把子菜单超出面板底边的部分裁掉。视口层（html）裁剪即可。
- **死区点击收起**挂在 `window` 而非 root（root 是 fit-content，死区在 root 外面，事件不经过 root）。
- 菜单为白底黑字、无边框、无阴影——用户明确要求过（阴影在浅色桌面上会看成一圈半透明灰边），不要再加回边框、阴影或半透明玻璃。工作面板与弹窗同理无阴影。

### 工作模式（work.ts / work-logic.ts / store.rs）

- **面板是纯视图层**：数值 / 配色 / 列表全部由 pet 下发（`work-state` / `work-tick`），交互回传（`work-ui`）。数据中枢在 `app.ts`，改业务逻辑去那里；改展示去 work.ts。
- **`work-ui` 监听必须先于 `preloadAll()` 注册**：面板窗口启动很快，它上报的一次性 `ready` 事件比雪碧图逐张解码（数秒）先到，晚注册会把事件整个错过，`workReady` 永远为 false。配套兜底有三层：pet 就绪后发 `work-ping`（面板收到补报 ready）、收到任何面板事件即自愈置 `workReady`、`enterWorkMode` 里最多轮询等 10 秒——面板没就绪就不隐藏宠物窗口，避免程序整体「消失」。新增一次性握手事件时照这套抄。
- **缩放用 `transform: scale`，不用 CSS zoom**：zoom 会影响 getBoundingClientRect 的语义（部分版本返回缩放后坐标），transform 缩放下 rect 与指针坐标天然一致。根元素尺寸 = 设计尺寸 × 比例，与窗口大小同步。
- **设计稿布局**：面板所有尺寸按 scale=1 写死在 CSS（左列 212px、信息卡 190×120、GIF 160×160）；`measureDesign()` 临时清 transform 量一次布局尺寸，改布局后窗口大小自动跟上。
- **透明度挂在缩放层 `#zoom-scale` 上**，提示条在层外——透明度调低时读数仍看得清（对应 Python 版 QToolTip 独立顶层窗口的理由）。
- **滚轮分流**（与 Python 版同构）：Ctrl 调透明度 → 左侧分页区域横向翻页 → 右侧分页区域内先滚列表（`scrollLocal`，内容溢出才算）再整页翻页；翻页动画进行中（300ms）不接受新输入。触控板半格累积到满一格才动，方向反转先清零。
- **行命中判定必须先限定滚动容器可视矩形**：滚出可视区的行 getBoundingClientRect 仍给出旧坐标，不先 `rectHas(rowsEl)` 就会盖住页头吞点击。
- **列表刷新保留滚动位置**：勾选完成这类无 focusId 的刷新，innerHTML 重建后要回填 `scrollTop`，否则列表跳回顶部。
- **生理期卡片隐藏时**（`period_visible=false`）右侧分页加 `cols-2` 类：信息卡从 3 列收回 2 列，页宽跟着变，`measureDesign()` 重算。
- **弹窗模态语义**：`app.ts` 的 `dialogOpen` 打开期间忽略全部 `work-ui` 交互（除 ready）；翻离信息卡页 / 切模式 / 关生理期开关都会发 `dialog-close`。
- **`leaveWorkMode` 只发 `{show:false}`**：work.ts 的 `applyState` 对缺字段的收起通知做了保护，不要假设所有字段都在。
- **计划每秒去重**：`tickWork()` 用 JSON.stringify 对比 `planDisplay`，一分钟内多半无变化，省掉每秒重建列表 DOM；保存计划后要先更新 `planDisplay` 缓存再推送，否则那次下发会被跳过。
- **work.gif 素材**：800KB 的 GIF 用 `<img>` 直接播放，浏览器自管解码；翻到待办统计页时设 `visibility: hidden` 省解码开销。
- **数据文件**：memos.json / plans.json 与 config.txt 同目录（`ConfigState::data_dir()`），格式与 Python 版完全兼容，两个程序可以交替读写同一份数据。

### 配置（config.rs / config.ts）

- `config.txt` 落点按 `resolve_config_path()` 优先级解析：CWD 已有 → exe 目录（可写时）→ CWD（可写时）→ `%APPDATA%\NewDeskBuddy`。改路径逻辑前先理解这条链（开发期 CWD 是 src-tauri；打包后从开始菜单/自启启动时 CWD 可能是 System32）。
- **新增配置键要同步三处**：`config.rs default_config()`、相关类型表（NUMERIC_KEYS/BOOL_KEYS）、`config.ts DEFAULTS`（仅前端用到的键）。
- 格式与 Python 版读写兼容：`key=value`、布尔写 `true/false`（大小写不敏感）、浮点去尾零（`1.0` 存 `1`）。
- **`debug_log` 开关**（默认 `false`）：前端 `invoke('debug_log')` 只有在 config.txt 里 `debug_log=true` 时才写文件（debug.log 与 config.txt 同目录）。排查问题时先打开它。

## 验证习惯

改完前端跑 `npx tsc --noEmit && npx vite build`；改完 Rust 跑 `cargo check`（在 src-tauri/ 下）。dev 运行中 cargo 会报 incremental 目录被占用的 warning（os error 32），无害。退出时的 `Failed to unregister class Chrome_WidgetWin_0`（错误码 1412）是 Chromium 关闭流程的已知无害日志，不用处理。

## 多页构建

`vite.config.js` 声明了四入口：`index.html`（pet）、`menu.html`（menu）、`work.html`（work）、`dialog.html`（dialog）。新增页面要同步加 rollupOptions.input。
