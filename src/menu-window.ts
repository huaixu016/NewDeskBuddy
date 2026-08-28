/**
 * 独立菜单窗口：右键时由宠物窗口触发显示，现代深色玻璃拟态样式。
 *
 * 事件流：
 * - 入：`menu-state`（宠物窗口右键时推送，或 take_pending_menu 兜底）
 * - 出：`menu-action`（选中项 id，宠物窗口分发）
 * - 失焦：Rust 侧监听 Focused(false) 自动隐藏
 */
import { listen } from '@tauri-apps/api/event'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'

const win = getCurrentWindow()
const root = document.getElementById('menu-root')!

interface MenuState {
  mode: string
  keyCountVisible: boolean
  x: number
  y: number
}

interface Entry {
  id: string
  label: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  separatorAfter?: boolean
  submenu?: Entry[]
}

/** 噜噜互动子菜单，id 与序列名一致。 */
const LULU_REACTIONS: Array<[string, string]> = [
  ['lulu_pleasant', '😊 摸摸头'],
  ['lulu_hoop', '🎉 开心转圈'],
  ['lulu_anger', '😤 惹它生气'],
  ['lulu_cry', '😢 弄哭它'],
  ['lulu_sad', '😔 让它伤心'],
  ['lulu_salute', '✊ 敬礼!'],
  ['lulu_tickle', '🤣 挠痒痒'],
]

function buildEntries(state: MenuState): Entry[] {
  const isLulu = state.mode === 'lulu'
  const entries: Entry[] = [
    { id: 'mode_default', label: '🐱 默认模式', checked: !isLulu },
    { id: 'mode_lulu', label: '🐾 噜噜模式', checked: isLulu, separatorAfter: true },
  ]
  if (isLulu) {
    entries.push({
      id: 'lulu_group',
      label: '🎭 噜噜互动',
      submenu: [
        ...LULU_REACTIONS.map(([id, label]): Entry => ({ id, label })),
        { id: 'sep1', label: '', separatorAfter: true },
        { id: 'lulu_random', label: '🎲 随机心情' },
      ],
      separatorAfter: true,
    })
  }
  entries.push({ id: 'placeholder', label: '🎮 更多玩法（敬请期待）', disabled: true, separatorAfter: true })
  entries.push({ id: 'toggle_key_count', label: '⌨ 显示总按键次数', checked: state.keyCountVisible, separatorAfter: true })
  entries.push({ id: 'quit', label: '🚪 退出', danger: true })
  return entries
}

function sendAction(id: string): void {
  void invoke('debug_log', { msg: `[menu] sent ${id}` })
  void emit('menu-action', id)
  void win.hide()
}

function buildMenu(state: MenuState): void {
  root.innerHTML = ''
  const panel = document.createElement('div')
  panel.className = 'menu-panel'

  for (const entry of buildEntries(state)) {
    if (entry.submenu) {
      const group = document.createElement('div')
      group.className = 'menu-group'
      const title = document.createElement('div')
      title.className = 'menu-item menu-group-title'
      title.textContent = entry.label
      const arrow = document.createElement('span')
      arrow.className = 'menu-arrow'
      arrow.textContent = '▸'
      title.appendChild(arrow)
      group.appendChild(title)
      const sub = document.createElement('div')
      sub.className = 'menu-sub'
      for (const subEntry of entry.submenu) {
        if (subEntry.id.startsWith('sep')) {
          const sep = document.createElement('div')
          sep.className = 'menu-separator'
          sub.appendChild(sep)
          continue
        }
        sub.appendChild(makeItem(subEntry))
      }
      group.appendChild(sub)
      panel.appendChild(group)
      if (entry.separatorAfter) panel.appendChild(makeSeparator())
      continue
    }
    panel.appendChild(makeItem(entry))
    if (entry.separatorAfter) panel.appendChild(makeSeparator())
  }

  // 去掉末尾多余的分隔条。
  while (panel.lastElementChild?.classList.contains('menu-separator')) {
    panel.lastElementChild.remove()
  }

  root.appendChild(panel)
}

function makeItem(entry: Entry): HTMLElement {
  const item = document.createElement('div')
  item.className = 'menu-item'
  if (entry.checked) item.classList.add('menu-item-checked')
  if (entry.disabled) item.classList.add('menu-item-disabled')
  if (entry.danger) item.classList.add('menu-item-danger')
  item.textContent = entry.label
  if (!entry.disabled) {
    item.addEventListener('click', () => sendAction(entry.id))
  }
  return item
}

function makeSeparator(): HTMLElement {
  const sep = document.createElement('div')
  sep.className = 'menu-separator'
  return sep
}

/** 收到菜单状态：重建 DOM、按内容量出尺寸、定位到光标附近再显示。 */
async function showMenu(state: MenuState): Promise<void> {
  buildMenu(state)

  // 先在隐藏状态下量尺寸（DOM 已渲染但窗口不可见）。
  await win.hide()
  root.classList.remove('submenu-left')
  // 子菜单悬停才显示，量尺寸时强制可见才能算进窗口尺寸；
  // 面板和 root 都是 fit-content，量出的值不依赖窗口当前大小。
  root.classList.add('measuring')
  const panel = root.querySelector<HTMLElement>('.menu-panel')!
  const pr = panel.getBoundingClientRect()
  const sub = root.querySelector<HTMLElement>('.menu-sub')
  let subW = 0
  let subBottom = 0
  if (sub) {
    const sr = sub.getBoundingClientRect()
    subW = Math.ceil(sr.width)
    // 子菜单顶部锚在分组上、向下延伸，可能超出面板底边，高度要按它算。
    subBottom = Math.ceil(sr.bottom - pr.top)
  }
  root.classList.remove('measuring')

  // root 上下左右各 4px padding，再留 2px 余量。
  const margin = 10
  const w = Math.ceil(pr.width) + subW + margin
  const h = Math.max(Math.ceil(pr.height), subBottom) + margin

  const factor = await win.scaleFactor()
  // 光标坐标是 CSS 像素（相对虚拟屏原点）；越界往左/上翻。
  const monitor = await currentMonitor()
  let x = state.x
  let y = state.y
  if (monitor) {
    const left = monitor.position.x / factor
    const top = monitor.position.y / factor
    const right = (monitor.position.x + monitor.size.width) / factor
    const bottom = (monitor.position.y + monitor.size.height) / factor
    // 右侧连子菜单一起放不下：子菜单改往左弹（面板仍贴光标），整体左移。
    if (sub && x + w > right) {
      root.classList.add('submenu-left')
      x -= subW + margin
    }
    x = Math.min(Math.max(x, left), Math.max(left, right - w))
    y = Math.min(Math.max(y, top), Math.max(top, bottom - h))
  }

  await win.setSize(new PhysicalSize(Math.round(w * factor), Math.round(h * factor)))
  await win.setPosition(new PhysicalPosition(Math.round(x * factor), Math.round(y * factor)))
  await win.show()
  await win.setFocus()
}

// 窗口比面板大（要罩住右侧弹出的子菜单），面板外的透明留白点一下就收起，
// 免得看起来点空了菜单却还挂着。挂 window 而不是 root：root 是
// fit-content，死区（子菜单占的透明区域）在 root 外面，事件不会经过 root。
window.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.menu-panel')) void win.hide()
})

await listen<MenuState>('menu-state', (event) => {
  void showMenu(event.payload)
})

// 兜底：右键发生在此窗口加载完成之前时，从 Rust 侧取积压的请求。
const pending = await invoke<MenuState | null>('take_pending_menu')
if (pending) {
  await showMenu(pending)
}
