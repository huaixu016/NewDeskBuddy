# CLAUDE.md

NewDeskBuddy：桌面宠物（Tauri 2 重构版）。Rust 后端 + TypeScript/Vite 前端（无框架）。
对应 Python 版 DesktopPet 的「默认模式 + 噜噜模式」，工作模式尚未迁移。

## 常用命令

```cmd
npm install
npm run tauri dev      # 开发运行（CWD 在 src-tauri，config.txt/debug.log 也在这里）
npm run tauri build    # 打 NSIS 安装包
npx tsc --noEmit       # 前端类型检查
npx vite build         # 前端构建（双入口：index.html + menu.html）
cargo check            # 在 src-tauri/ 下检查 Rust 侧
```

## 架构

两个窗口：

- **pet**（`index.html` → `main.ts` → `app.ts`）：透明无边框置顶窗，canvas 逐帧绘制雪碧图，承载全部模式状态机与鼠标交互。`tauri.conf.json` 里 `visible: false`，`startApp()` 全部就绪（配置加载 + 雪碧图预载 + 首帧 + 布局）后才 `win.show()`，避免"先见键盘数、几秒后才见角色"。启动失败路径在 `main.ts` 里自己把窗口拉出来显示错误。
- **menu**（`menu.html` → `menu-window.ts`）：Rust 侧启动即创建的常驻隐藏悬浮窗。右键时 pet 调 `open_menu_window` 推 `menu-state` 事件（带一份 pending 兜底）；选中项经全局 `menu-action` 事件回传 pet 分发；失焦自动隐藏。

事件流：右键 → `open_menu_window` → `menu-state` → 菜单渲染/量尺寸/定位 → 点击 → `menu-action` → `app.ts handleMenuAction`。

全局键盘计数：Rust `keyboard.rs` 的 `WH_KEYBOARD_LL` 钩子（独立线程消息循环），长按自动重复只计一次，经 `key-pressed` 事件推给前端。计数不持久化。

## 模块速查

| 文件 | 职责 |
| --- | --- |
| `src/app.ts` | 模式状态机、鼠标交互（单击/双击/拖拽/降落）、布局、菜单动作分发 |
| `src/animator.ts` | canvas 逐帧动画器（`play` / `playOnce`） |
| `src/sprites.ts` | 雪碧图声明（文件/行列/尺寸）+ 预载 + 失败重载 |
| `src/window.ts` | 窗口移动/缩放/边界收敛 + OutBounce 降落动画 |
| `src/menu-window.ts` / `src/menu.css` | 右键菜单悬浮窗（白底黑字，噜噜互动为悬停右侧弹出的子菜单） |
| `src/config.ts` | 配置前端包装；后端 `config.rs` 负责真正的读写与容错 |
| `src-tauri/src/main.rs` | 入口、窗口创建、菜单事件路由、退出路径 |
| `src-tauri/src/keyboard.rs` | 全局键盘钩子 |

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
- 菜单为白底黑字、无边框、阴影分层——用户明确要求过，不要再加回边框或半透明玻璃。

### 配置（config.rs / config.ts）

- `config.txt` 落点按 `resolve_config_path()` 优先级解析：CWD 已有 → exe 目录（可写时）→ CWD（可写时）→ `%APPDATA%\NewDeskBuddy`。改路径逻辑前先理解这条链（开发期 CWD 是 src-tauri；打包后从开始菜单/自启启动时 CWD 可能是 System32）。
- **新增配置键要同步三处**：`config.rs default_config()`、相关类型表（NUMERIC_KEYS/BOOL_KEYS）、`config.ts DEFAULTS`（仅前端用到的键）。
- 格式与 Python 版读写兼容：`key=value`、布尔写 `true/false`（大小写不敏感）、浮点去尾零（`1.0` 存 `1`）。
- **`debug_log` 开关**（默认 `false`）：前端 `invoke('debug_log')` 只有在 config.txt 里 `debug_log=true` 时才写文件（debug.log 与 config.txt 同目录）。排查问题时先打开它。

## 验证习惯

改完前端跑 `npx tsc --noEmit && npx vite build`；改完 Rust 跑 `cargo check`（在 src-tauri/ 下）。dev 运行中 cargo 会报 incremental 目录被占用的 warning（os error 32），无害。退出时的 `Failed to unregister class Chrome_WidgetWin_0`（错误码 1412）是 Chromium 关闭流程的已知无害日志，不用处理。

## 多页构建

`vite.config.js` 声明了双入口：`index.html`（pet）与 `menu.html`（menu）。新增页面要同步加 rollupOptions.input。
