/**
 * 宠物主窗口逻辑：模式状态机与全部鼠标交互。
 * 对应 Python 版 DesktopPet 中「默认模式 + 噜噜模式」的部分。
 */
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import * as config from './config'
import { SpriteAnimator } from './animator'
import { showBubble, bubbleText } from './bubble'
import { showPetMenu } from './menu'
import { preloadAll, loadFailures, retryLoad } from './sprites'
import {
  win,
  DRAG_THRESHOLD,
  TOP_DROP_THRESHOLD,
  moveTo,
  resizeTo,
  positionCss,
  cachedPos,
  sizeCss,
  screenAtCursor,
  dropTo,
  quit,
  type DropHandle,
} from './window'

// ---------------------------------------------------------------------------
// 常量（与 Python 版对齐）
// ---------------------------------------------------------------------------

type Mode = config.Mode

/** 噜噜模式的待机序列。 */
const LULU_IDLE = 'lulu_sway'
const LULU_STIFF = 'lulu_stiff'

const LULU_REACTIONS = [
  'lulu_hoop', 'lulu_anger', 'lulu_cry', 'lulu_pleasant',
  'lulu_sad', 'lulu_salute', 'lulu_shake', 'lulu_stiff', 'lulu_tickle',
]
const LULU_CLICK_POOL = ['lulu_pleasant', 'lulu_hoop']
const LULU_DBLCLICK_POOL = ['lulu_tickle', 'lulu_shake']
const LULU_MOOD_POOL = [
  'lulu_anger', 'lulu_sad', 'lulu_cry', 'lulu_salute', 'lulu_hoop', 'lulu_pleasant',
]

/** 默认模式的两套猫，双击角色来回切换。 */
const CAT_NORMAL = 'cat_normal'
const CAT_REST = 'cat_rest'

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let mode: Mode = 'default'
let animator: SpriteAnimator
let spriteEl: HTMLCanvasElement
let keyCountEl: HTMLElement
let appEl: HTMLElement

let keyCount = 0

/** 当前是否处于拖拽判定中。 */
// 拖拽 / 点击判定状态
let pressPos: { x: number; y: number } | null = null
let pressTime = 0
let isDragging = false
let dragOffset = { x: 0, y: 0 }
let singleClickTimer: number | null = null
let pendingClick = false

// 噜噜模式状态
let luluReacting = false
let moodTimer: number | null = null
let dropAnimation: DropHandle | null = null

// ---------------------------------------------------------------------------
// 布局：窗口尺寸随当前序列变化
// ---------------------------------------------------------------------------

/**
 * 模式切换与布局调整的串行队列。
 * 菜单动作是 `void handleMenuAction(...)` 直接起的，连点两次模式会让两轮
 * applyMode / resizeTo 交叠，后完成的那次可能把窗口尺寸改回旧模式。
 */
let taskQueue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): Promise<void> {
  const run = taskQueue.then(task)
  // 单次失败不能把后续所有切换挂死。
  taskQueue = run.catch(() => {})
  return run
}

/**
 * 按当前序列的帧尺寸调整窗口与内部布局。
 * default 模式：padding 5、按键计数标签上移 20px 补偿雪碧图底部透明留白。
 * lulu 模式：padding 10。
 */
async function applyLayout(): Promise<void> {
  const size = animator.size
  if (size <= 0) return

  const keyVisible = config.bool('key_count_visible', true)
  const keyHeight = keyVisible ? keyCountEl.offsetHeight || 26 : 0
  const isLulu = mode === 'lulu'
  const padding = isLulu ? 10 : 5
  const labelOverlap = !isLulu && keyVisible ? 20 : 0

  const winW = size + padding * 2
  const winH = size + padding * 2 + (keyVisible ? keyHeight + 4 : 0) - labelOverlap

  spriteEl.style.left = `${padding}px`
  spriteEl.style.top = `${padding}px`
  keyCountEl.style.display = keyVisible ? '' : 'none'
  positionKeyLabel(winW, winH, keyVisible)

  await resizeTo(winW, winH)
}

/** 按键计数标签贴窗口底部居中。 */
function positionKeyLabel(winW: number, _winH: number, visible: boolean): void {
  if (!visible) return
  keyCountEl.style.left = '0'
  keyCountEl.style.right = '0'
  keyCountEl.style.margin = '0 auto'
  keyCountEl.style.width = 'fit-content'
  keyCountEl.style.top = ''
  keyCountEl.style.bottom = '2px'
  void winW
}

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------

function stopMoodTimer(): void {
  if (moodTimer !== null) {
    window.clearTimeout(moodTimer)
    moodTimer = null
  }
}

function scheduleMoodTimer(): void {
  stopMoodTimer()
  const delay = 20000 + Math.floor(Math.random() * 20001)
  moodTimer = window.setTimeout(autoMood, delay)
}

async function autoMood(): Promise<void> {
  if (mode !== 'lulu') return
  // 正好在反应或拖拽中就跳过本次换心情，但必须照常排下一次：
  // 直接 return 会把随机心情定时器弄死，自动切情绪从此停摆。
  if (!luluReacting && !isDragging) {
    const mood = LULU_MOOD_POOL[Math.floor(Math.random() * LULU_MOOD_POOL.length)]
    playLuluReaction(mood, 12)
  }
  scheduleMoodTimer()
}

/** 播一段不循环的反应动画，结束后回到待机。 */
function playLuluReaction(seqName: string, fps: number): void {
  void invoke('debug_log', { msg: `[pet] playLuluReaction ${seqName}` })
  // 序列不可用（雪碧图没解码成功）时不能把 luluReacting 挂起来：
  // 结束回调不会来，自动心情和后续反应会被永久判定为「正在反应中」。
  if (!animator.playOnce(seqName, fps, () => void backToIdle())) {
    luluReacting = false
    void backToIdle()
    // 预载偶发失败的序列（WebView2 大图 decode 抽风）后台补载一次，
    // 让下一次触发同一个动作能正常播，而不是整个会话都点不动。
    void retryLoad(seqName)
    return
  }
  luluReacting = true
  void applyLayout()
}

async function backToIdle(): Promise<void> {
  if (mode !== 'lulu') return
  luluReacting = false
  animator.play(LULU_IDLE, 12, true)
  await applyLayout()
}

function defaultSeqName(): string {
  return config.bool('cat_resting', false) ? CAT_REST : CAT_NORMAL
}

async function applyMode(next: Mode): Promise<void> {
  // 模式切换会让旧模式下尚未确认的单击和降落动画全部失效。
  cancelSingleClick()
  dropAnimation?.cancel()
  dropAnimation = null
  mode = next
  stopMoodTimer()
  luluReacting = false

  if (mode === 'lulu') {
    animator.play(LULU_IDLE, 12, true)
    await applyLayout()
    scheduleMoodTimer()
  } else {
    const seq = defaultSeqName()
    animator.play(seq, 12, true)
    await applyLayout()
  }
}

// ---------------------------------------------------------------------------
// 按键计数
// ---------------------------------------------------------------------------

function updateKeyCount(count: number): void {
  keyCount = count
  keyCountEl.textContent = `⌨ 总按键次数: ${count}`
}

// ---------------------------------------------------------------------------
// 默认模式：双击换装
// ---------------------------------------------------------------------------

async function toggleDefaultSprite(): Promise<void> {
  // 进串行队列：双击连点 / 双击后立刻切模式时，两轮 save + applyLayout
  // 交叠可能把窗口尺寸改成错误模式的大小。
  return enqueue(async () => {
    const resting = !config.bool('cat_resting', false)
    await config.save({ cat_resting: String(resting) })
    const seq = resting ? CAT_REST : CAT_NORMAL
    animator.play(seq, 12, true)
    await applyLayout()
  })
}

// ---------------------------------------------------------------------------
// 顶部降落
// ---------------------------------------------------------------------------

async function maybeDrop(): Promise<boolean> {
  if (mode !== 'lulu' || !config.bool('lulu_top_drop', true)) return false
  const pos = await positionCss()
  const size = await sizeCss()
  const bounds = await screenAtCursor()
  if (pos.y - bounds.top < TOP_DROP_THRESHOLD) {
    const targetY = bounds.bottom - size.h - 10
    startDrop(targetY)
    return true
  }
  return false
}

function startDrop(targetY: number): void {
  dropAnimation?.cancel()
  // 降落过程中播放僵硬动画增加趣味。
  if (mode === 'lulu' && animator.play(LULU_STIFF, 12, true)) {
    luluReacting = true
    void applyLayout()
  }
  const handle = dropTo(targetY, () => {
    // 中途切模式或重新起跳时旧动画已被取消，落地回调只认当前这次。
    if (dropAnimation !== handle) return
    dropAnimation = null
    if (mode !== 'lulu') return
    void backToIdle()
    scheduleMoodTimer()
    const size = animator.size
    showBubble(appEl, bubbleText('drop'), Math.max(0, size / 2 - 20), 50)
  })
  dropAnimation = handle
}

// ---------------------------------------------------------------------------
// 鼠标交互：按下 / 移动 / 抬起 / 双击，与 Python 版一套判定
// ---------------------------------------------------------------------------

function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  // 降落中点击可中断动画。
  if (dropAnimation?.running) {
    dropAnimation.cancel()
    dropAnimation = null
    if (mode === 'lulu') void backToIdle()
  }
  pressPos = { x: e.screenX, y: e.screenY }
  pressTime = performance.now()
  isDragging = false
  // 记录按下点相对窗口左上角的偏移（用缓存位置，避免 await 竞态）。
  const pos = cachedPos()
  dragOffset = { x: e.screenX - pos.x, y: e.screenY - pos.y }
  // 指针捕获：移出窗口也能持续收到 move / up。
  try {
    appEl.setPointerCapture(e.pointerId)
  } catch {
    /* 旧 WebView 不支持时退化为窗口内拖拽 */
  }
}

async function onPointerMove(e: PointerEvent): Promise<void> {
  if (!pressPos || e.buttons !== 1) return
  const dx = e.screenX - pressPos.x
  const dy = e.screenY - pressPos.y
  if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
    isDragging = true
    cancelSingleClick()
    if (mode === 'lulu' && animator.play(LULU_STIFF, 12, true)) {
      luluReacting = true
      void applyLayout()
    }
  }
  if (isDragging) {
    const bounds = await screenAtCursor()
    const size = await sizeCss()
    const x = Math.min(Math.max(e.screenX - dragOffset.x, bounds.left), bounds.right - size.w)
    const y = Math.min(Math.max(e.screenY - dragOffset.y, bounds.top), bounds.bottom - size.h)
    await moveTo(x, y)
  }
}

async function onPointerUp(e: PointerEvent): Promise<void> {
  if (e.button !== 0) return
  try {
    appEl.releasePointerCapture(e.pointerId)
  } catch {
    /* 未捕获时忽略 */
  }
  // 先同步清掉本次按下的状态再进 await：maybeDrop / backToIdle 期间
  // 用户可能已经开始下一次按下，收尾时才清会把新状态一起抹掉。
  const wasDragging = isDragging
  const hadPress = pressPos !== null
  const held = performance.now() - pressTime
  pressPos = null
  isDragging = false

  if (wasDragging) {
    const dropped = await maybeDrop()
    if (!dropped && mode === 'lulu') {
      await backToIdle()
      scheduleMoodTimer()
    }
  } else if (hadPress && held < 500 && mode === 'lulu') {
    // 暂存单击，250ms 内没等到双击才真正执行。
    pendingClick = true
    if (singleClickTimer !== null) window.clearTimeout(singleClickTimer)
    singleClickTimer = window.setTimeout(onSingleClickConfirmed, 250)
  }
}

function cancelSingleClick(): void {
  if (singleClickTimer !== null) {
    window.clearTimeout(singleClickTimer)
    singleClickTimer = null
  }
  pendingClick = false
}

async function onSingleClickConfirmed(): Promise<void> {
  singleClickTimer = null
  if (!pendingClick || mode !== 'lulu') {
    pendingClick = false
    return
  }
  pendingClick = false
  const reaction = LULU_CLICK_POOL[Math.floor(Math.random() * LULU_CLICK_POOL.length)]
  playLuluReaction(reaction, 12)
  scheduleMoodTimer()
  const size = animator.size
  showBubble(appEl, bubbleText('click'), Math.max(0, size / 2 - 20), 50)
}

function onDoubleClick(): void {
  cancelSingleClick()
  if (mode === 'lulu') {
    const reaction = LULU_DBLCLICK_POOL[Math.floor(Math.random() * LULU_DBLCLICK_POOL.length)]
    playLuluReaction(reaction, 14)
    scheduleMoodTimer()
    const size = animator.size
    showBubble(appEl, bubbleText('dblclick'), Math.max(0, size / 2 - 20), 50)
  } else if (mode === 'default') {
    void toggleDefaultSprite()
  }
}

// ---------------------------------------------------------------------------
// 对外接口（菜单回调用）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 原生菜单动作分发
// ---------------------------------------------------------------------------

/** 噜噜互动子菜单的 id（与 Rust 侧 LULU_REACTIONS 一一对应）。 */
const MENU_LULU_SEQS = [
  'lulu_pleasant', 'lulu_hoop', 'lulu_anger', 'lulu_cry',
  'lulu_sad', 'lulu_salute', 'lulu_tickle',
]

async function handleMenuAction(action: string): Promise<void> {
  switch (action) {
    case 'mode_default':
      await petActions.switchMode('default')
      break
    case 'mode_lulu':
      await petActions.switchMode('lulu')
      break
    case 'toggle_key_count':
      await petActions.toggleKeyCount()
      break
    case 'quit':
      await petActions.quit()
      break
    case 'lulu_random': {
      const pool = [...MENU_LULU_SEQS, 'lulu_shake', 'lulu_stiff']
      petActions.luluReact(pool[Math.floor(Math.random() * pool.length)])
      break
    }
    default:
      if (MENU_LULU_SEQS.includes(action)) petActions.luluReact(action)
      break
  }
}

export const petActions = {
  async switchMode(next: Mode): Promise<void> {
    return enqueue(async () => {
      await config.switchMode(next)
      await applyMode(next)
    })
  },
  luluReact(seqName: string): void {
    if (mode !== 'lulu') return
    if (LULU_REACTIONS.includes(seqName) || seqName === LULU_STIFF) {
      playLuluReaction(seqName, 12)
      scheduleMoodTimer()
    }
  },
  async toggleKeyCount(): Promise<void> {
    return enqueue(async () => {
      const next = !config.bool('key_count_visible', true)
      await config.save({ key_count_visible: String(next) })
      keyCountEl.style.display = next ? '' : 'none'
      await applyLayout()
    })
  },
  quit(): Promise<void> {
    return quit()
  },
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

export async function startApp(): Promise<void> {
  appEl = document.getElementById('app')!
  spriteEl = document.getElementById('sprite') as HTMLCanvasElement
  keyCountEl = document.getElementById('key-count')!

  await config.load()
  updateKeyCount(0)

  animator = new SpriteAnimator(spriteEl)

  // 预载全部雪碧图：切换序列（双击反应、拖拽僵硬）时不再因图片
  // 尚未解码而出现透明闪屏。
  await preloadAll()
  const failures = loadFailures()
  if (failures.length > 0) {
    // 缺图的序列一律播不出来，先记一笔，否则只能看到「点了没反应」。
    void invoke('debug_log', { msg: `[pet] 雪碧图加载失败: ${failures.join(', ')}` })
  }

  // 全局键盘计数：Rust 端事件推送。
  await listen<number>('key-pressed', (event) => {
    updateKeyCount(event.payload)
  })

  // 原生右键菜单的选中项分发。
  await listen<string>('menu-action', (event) => {
    void invoke('debug_log', { msg: `[pet] received ${event.payload}` })
    void handleMenuAction(event.payload)
  })

  // 指针交互挂在整个 app 上（窗口即宠物）：pointer + 捕获，
  // 拖出窗口边界也能持续收到 move / up。
  appEl.addEventListener('pointerdown', (e) => onPointerDown(e))
  window.addEventListener('pointermove', (e) => void onPointerMove(e))
  window.addEventListener('pointerup', (e) => void onPointerUp(e))
  appEl.addEventListener('dblclick', () => onDoubleClick())
  appEl.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    void showPetMenu(e.screenX, e.screenY)
  })

  // 拖拽开始时取消单击判定已在 onPointerMove 中处理；窗口失焦同样作废挂起的单击。
  window.addEventListener('blur', cancelSingleClick)

  // 缓存窗口当前位置：首次拖拽的偏移量计算依赖它。
  await positionCss()

  mode = config.resolvedMode()
  await applyMode(mode)

  await win.show()
}
