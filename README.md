# NewDeskBuddy

DeskBuddy 的 Tauri 重构版。当前阶段实现了原版三种模式中的两种：

- **🐱 默认模式**：月薪猫待机动画，双击角色在正常猫与睡觉猫之间切换（选择落盘），全局键盘按键计数，拖拽移动。
- **🐾 噜噜模式**：水豚噜噜待机摇摆，单击/双击触发随机反应动画与气泡，拖拽时僵硬挣扎，拖到屏幕顶部释放触发 OutBounce 降落动画，随机心情定时器（20–40 秒自动切情绪）。
- 工作模式尚未迁移，菜单中暂不出现。

## 与原版的关系

- 配置沿用同一份 `config.txt`（`key=value` 文本格式），与 Python 版读写兼容：键名、默认值、布尔/数值容错规则一致，两版可以交替使用同一份配置。
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

## 目录结构

```text
NewDeskBuddy/
├── index.html              # 入口页面（透明窗口内容）
├── package.json
├── vite.config.js
├── public/assets/          # 雪碧图素材（与原版 assets/ 同一批文件）
├── src/
│   ├── main.ts             # 启动入口
│   ├── app.ts              # 模式状态机 + 鼠标交互 + 布局
│   ├── config.ts           # 配置前端包装（后端负责 config.txt 读写）
│   ├── sprites.ts          # 雪碧图资源声明（文件、行列、尺寸）
│   ├── animator.ts         # CSS 逐帧动画器
│   ├── bubble.ts           # 上浮淡出气泡
│   ├── menu.ts             # 右键菜单
│   ├── window.ts           # 窗口拖拽/缩放/降落动画
│   └── style.css
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json     # 透明、无边框、置顶、跳过任务栏
    ├── icons/app.ico
    └── src/
        ├── main.rs         # Tauri 入口、窗口初始定位
        ├── config.rs       # config.txt 读写与类型容错
        └── keyboard.rs     # WH_KEYBOARD_LL 全局键盘计数
```

## 已知差异（相对 Python 版）

- 多屏场景下拖拽边界按「窗口所在屏幕」而非「光标所在屏幕」计算（Tauri API 限制，单屏无差异）。
- 雪碧图帧显示尺寸固定 140px（与原版 target_size 一致），暂未做等比缩放补偿。
- 右键菜单是独立的悬浮窗（白底黑字，噜噜互动以悬停弹出的右侧子菜单展现），由 Rust 常驻隐藏的 `menu` 窗口承载，右键时在光标处显示、失焦自动隐藏；屏幕右缘放不下时子菜单自动改往左弹。
- 动画器用 canvas 逐帧绘制（启动时预载并解码全部雪碧图），避免 CSS 换图时的透明闪屏。
