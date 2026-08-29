# NewDeskBuddy

DeskBuddy 的 Tauri 重构版。原版三种模式均已迁移：

- **🐱 默认模式**：月薪猫待机动画，双击角色在正常猫与睡觉猫之间切换（选择落盘），全局键盘按键计数，拖拽移动。
- **🐾 噜噜模式**：水豚噜噜待机摇摆，单击/双击触发随机反应动画与气泡，拖拽时僵硬挣扎，拖到屏幕顶部释放触发 OutBounce 降落动画，随机心情定时器（20–40 秒自动切情绪）。
- **🖥️ 工作模式**：悬浮工作面板（下班倒计时 / 信息卡 / 备忘录 / 计划安排 / 待办统计），日赚金额实时累计（按月薪资与计薪参数自动计算，或固定金额），生理期周期跟踪（卡片可隐藏）。首次切换时填写一次工作配置（默认值即可保存使用），之后直接进入；右键面板可新增/编辑备忘录与计划（各上限 50 条）、修改配置；Ctrl + 滚轮调透明度，四角拖拽等比缩放，滚轮翻页。

## 与原版的关系

- 配置沿用同一份 `config.txt`（`key=value` 文本格式），与 Python 版读写兼容：键名、默认值、布尔/数值容错规则一致，两版可以交替使用同一份配置。
- 工作模式数据（`memos.json` / `plans.json`）与 config.txt 同目录，格式与 Python 版完全兼容，两版可以交替读写同一份数据。
- 键盘计数规则一致：全局钩子统计，长按自动重复只计一次，从启动开始计数、不持久化总次数。
- 单击/双击 250ms 判定窗口、8px 拖拽阈值、80px 顶部降落阈值、气泡文案池、心情定时器区间均与原版对齐。

## 技术栈

- Tauri 2.x（Rust 后端 + WebView 前端）
- 前端：TypeScript + Vite，无框架
- 全局键盘监听：Rust 侧 `WH_KEYBOARD_LL` 低级钩子，计数经 `key-pressed` 事件推给前端
- 雪碧图动画：canvas 逐帧绘制（启动时预载并解码全部雪碧图），帧数与行列数在 `src/sprites.ts` 声明

## 开发

```cmd
cd NewDeskBuddy
npm install
npm run tauri dev
```

构建安装包：

```cmd
npm run tauri build
```

## 发布新版本

应用内置更新检查（每日按工作配置的上午上班时间检测一次 GitHub Releases，有新版本时菜单「📥 更新」项显示红点，点击可直接下载安装）。发新版按以下流程：

1. **改版本号**：同步修改 `src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 的 `version` 字段——前者是更新检测比较的本地版本，后者决定安装包文件名，两处不一致会导致红点判断错误。
2. **构建**：`npm run tauri build`，NSIS 安装包产出于 `src-tauri/target/release/bundle/nsis/NewDeskBuddy_<版本>_x64-setup.exe`。
3. **发布**：在 GitHub 仓库（[huaixu016/NewDeskBuddy](https://github.com/huaixu016/NewDeskBuddy)）新建 Release，tag 用 `v<版本>` 形式（如 `v0.2.0`），把第 2 步的 **`*-setup.exe` 作为资产上传**。
4. **验证**：旧版本用户次日上班时间后菜单出现红点；点「更新」自动下载安装包、退出应用并启动安装向导。想立即验证，可手动在 config.txt 里把 `update_latest_version` 改成高于本地的版本号再右键。

注意：Release 里必须上传 `*-setup.exe` 资产，直接更新功能靠它；只传源码包时点「更新」会回退为浏览器打开 Releases 页面。

## 目录结构

```text
NewDeskBuddy/
├── index.html              # 宠物窗入口（透明窗口内容）
├── menu.html               # 右键菜单悬浮窗入口
├── work.html               # 工作模式面板入口
├── dialog.html             # 弹窗窗入口（工作配置/备忘录/计划/生理期共用）
├── package.json
├── vite.config.js          # 四入口构建（index/menu/work/dialog）
├── public/assets/          # 雪碧图素材 + work.gif
├── src/
│   ├── main.ts             # 启动入口
│   ├── app.ts              # 模式状态机 + 鼠标交互 + 工作模式数据中枢
│   ├── config.ts           # 配置前端包装（后端负责 config.txt 读写）
│   ├── sprites.ts          # 雪碧图资源声明（文件、行列、尺寸）
│   ├── animator.ts         # canvas 逐帧动画器
│   ├── bubble.ts           # 上浮淡出气泡
│   ├── menu.ts / menu-window.ts / menu.css   # 右键菜单悬浮窗
│   ├── window.ts           # 窗口拖拽/缩放/降落动画
│   ├── work.ts / work.css / work-logic.ts    # 工作面板视图层 + 纯逻辑
│   ├── dialog.ts / dialog.css                # 四合一弹窗窗
│   └── style.css
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json     # 透明、无边框、置顶、跳过任务栏
    ├── icons/app.ico
    └── src/
        ├── main.rs         # Tauri 入口、常驻窗口创建（menu/work/dialog）
        ├── config.rs       # config.txt 读写与类型容错
        ├── store.rs        # memos.json / plans.json 读写与收敛
        └── keyboard.rs     # WH_KEYBOARD_LL 全局键盘计数
```

## 已知差异（相对 Python 版）

- 多屏场景下拖拽边界按「窗口所在屏幕」而非「光标所在屏幕」计算（Tauri API 限制，单屏无差异）。
- 雪碧图帧显示尺寸固定 140px（与原版 target_size 一致），暂未做等比缩放补偿。
- 右键菜单是独立的悬浮窗（白底黑字，噜噜互动以悬停弹出的右侧子菜单展现），由 Rust 常驻隐藏的 `menu` 窗口承载，右键时在光标处显示、失焦自动隐藏；屏幕右缘放不下时子菜单自动改往左弹。
- 动画器用 canvas 逐帧绘制（启动时预载并解码全部雪碧图），避免 CSS 换图时的透明闪屏。
