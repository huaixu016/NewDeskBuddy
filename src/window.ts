/**
 * 窗口控制：Tauri 窗口的拖拽、边界收敛、尺寸调整与降落动画。
 * 拖拽不用 data-tauri-drag-region：需要自己区分单击/双击/拖拽，
 * 与 Python 版 mousePress/Move/Release 一套逻辑。
 */
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { invoke } from '@tauri-apps/api/core'

export const win = getCurrentWindow()

/** 拖拽阈值：超过才算拖动，否则按点击处理（与原版 8px 一致）。 */
export const DRAG_THRESHOLD = 8

/** 单击/双击判定窗口（毫秒）。 */
export const CLICK_WINDOW = 250

/** 顶部触发降落的阈值（像素）。 */
export const TOP_DROP_THRESHOLD = 80

export interface ScreenBounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** 当前窗口所在屏幕的可视 bounds（CSS 像素）。 */
export async function screenAtCursor(): Promise<ScreenBounds> {
  const factor = await win.scaleFactor()
  const monitor = await currentMonitor()
  if (monitor) {
    const pos = monitor.position
    const size = monitor.size
    return {
      left: pos.x / factor,
      top: pos.y / factor,
      right: (pos.x + size.width) / factor,
      bottom: (pos.y + size.height) / factor,
    }
  }
  return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
}

/** 把窗口限制在屏幕可视范围内。 */
export async function clampToScreen(): Promise<void> {
  const bounds = await screenAtCursor()
  const pos = await win.outerPosition()
  const factor = await win.scaleFactor()
  const size = await win.outerSize()
  const css = { x: pos.x / factor, y: pos.y / factor, w: size.width / factor, h: size.height / factor }
  const x = Math.min(Math.max(css.x, bounds.left), bounds.right - css.w)
  const y = Math.min(Math.max(css.y, bounds.top), bounds.bottom - css.h)
  await win.setPosition(new PhysicalPosition(Math.round(x * factor), Math.round(y * factor)))
}

/** 用 CSS 像素设置窗口尺寸；尺寸没变时跳过——透明窗口在 Windows 上
 * 每次 set_size 都会整体重合成，反应动画期间反复触发会显得闪。 */
let lastSize: { w: number; h: number } | null = null
export async function resizeTo(cssWidth: number, cssHeight: number): Promise<void> {
  if (lastSize && lastSize.w === cssWidth && lastSize.h === cssHeight) return
  const factor = await win.scaleFactor()
  await win.setSize(new PhysicalSize(Math.round(cssWidth * factor), Math.round(cssHeight * factor)))
  // 落缓存放在设置成功之后：提前记会让失败的 resize 把后续同尺寸请求也跳掉。
  lastSize = { w: cssWidth, h: cssHeight }
}

export async function positionCss(): Promise<{ x: number; y: number }> {
  const factor = await win.scaleFactor()
  const pos = await win.outerPosition()
  const css = { x: pos.x / factor, y: pos.y / factor }
  lastPos = css
  return css
}

/** 最近一次已知窗口位置（CSS 像素）；moveTo / positionCss 会刷新。 */
let lastPos: { x: number; y: number } | null = null

/** 同步取缓存位置；从未查询过时返回 (0,0)。 */
export function cachedPos(): { x: number; y: number } {
  return lastPos ?? { x: 0, y: 0 }
}

export async function sizeCss(): Promise<{ w: number; h: number }> {
  const factor = await win.scaleFactor()
  const size = await win.outerSize()
  return { w: size.width / factor, h: size.height / factor }
}

/** 用 CSS 像素移动窗口。 */
export async function moveTo(cssX: number, cssY: number): Promise<void> {
  const factor = await win.scaleFactor()
  lastPos = { x: cssX, y: cssY }
  await win.setPosition(new PhysicalPosition(Math.round(cssX * factor), Math.round(cssY * factor)))
}

/** 退出程序：菜单窗口常驻隐藏，必须整体退出事件循环而非只关一个窗口。 */
export async function quit(): Promise<void> {
  await invoke('exit_app')
}

// ---------------------------------------------------------------------------
// 降落动画（OutBounce 缓动），对应 Python 版 _start_drop_animation。
// ---------------------------------------------------------------------------

function easeOutBounce(x: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  if (x < 1 / d1) {
    return n1 * x * x
  } else if (x < 2 / d1) {
    return n1 * (x -= 1.5 / d1) * x + 0.75
  } else if (x < 2.5 / d1) {
    return n1 * (x -= 2.25 / d1) * x + 0.9375
  } else {
    return n1 * (x -= 2.625 / d1) * x + 0.984375
  }
}

export interface DropHandle {
  cancel: () => void
  readonly running: boolean
}

/**
 * 从当前 Y 平滑降落到 targetY。时长随距离变化：300ms + 每 100px 加 80ms，
 * 上限 1200ms。再次调用会先取消进行中的动画。
 */
export function dropTo(targetY: number, onDone: () => void): DropHandle {
  let running = true
  let raf = 0
  let cancelled = false

  void (async () => {
    const start = await positionCss()
    const distance = targetY - start.y
    const duration = Math.min(1200, Math.max(300, 300 + Math.trunc(distance / 100) * 80))
    const startTime = performance.now()

    const step = (now: number) => {
      if (cancelled) return
      const t = Math.min(1, (now - startTime) / duration)
      const eased = easeOutBounce(t)
      const y = start.y + distance * eased
      // 只改 Y，X 保持不动。
      void moveTo(start.x, y)
      if (t < 1) {
        raf = requestAnimationFrame(step)
      } else {
        running = false
        onDone()
      }
    }
    raf = requestAnimationFrame(step)
  })()

  return {
    cancel: () => {
      cancelled = true
      cancelAnimationFrame(raf)
      running = false
    },
    get running() {
      return running
    },
  }
}
