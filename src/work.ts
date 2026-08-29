/**
 * 工作模式面板：独立悬浮窗（常驻隐藏，由 pet 窗口驱动显示）。
 * 对应 Python 版 work_window.py 的 WorkModeWindow。
 *
 * 只负责展示与交互：数值 / 卡片配色 / 列表内容全部由 pet 窗口（app.ts）
 * 通过 `work-state` 事件下发；用户交互（点击卡片 / 行 / 缩放 / 滚轮 / 右键）
 * 经 `work-ui` 事件回传 pet 窗口处理。
 *
 * 缩放用 transform: scale 实现：面板按设计稿（scale = 1）布局，根元素
 * 尺寸与窗口大小都等于设计尺寸 × 比例。整窗透明度用 CSS 透明度设置在
 * 缩放层上，提示条放在层外，透明度调低时读数仍看得清。
 */
import { listen } from '@tauri-apps/api/event'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import type { PlanDisplay, CardValue, WorkValues } from './work-logic'

const win = getCurrentWindow()
const rootEl = document.getElementById('work-root') as HTMLElement
const zoomEl = document.getElementById('zoom-scale')!
const panelEl = document.getElementById('panel')!
const countdownTitleEl = document.getElementById('countdown-title')!
const countdownEl = document.getElementById('countdown')!
const keyCountEl = document.getElementById('key-count')!
const gifEl = document.getElementById('work-gif') as HTMLImageElement
const opacityHintEl = document.getElementById('opacity-hint')!

// 生理期卡片：可点击（唤起详情弹窗）
const periodCardEl = document.getElementById('card-period')!
const rightPagerEl = document.getElementById('right-pager')!
const leftPagerEl = document.getElementById('left-pager')!
const memoRowsEl = document.getElementById('memo-rows')!
const memoEmptyEl = document.getElementById('memo-empty')!
const planRowsEl = document.getElementById('plan-rows')!
const planEmptyEl = document.getElementById('plan-empty')!

const cardEls: Record<string, HTMLElement> = {
  payday: document.getElementById('card-payday')!,
  festival: document.getElementById('card-festival')!,
  period: periodCardEl,
  weekday: document.getElementById('card-weekday')!,
  earn: document.getElementById('card-earn')!,
}

const todoValueEls: Record<string, HTMLElement> = {
  memo: document.querySelector<HTMLElement>('.todo-card-memo .todo-value')!,
  plan: document.querySelector<HTMLElement>('.todo-card-plan .todo-value')!,
}

// ---------------------------------------------------------------------------
// 常量（与 Python 版对齐）
// ---------------------------------------------------------------------------

/** 缩放范围，1.0 对应设计稿尺寸。 */
const MIN_SCALE = 0.45
const MAX_SCALE = 1.4
const DEFAULT_SCALE = 0.65

/** 整窗透明度范围与步长。 */
const MIN_OPACITY = 0.3
const MAX_OPACITY = 1.0
const DEFAULT_OPACITY = 1.0
const OPACITY_STEP = 0.05

/** 一格标准滚轮的 deltaY，高精度触控板会按比例给出更小的值。 */
const WHEEL_NOTCH = 120
/** 停止滚动后延迟上报，避免每一格都写一次配置文件。 */
const OPACITY_SAVE_DELAY = 400
/** 百分比提示的停留时长。 */
const OPACITY_HINT_DURATION = 1200
/** 按下与松手的位移不超过该像素才算一次点击（设计稿像素）。 */
const CLICK_TOLERANCE = 6
/** 四角缩放热区的边长（设计稿像素）。 */
const RESIZE_ZONE = 26
/** 页内列表一格滚轮走几行。 */
const LOCAL_SCROLL_ROWS = 2
/** 备忘录 / 计划行的设计稿行高，页内滚动步长用。 */
const MEMO_ROW_H = 42
const PLAN_ROW_H = 60

/** 右侧分页：信息卡 0 / 备忘录 1 / 计划 2。 */
const PAGE_CARDS = 0
const PAGE_MEMO = 1
const PAGE_PLAN = 2

/** 左侧分页：角色 GIF 0 / 待办统计 1。 */
const LEFT_PAGE_GIF = 0
const LEFT_PAGE_TODO = 1

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let scale = DEFAULT_SCALE
let opacity = DEFAULT_OPACITY
let periodVisible = true
/** 首次显示时贴主屏右下角；之后沿用当前位置。 */
let hasShown = false

/** 设计稿尺寸（transform 之前的布局尺寸）。 */
let designW = 0
let designH = 0

// 拖拽 / 缩放状态
type Corner = 'top_left' | 'top_right' | 'bottom_left' | 'bottom_right'
let dragOffset: { x: number; y: number } | null = null
let pressScreen: { x: number; y: number } | null = null
let resizing = false
let resizeCorner: Corner | null = null
/** 缩放拖拽的起始信息：光标位置 / 起始比例 / 不参与拖动的对角锚点（CSS 像素）。 */
let resizeStart: { x: number; y: number; scale: number; anchor: { x: number; y: number } } | null = null

// 点击判定状态（press 时记下，release 判定后据此发事件）
type ClickTarget =
  | { kind: 'period' }
  | { kind: 'todo'; key: string }
  | { kind: 'memo'; id: number; onCheck: boolean }
  | { kind: 'plan'; id: number }
let clickTarget: ClickTarget | null = null

// 累积滚轮位移（触控板半格不算）
let pageWheelDelta = 0
let leftWheelDelta = 0
let opacityWheelDelta = 0
let opacitySaveTimer: number | null = null
let opacityHintTimer: number | null = null

// ---------------------------------------------------------------------------
// 缩放与窗口几何
// ---------------------------------------------------------------------------

/**
 * 量设计稿尺寸：面板 zoom 无关的布局尺寸。
 * 临时清掉 transform 量一次（启动时 transform 尚未设置，直接量即可）。
 */
function measureDesign(): void {
  const prev = zoomEl.style.transform
  zoomEl.style.transform = 'none'
  designW = Math.ceil(zoomEl.offsetWidth + 36) // 36 = 面板 margin(18×2)，offsetWidth 不含 margin
  designH = Math.ceil(zoomEl.offsetHeight + 36)
  zoomEl.style.transform = prev
}

/** 设置缩放并同步窗口大小。keepAnchor 为真时保持 resizeStart 的对角不动。 */
async function applyScale(next: number, keepAnchor = false): Promise<void> {
  const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  if (keepAnchor && Math.abs(target - scale) < 0.004) return
  scale = target

  zoomEl.style.transform = `scale(${scale})`
  rootEl.style.width = `${Math.ceil(designW * scale)}px`
  rootEl.style.height = `${Math.ceil(designH * scale)}px`

  const factor = await win.scaleFactor()
  const w = Math.round(designW * scale * factor)
  const h = Math.round(designH * scale * factor)
  await win.setSize(new PhysicalSize(w, h))

  if (keepAnchor && resizeStart) {
    const { atLeft, atTop } = cornerSpec(resizeCorner ?? 'bottom_right')
    await win.setPosition(new PhysicalPosition(
      Math.round((resizeStart.anchor.x - (atLeft ? designW * scale : 0)) * factor),
      Math.round((resizeStart.anchor.y - (atTop ? designH * scale : 0)) * factor),
    ))
  }
}

function applyOpacity(value: number): number {
  // 步进累加会产生浮点尾数，统一保留两位，落盘和比较都干净。
  const target = Math.round(Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value)) * 100) / 100
  opacity = target
  // 透明度只作用于面板层；提示条在层外，调低时读数仍看得清。
  zoomEl.style.opacity = String(opacity)
  return opacity
}

function showOpacityHint(): void {
  opacityHintEl.textContent = `透明度 ${Math.round(opacity * 100)}%`
  opacityHintEl.classList.add('show')
  if (opacityHintTimer !== null) window.clearTimeout(opacityHintTimer)
  opacityHintTimer = window.setTimeout(() => {
    opacityHintEl.classList.remove('show')
  }, OPACITY_HINT_DURATION)
}

function adjustOpacity(delta: number): void {
  const previous = opacity
  applyOpacity(previous + delta)
  if (opacity === previous) return
  showOpacityHint()
  if (opacitySaveTimer !== null) window.clearTimeout(opacitySaveTimer)
  opacitySaveTimer = window.setTimeout(() => {
    void emit('work-ui', { type: 'opacity', value: opacity })
  }, OPACITY_SAVE_DELAY)
}

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

interface Pager {
  viewport: HTMLElement
  host: HTMLElement
  dots: HTMLElement
  horizontal: boolean
  index: number
  count: number
  animating: boolean
}

function initPager(root: HTMLElement, horizontal: boolean): Pager {
  const pager: Pager = {
    viewport: root.querySelector('.pager-viewport') as HTMLElement,
    host: root.querySelector('.pager-host') as HTMLElement,
    dots: root.querySelector('.pager-dots') as HTMLElement,
    horizontal,
    index: 0,
    count: root.querySelectorAll('.page').length,
    animating: false,
  }
  pager.dots.innerHTML = ''
  for (let i = 0; i < pager.count; i++) {
    const dot = document.createElement('div')
    dot.className = 'pager-dot' + (i === 0 ? ' active' : '')
    pager.dots.appendChild(dot)
  }
  return pager
}

/** 切到指定页；越界索引收敛到首末页。返回是否真的切换了。 */
function setPage(pager: Pager, index: number, animate = true): boolean {
  if (pager.count === 0) return false
  const target = Math.min(pager.count - 1, Math.max(0, index))
  if (target === pager.index) return false
  pager.index = target
  const dots = pager.dots.children
  for (let i = 0; i < dots.length; i++) {
    dots[i].classList.toggle('active', i === target)
  }
  slideTo(pager, animate)
  return true
}

function slideTo(pager: Pager, animate: boolean): void {
  const w = pager.viewport.offsetWidth
  const h = pager.viewport.offsetHeight
  const offset = pager.horizontal ? -pager.index * w : -pager.index * h
  pager.host.style.transition = animate ? '' : 'none'
  pager.host.style.transform = pager.horizontal
    ? `translateX(${offset}px)`
    : `translateY(${offset}px)`
  if (animate) {
    pager.animating = true
    window.setTimeout(() => {
      pager.animating = false
    }, 300)
  }
}

/** 把滚轮位移累加成翻页动作（触控板半格不算，方向反转先清零）。 */
function wheelToPage(pager: Pager, delta: number, accumulated: number): number {
  if (delta * accumulated < 0) accumulated = 0
  accumulated += delta
  const steps = Math.trunc(accumulated / WHEEL_NOTCH)
  if (!steps) return accumulated
  // 向下滚 deltaY 为正，对应翻到下一页。
  setPage(pager, pager.index + (steps > 0 ? 1 : -1))
  return 0
}

const rightPager = initPager(rightPagerEl, false)
const leftPager = initPager(leftPagerEl, true)

/** 翻页后上报页索引（pet 窗口据此收起生理期详情弹窗）。 */
function notifyPage(): void {
  void emit('work-ui', { type: 'page', index: rightPager.index })
}

// ---------------------------------------------------------------------------
// 列表渲染
// ---------------------------------------------------------------------------

interface MemoDisplay {
  id: number
  text: string
  done: boolean
}

function setMemoRows(memos: MemoDisplay[], focusId?: number | null): void {
  // 无定位需求时保留当前滚动位置：勾选完成状态这类刷新不该把列表拉回顶部。
  const keepScroll = focusId == null ? memoRowsEl.scrollTop : 0
  memoRowsEl.innerHTML = ''
  for (const memo of memos) {
    const row = document.createElement('div')
    row.className = 'memo-row' + (memo.done ? ' done' : '')
    row.dataset.id = String(memo.id)
    const check = document.createElement('div')
    check.className = 'memo-check'
    check.textContent = memo.done ? '✓' : ''
    const text = document.createElement('div')
    text.className = 'memo-text'
    // 弹窗里可以写多行，行内只显示一行：换行和连续空白压成单个空格。
    text.textContent = memo.text.split(/\s+/).join(' ')
    row.appendChild(check)
    row.appendChild(text)
    memoRowsEl.appendChild(row)
  }
  memoRowsEl.style.display = memos.length ? '' : 'none'
  memoEmptyEl.style.display = memos.length ? 'none' : ''
  if (memos.length && focusId != null) {
    const index = memos.findIndex((m) => m.id === focusId)
    if (index >= 0) {
      // 新增或编辑完滚进可视区，不用自己去列表里找。
      memoRowsEl.scrollTop = Math.max(0, index * MEMO_ROW_H - (memoRowsEl.clientHeight / 2 - MEMO_ROW_H / 2))
    }
  } else {
    memoRowsEl.scrollTop = keepScroll
  }
}

function setPlanRows(plans: PlanDisplay[], focusId?: number | null): void {
  // 无定位需求时保留当前滚动位置，理由同 setMemoRows。
  const keepScroll = focusId == null ? planRowsEl.scrollTop : 0
  planRowsEl.innerHTML = ''
  for (const plan of plans) {
    const row = document.createElement('div')
    const canceled = plan.palette[3]
    row.className = 'plan-row' + (canceled ? ' canceled' : plan.status === '已结束' ? ' done' : '')
    row.dataset.id = String(plan.id)
    const time = document.createElement('div')
    time.className = 'plan-time'
    time.textContent = plan.time
    const main = document.createElement('div')
    main.className = 'plan-main'
    const title = document.createElement('div')
    title.className = 'plan-title'
    title.textContent = plan.title
    title.style.color = plan.palette[2]
    const badge = document.createElement('div')
    badge.className = 'plan-badge'
    badge.textContent = plan.status
    badge.style.background = plan.palette[0]
    badge.style.color = plan.palette[1]
    main.appendChild(title)
    main.appendChild(badge)
    row.appendChild(time)
    row.appendChild(main)
    planRowsEl.appendChild(row)
  }
  planRowsEl.style.display = plans.length ? '' : 'none'
  planEmptyEl.style.display = plans.length ? 'none' : ''
  if (plans.length && focusId != null) {
    const index = plans.findIndex((p) => p.id === focusId)
    if (index >= 0) {
      planRowsEl.scrollTop = Math.max(0, index * PLAN_ROW_H - (planRowsEl.clientHeight / 2 - PLAN_ROW_H / 2))
    }
  } else {
    planRowsEl.scrollTop = keepScroll
  }
}

// ---------------------------------------------------------------------------
// 数值刷新
// ---------------------------------------------------------------------------

function applyValues(values: WorkValues): void {
  countdownTitleEl.textContent = values.countdownTitle
  countdownEl.textContent = values.countdown
  todoValueEls.memo.textContent = values.todo.memo
  todoValueEls.plan.textContent = values.todo.plan
  for (const key of Object.keys(cardEls)) {
    const cardValue = values[key as keyof WorkValues] as CardValue | undefined
    if (!cardValue) continue
    const el = cardEls[key]
    const titleEl = el.querySelector('.card-title') as HTMLElement
    const valueEl = el.querySelector('.card-value') as HTMLElement
    if (cardValue.title) titleEl.textContent = cardValue.title
    valueEl.textContent = cardValue.value ?? '--'
    if (cardValue.palette) {
      el.style.background = cardValue.palette[0]
      titleEl.style.color = cardValue.palette[1]
      valueEl.style.color = cardValue.palette[2]
    }
  }
}

function setKeyCount(text: string): void {
  keyCountEl.textContent = text
}

function setKeyCountVisible(visible: boolean): void {
  const hidden = keyCountEl.style.display === 'none'
  if (hidden === !visible) return
  keyCountEl.style.display = visible ? '' : 'none'
  // 量尺寸：隐藏按键统计后面板变矮。
  measureDesign()
  void applyScale(scale)
}

/** 显示或隐藏生理期卡片，隐藏时整列收回，面板变为两行两列。 */
function setPeriodVisible(visible: boolean): void {
  if (periodVisible === visible) return
  periodVisible = visible
  rightPagerEl.classList.toggle('cols-2', !visible)
  // 可见列数变了，单页宽度要跟着重算。
  measureDesign()
  void applyScale(scale)
}

// ---------------------------------------------------------------------------
// 命中判定（点击目标 / 缩放角）
// ---------------------------------------------------------------------------

function cornerSpec(corner: Corner): { atLeft: boolean; atTop: boolean } {
  return {
    top_left: { atLeft: true, atTop: true },
    top_right: { atLeft: false, atTop: true },
    bottom_left: { atLeft: true, atTop: false },
    bottom_right: { atLeft: false, atTop: false },
  }[corner]
}

/**
 * 缩放热区以面板边角为基准向内延伸，同时覆盖外侧的阴影留白。
 * 面板的 getBoundingClientRect 已含 transform 缩放，与指针坐标同一套。
 */
function cornerAt(x: number, y: number): Corner | null {
  const r = panelEl.getBoundingClientRect()
  const zone = RESIZE_ZONE * scale
  const atLeft = x <= r.left + zone
  const atRight = x >= r.right - zone
  const atTop = y <= r.top + zone
  const atBottom = y >= r.bottom - zone
  if (atBottom && atLeft) return 'bottom_left'
  if (atBottom && atRight) return 'bottom_right'
  if (atTop && atLeft) return 'top_left'
  if (atTop && atRight) return 'top_right'
  return null
}

function rectHas(el: HTMLElement, x: number, y: number): boolean {
  const r = el.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/** 视口坐标命中的可点击目标。 */
function clickTargetAt(x: number, y: number): ClickTarget | null {
  // 生理期卡片：仅在信息卡页且可见时命中。
  if (periodVisible && rightPager.index === PAGE_CARDS && rectHas(periodCardEl, x, y)) {
    return { kind: 'period' }
  }
  // 待办统计卡片：仅在左侧待办页命中。
  if (leftPager.index === LEFT_PAGE_TODO) {
    for (const key of Object.keys(todoValueEls)) {
      const card = todoValueEls[key].closest('.todo-card') as HTMLElement
      if (rectHas(card, x, y)) return { kind: 'todo', key }
    }
  }
  // 备忘录行：仅当前页是备忘录页、且坐标在滚动区可视矩形内时逐行判定——
  // 滚出可视区的行 rect 仍会给出旧坐标，不先限定容器就会盖住页头吞点击。
  if (rightPager.index === PAGE_MEMO && rectHas(memoRowsEl, x, y)) {
    for (const row of Array.from(memoRowsEl.children) as HTMLElement[]) {
      if (!rectHas(row, x, y)) continue
      const id = Number(row.dataset.id)
      const check = row.querySelector<HTMLElement>('.memo-check')!
      // 点方框直接切换完成状态，点文案打开编辑弹窗。
      const onCheck = x <= check.getBoundingClientRect().right
      return { kind: 'memo', id, onCheck }
    }
  }
  // 计划行：整行都是热区。
  if (rightPager.index === PAGE_PLAN && rectHas(planRowsEl, x, y)) {
    for (const row of Array.from(planRowsEl.children) as HTMLElement[]) {
      if (rectHas(row, x, y)) return { kind: 'plan', id: Number(row.dataset.id) }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 指针交互：拖拽 / 四角缩放 / 点击
// ---------------------------------------------------------------------------

function updateCursor(x: number, y: number): void {
  const corner = cornerAt(x, y)
  if (corner) {
    const { atLeft, atTop } = cornerSpec(corner)
    // 左上/右下显示「\」方向，左下/右上显示「/」方向。
    document.body.style.cursor = atLeft === atTop ? 'nwse-resize' : 'nesw-resize'
    return
  }
  document.body.style.cursor = clickTargetAt(x, y) ? 'pointer' : ''
}

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  pressScreen = { x: e.screenX, y: e.screenY }
  clickTarget = null
  const corner = cornerAt(e.clientX, e.clientY)
  if (corner) {
    resizing = true
    resizeCorner = corner
    void (async () => {
      const factor = await win.scaleFactor()
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      const { atLeft, atTop } = cornerSpec(corner)
      // 不参与拖动的那个角（CSS 像素）。
      resizeStart = {
        x: e.screenX,
        y: e.screenY,
        scale,
        anchor: {
          x: (atLeft ? pos.x + size.width : pos.x) / factor,
          y: (atTop ? pos.y + size.height : pos.y) / factor,
        },
      }
    })()
  } else {
    clickTarget = clickTargetAt(e.clientX, e.clientY)
    void (async () => {
      const factor = await win.scaleFactor()
      const pos = await win.outerPosition()
      dragOffset = { x: e.screenX - pos.x / factor, y: e.screenY - pos.y / factor }
    })()
  }
  try {
    document.body.setPointerCapture(e.pointerId)
  } catch {
    /* 旧 WebView 不支持时退化为窗口内拖拽 */
  }
}

async function onPointerMove(e: PointerEvent): Promise<void> {
  if (e.buttons !== 1 || !pressScreen) {
    updateCursor(e.clientX, e.clientY)
    return
  }
  if (resizing) {
    await resizeTo(e.screenX, e.screenY)
    return
  }
  if (dragOffset) {
    const monitor = await currentMonitor()
    const factor = await win.scaleFactor()
    let x = e.screenX - dragOffset.x
    let y = e.screenY - dragOffset.y
    if (monitor) {
      const size = await win.outerSize()
      const left = monitor.position.x / factor
      const top = monitor.position.y / factor
      const right = (monitor.position.x + monitor.size.width) / factor
      const bottom = (monitor.position.y + monitor.size.height) / factor
      x = Math.min(Math.max(x, left), Math.max(left, right - size.width / factor))
      y = Math.min(Math.max(y, top), Math.max(top, bottom - size.height / factor))
    }
    await win.setPosition(new PhysicalPosition(Math.round(x * factor), Math.round(y * factor)))
  }
}

/** 四角拖拽等比缩放：宽高各自推算比例后取均值，保持对角不动。 */
async function resizeTo(screenX: number, screenY: number): Promise<void> {
  if (!resizeStart || !resizeCorner) return
  const { atLeft, atTop } = cornerSpec(resizeCorner)
  // 左侧、上侧的角往外拖是负位移，取反后统一成「变大为正」。
  const dx = screenX - resizeStart.x
  const dy = screenY - resizeStart.y
  const offsetX = (atLeft ? -dx : dx) / scale
  const offsetY = (atTop ? -dy : dy) / scale
  // 起点时的窗口尺寸换算回设计稿比例。
  const next = (designW * resizeStart.scale + offsetX) / designW
  const next2 = (designH * resizeStart.scale + offsetY) / designH
  // 宽高各自推算一次比例后取均值，任意方向拖拽都能连续变化。
  await applyScale((next + next2) / 2, true)
}

async function onPointerUp(e: PointerEvent): Promise<void> {
  if (e.button !== 0) return
  try {
    document.body.releasePointerCapture(e.pointerId)
  } catch {
    /* 未捕获时忽略 */
  }
  const wasResizing = resizing
  const target = clickTarget
  const pressed = pressScreen
  resizing = false
  pressScreen = null
  clickTarget = null

  if (wasResizing) {
    void emit('work-ui', { type: 'scale', value: scale })
  }

  updateCursor(e.clientX, e.clientY)

  // 按下与松手的位移在容差内才算点击，拖动过窗口的不算。
  if (!target || !pressed) return
  const tolerance = CLICK_TOLERANCE * scale
  if (Math.abs(e.screenX - pressed.x) > tolerance) return
  if (Math.abs(e.screenY - pressed.y) > tolerance) return

  switch (target.kind) {
    case 'period':
      void emitUi({ type: 'period-click' })
      break
    case 'todo': {
      // 点待办统计卡片，右侧翻到对应的那一页。
      const page = target.key === 'memo' ? PAGE_MEMO : PAGE_PLAN
      if (setPage(rightPager, page)) notifyPage()
      break
    }
    case 'memo':
      if (target.onCheck) {
        void emitUi({ type: 'memo-toggle', id: target.id })
      } else {
        void emitUi({ type: 'memo-click', id: target.id })
      }
      break
    case 'plan':
      void emitUi({ type: 'plan-click', id: target.id })
      break
  }
}

/** 发 UI 事件给 pet 窗口，附上面板中心坐标（弹窗定位用）。 */
async function emitUi(payload: Record<string, unknown>): Promise<void> {
  const factor = await win.scaleFactor()
  const pos = await win.outerPosition()
  const size = await win.outerSize()
  await emit('work-ui', {
    ...payload,
    cx: (pos.x + size.width / 2) / factor,
    cy: (pos.y + size.height / 2) / factor,
  })
}

// ---------------------------------------------------------------------------
// 滚轮：Ctrl 调透明度，两块分页区域各自整页翻页，页内列表代为滚动
// ---------------------------------------------------------------------------

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) {
    e.preventDefault()
    opacityWheelDelta += e.deltaY
    const steps = Math.trunc(opacityWheelDelta / WHEEL_NOTCH)
    if (steps) {
      opacityWheelDelta -= steps * WHEEL_NOTCH
      // 向下滚（deltaY 正）调低透明度。
      adjustOpacity(-steps * OPACITY_STEP)
    }
    return
  }

  const x = e.clientX
  const y = e.clientY

  // 左侧角色区域自己两页，落在这块就横向翻它，不影响右侧页码。
  if (rectHas(leftPagerEl, x, y)) {
    if (!leftPager.animating) {
      leftWheelDelta = wheelToPage(leftPager, e.deltaY, leftWheelDelta)
      syncGif()
    }
    e.preventDefault()
    return
  }

  if (!rectHas(rightPagerEl, x, y)) return

  // 翻页动画进行中不接受新输入，避免叠加出半页停留；这一级必须排在页内
  // 滚动之前，滑动到一半的页面几何正在变化，命中判定不可靠。
  if (rightPager.animating) {
    e.preventDefault()
    return
  }

  // 悬停在页内列表上时由面板代为滚动，滚到尽头继续滚也不翻页。
  if (scrollLocal(x, y, e.deltaY)) {
    e.preventDefault()
    return
  }

  pageWheelDelta = wheelToPage(rightPager, e.deltaY, pageWheelDelta)
  notifyPage()
  e.preventDefault()
}

/**
 * 代替页内列表消费滚轮，真的滚了返回 True。
 * 内容没有溢出时返回 False，让滚轮照常翻页——此时并不存在「页内滚动」，
 * 吞掉只会让人以为面板卡住。
 */
function scrollLocal(x: number, y: number, deltaY: number): boolean {
  let rows: HTMLElement | null = null
  let rowH = 0
  if (rightPager.index === PAGE_MEMO) {
    rows = memoRowsEl
    rowH = MEMO_ROW_H
  } else if (rightPager.index === PAGE_PLAN) {
    rows = planRowsEl
    rowH = PLAN_ROW_H
  }
  if (!rows || rows.style.display === 'none') return false
  if (!rectHas(rows, x, y)) return false
  if (rows.scrollHeight <= rows.clientHeight) return false
  rows.scrollTop += (deltaY > 0 ? 1 : -1) * rowH * LOCAL_SCROLL_ROWS * scale
  return true
}

// ---------------------------------------------------------------------------
// 与 pet 窗口的通信
// ---------------------------------------------------------------------------

interface WorkStatePayload {
  values?: WorkValues
  memos?: Array<{ id: number; text: string; done: boolean }>
  plans?: PlanDisplay[]
  keyCount?: string
  keyCountVisible?: boolean
  periodVisible?: boolean
  scale?: number
  opacity?: number
  focusMemoId?: number | null
  focusPlanId?: number | null
  show: boolean
}

async function applyState(payload: WorkStatePayload): Promise<void> {
  // 只带 show:false 的收起通知（离开工作模式）没有其余字段。
  if (!payload.show) {
    await win.hide()
    return
  }
  if (payload.keyCountVisible !== undefined) setKeyCountVisible(payload.keyCountVisible)
  if (payload.periodVisible !== undefined) setPeriodVisible(payload.periodVisible)
  if (payload.keyCount !== undefined) setKeyCount(payload.keyCount)
  if (payload.memos) setMemoRows(payload.memos, payload.focusMemoId)
  if (payload.plans) setPlanRows(payload.plans, payload.focusPlanId)
  if (payload.values) applyValues(payload.values)

  if (payload.scale !== undefined && Math.abs(payload.scale - scale) > 0.001) {
    await applyScale(payload.scale)
  }
  if (payload.opacity !== undefined && Math.abs(payload.opacity - opacity) > 0.001) {
    applyOpacity(payload.opacity)
  }
  await showWindow()
}

/** 首次显示时贴主屏右下角；之后沿用当前位置。 */
async function showWindow(): Promise<void> {
  if (!hasShown) {
    const factor = await win.scaleFactor()
    const monitor = await currentMonitor()
    if (monitor) {
      const w = designW * scale
      const h = designH * scale
      const right = (monitor.position.x + monitor.size.width) / factor
      const bottom = (monitor.position.y + monitor.size.height) / factor
      await win.setPosition(new PhysicalPosition(
        Math.round((right - w - 20) * factor),
        Math.round((bottom - h - 60) * factor),
      ))
    }
    hasShown = true
  }
  await win.show()
  await win.setFocus()
}

/** 角色翻到待办页后 GIF 被裁掉，藏起来不再解码省 CPU；翻回来再显示。 */
function syncGif(): void {
  gifEl.style.visibility = leftPager.index === LEFT_PAGE_GIF ? '' : 'hidden'
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function bindEvents(): void {
  window.addEventListener('pointerdown', (e) => onPointerDown(e))
  window.addEventListener('pointermove', (e) => void onPointerMove(e))
  window.addEventListener('pointerup', (e) => void onPointerUp(e))
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    // 右键菜单由 pet 窗口统一弹出（复用 open_menu_window）。
    void emitUi({ type: 'menu', x: e.screenX, y: e.screenY })
  })
  window.addEventListener('wheel', (e) => onWheel(e), { passive: false })
}

export async function startWork(): Promise<void> {
  measureDesign()
  bindEvents()
  syncGif()

  await listen<WorkStatePayload>('work-state', (event) => {
    // 出错也要把窗口亮出来：pet 窗口此刻已经隐藏，面板再不显示整个
    // 程序就「消失」了。错误写进 debug.log 供排查。
    void applyState(event.payload).catch(async (err) => {
      console.error('applyState 失败:', err)
      void invoke('debug_log', { msg: `[work] applyState 失败: ${String(err)}` })
      try {
        await win.show()
      } catch {
        /* show 也失败时只能靠日志 */
      }
    })
  })

  // pet 窗口每秒推送一次轻量数值刷新（values + 按键数，计划有变化时附带）。
  await listen<{
    values: WorkValues
    keyCount: string
    plans?: PlanDisplay[]
  }>('work-tick', (event) => {
    setKeyCount(event.payload.keyCount)
    applyValues(event.payload.values)
    if (event.payload.plans) setPlanRows(event.payload.plans)
  })

  // 全局键盘计数（与 pet 窗口监听同一个事件，各自维护显示）。
  await listen<number>('key-pressed', (event) => {
    setKeyCount(`⌨ 总按键次数: ${event.payload}`)
  })

  // pet 就绪后的探询：ready 若在对方监听器注册前就已发出，这里补报一次。
  await listen('work-ping', () => {
    void emit('work-ui', { type: 'ready' })
  })

  void emit('work-ui', { type: 'ready' })
}

startWork().catch((err) => {
  console.error('工作面板启动失败:', err)
})
