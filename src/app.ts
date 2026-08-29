/**
 * 宠物主窗口逻辑：模式状态机与全部鼠标交互。
 * 对应 Python 版 DesktopPet 中「默认模式 + 噜噜模式」的部分。
 */
import { listen } from '@tauri-apps/api/event'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import * as config from './config'
import { SpriteAnimator } from './animator'
import { showBubble, bubbleText } from './bubble'
import { showPetMenu } from './menu'
import { preloadAll, loadFailures, retryLoad } from './sprites'
import * as work from './work-logic'
import type { DialogResult } from './dialog'
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
// 工作模式状态（对应 Python 版 DesktopPet 的工作模式分支）
// ---------------------------------------------------------------------------

/** 备忘录与计划的内存副本（后端 store.rs 读写 JSON 文件）。 */
let memos: work.Memo[] = []
let plans: work.Plan[] = []
/** 上一次下发给面板的计划展示内容，用于每秒刷新时去重。 */
let planDisplay: work.PlanDisplay[] | null = null
/** 工作模式每秒刷新定时器。 */
let workTickTimer: number | null = null
/** 工作面板是否已就绪（常驻隐藏窗口，加载完成后经 work-ui ready 通报）。 */
let workReady = false
/** 进入工作模式时窗口是否已隐藏。 */
let petHiddenByWork = false

function stopWorkTick(): void {
  if (workTickTimer !== null) {
    window.clearInterval(workTickTimer)
    workTickTimer = null
  }
}

function startWorkTick(): void {
  stopWorkTick()
  // 每秒刷新倒计时 / 信息卡 / 计划状态（状态是时间驱动的）。
  workTickTimer = window.setInterval(() => void tickWork(), 1000)
}

function keyCountText(): string {
  return `⌨ 总按键次数: ${keyCount}`
}

/** 组装一次完整的面板状态并推给 work 窗口。 */
async function pushWorkState(options: {
  show: boolean
  focusMemoId?: number | null
  focusPlanId?: number | null
}): Promise<void> {
  if (!workReady) {
    // 面板未就绪：进队列等 ready 事件补推（handleWorkUi 里已处理），
    // 这里记一笔，排查「看不到面板」时先看这条有没有出现。
    void invoke('debug_log', { msg: '[pet] pushWorkState skipped: panel not ready' })
    return
  }
  void invoke('debug_log', { msg: `[pet] pushWorkState show=${options.show}` })
  await emit('work-state', {
    values: work.collectWorkValues(memos, plans),
    memos,
    plans: planDisplay ?? work.collectPlanValues(plans),
    keyCount: keyCountText(),
    keyCountVisible: config.bool('key_count_visible', true),
    periodVisible: config.bool('period_visible', false),
    scale: config.num('work_scale', 0.65),
    opacity: config.num('work_opacity', 1),
    focusMemoId: options.focusMemoId ?? null,
    focusPlanId: options.focusPlanId ?? null,
    show: options.show,
  })
}

/** 每秒一次的轻量刷新：倒计时 / 信息卡 / 待办计数 / 计划状态。 */
async function tickWork(): Promise<void> {
  if (mode !== 'work' || !workReady) return
  // 计划展示内容先去重再下发：一分钟之内多半没有任何变化，省掉的是
  // 每秒重算一遍文案与整个列表的 DOM 重建。
  const values = work.collectPlanValues(plans)
  const changed = JSON.stringify(values) !== JSON.stringify(planDisplay)
  if (changed) planDisplay = values
  await emit('work-tick', {
    values: work.collectWorkValues(memos, plans),
    keyCount: keyCountText(),
    plans: changed ? values : undefined,
  })
}

/** 进入工作模式：隐藏宠物窗口，显示工作面板并立即刷新一次数据。 */
/** 等面板就绪（ready 事件错过时的兜底），超时返回 false。 */
async function waitForWorkPanel(timeoutMs = 10000): Promise<boolean> {
  if (workReady) return true
  const startedAt = performance.now()
  while (!workReady && performance.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100))
  }
  return workReady
}

async function enterWorkMode(): Promise<void> {
  // 重新拉一次数据：其它途径（暂时没有）改过文件也能看到。
  memos = await invoke<work.Memo[]>('load_memos')
  plans = await invoke<work.Plan[]>('load_plans')
  planDisplay = work.collectPlanValues(plans)
  if (!await waitForWorkPanel()) {
    // 面板迟迟没就绪：宠物窗口不能藏，否则整个程序看起来消失了。
    void invoke('debug_log', { msg: '[pet] enterWorkMode: work panel not ready' })
    return
  }
  await pushWorkState({
    show: true,
    // 只有首次显示时给 focusId：列表直接停在「当前 / 接下来」那一段。
    focusPlanId: work.firstOpenPlanId(plans),
  })
  startWorkTick()
  petHiddenByWork = true
  await win.hide()
}

/** 离开工作模式：收起面板与全部弹窗，宠物窗口复位。 */
async function leaveWorkMode(): Promise<void> {
  stopWorkTick()
  await emit('work-state', { show: false })
  await closeDialog()
  petHiddenByWork = false
}

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
  const previous = mode
  mode = next
  stopMoodTimer()
  luluReacting = false
  animator.stop()

  // 离开工作模式：收起面板与弹窗，宠物窗口复位。
  if (previous === 'work' && mode !== 'work') {
    await leaveWorkMode()
    await win.show()
  }

  if (mode === 'work') {
    // 工作模式用独立悬浮窗，宠物窗口隐藏；数据就绪后面板自己亮相。
    await enterWorkMode()
    return
  }

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
    case 'mode_work':
      await petActions.switchMode('work')
      break
    case 'work_config':
      await openWorkConfig()
      break
    case 'memo_add':
      await openMemoDialog(null)
      break
    case 'plan_add':
      await openPlanDialog(null)
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

// ---------------------------------------------------------------------------
// 工作模式：弹窗与面板事件
// ---------------------------------------------------------------------------

/** 当前打开的备忘录 / 计划弹窗所编辑的条目 id（dialog-result 回来时定位用）。 */
let dialogMemoId: number | null = null
let dialogPlanId: number | null = null

/** 配置快照：dialog 窗口回填表单用（避免弹窗再走一次 invoke）。 */
function configSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const key of Object.keys(config.DEFAULTS)) {
    snapshot[key] = config.raw(key)
  }
  return snapshot
}

/** 上一次工作面板上报的中心坐标（弹窗默认贴着面板居中）。 */
let workCenter: { x: number; y: number } | null = null

/** 弹窗打开期间面板交互一律忽略（对应 Python 版弹窗的模态语义）。 */
let dialogOpen = false

/** 收起弹窗（翻页 / 切模式 / 关闭生理期开关时）。 */
async function closeDialog(): Promise<void> {
  dialogOpen = false
  await emit('dialog-close')
}

/** 打开弹窗：优先贴工作面板中心，其次贴宠物窗口，都没有就屏幕居中。 */
async function openDialog(kind: 'work-config' | 'memo' | 'plan' | 'period',
  payload: { memo?: work.Memo | null; plan?: work.Plan | null; center?: { x: number; y: number } } = {}): Promise<void> {
  dialogOpen = true
  let center = payload.center ?? workCenter
  if (!center) {
    const bounds = await screenAtCursor()
    const size = await sizeCss()
    const pos = cachedPos()
    center = { x: pos.x + size.w / 2, y: pos.y + size.h / 2 }
    // 宠物窗口初始位置在屏幕右下角，居中可能越界，收敛到屏幕内。
    center.x = Math.min(Math.max(center.x, bounds.left), bounds.right)
    center.y = Math.min(Math.max(center.y, bounds.top), bounds.bottom)
  }
  await emit('dialog-state', {
    kind,
    memo: payload.memo ?? null,
    plan: payload.plan ?? null,
    config: configSnapshot(),
    cx: center.x,
    cy: center.y,
  })
}

/** 修改工作配置（菜单入口；首次切工作模式也会走到这里，保存后自动进入）。 */
async function openWorkConfig(): Promise<void> {
  await openDialog('work-config')
}

/** 新增或编辑备忘录：弹窗只返回数据，增删改与落盘都在这里。 */
async function openMemoDialog(memo: work.Memo | null, center?: { x: number; y: number }): Promise<void> {
  dialogMemoId = memo?.id ?? null
  await openDialog('memo', { memo, center })
}

/** 新增或编辑计划安排。 */
async function openPlanDialog(plan: work.Plan | null, center?: { x: number; y: number }): Promise<void> {
  dialogPlanId = plan?.id ?? null
  await openDialog('plan', { plan, center })
}

/** 备忘录落盘并刷新面板；写入失败也照常刷新界面。 */
async function saveMemos(focusId: number | null = null): Promise<void> {
  memos = await invoke<work.Memo[]>('save_memos', { memos })
  await pushWorkState({ show: mode === 'work', focusMemoId: focusId })
}

/** 计划落盘并刷新面板（保存前先排序，文件本身也保持有序）。 */
async function savePlans(focusId: number | null = null): Promise<void> {
  plans = await invoke<work.Plan[]>('save_plans', { plans })
  planDisplay = work.collectPlanValues(plans)
  await pushWorkState({ show: mode === 'work', focusPlanId: focusId })
}

/** 弹窗结果分发：保存 / 删除 / 应用，全部在这里落盘。 */
async function handleDialogResult(result: DialogResult): Promise<void> {
  // save / delete / cancel 都意味着弹窗关闭；apply（生理期快捷按钮）保持打开。
  if (result.action !== 'apply') dialogOpen = false

  if (result.kind === 'work-config' && result.action === 'save' && result.values) {
    await config.save({ ...result.values, work_config_initialized: 'true' })
    // 生理期卡片可见性 / 透明度可能变了，面板立即跟上。
    await pushWorkState({ show: mode === 'work' })
    await tickWork()
    // 配置来自「首次切工作模式」的路径：保存即进入工作模式。
    // 不再要求填了月薪：表单默认值（自动累计 / 薪资 0）也是有效配置。
    if (mode !== 'work' && !petHiddenByWork) {
      await config.switchMode('work')
      await applyMode('work')
    }
    return
  }

  if (result.kind === 'memo') {
    if (result.action === 'delete') {
      if (dialogMemoId === null) return
      memos = memos.filter((m) => m.id !== dialogMemoId)
      await saveMemos()
      return
    }
    if (result.action === 'save' && result.values) {
      const text = result.values.text ?? ''
      const done = result.values.done === 'true'
      if (dialogMemoId === null) {
        const nextId = await invoke<number>('next_memo_id')
        memos.push({ id: nextId, text, done })
        await saveMemos(nextId)
      } else {
        const memo = memos.find((m) => m.id === dialogMemoId)
        if (memo) {
          memo.text = text
          memo.done = done
          await saveMemos(memo.id)
        }
      }
    }
    return
  }

  if (result.kind === 'plan') {
    if (result.action === 'delete') {
      if (dialogPlanId === null) return
      plans = plans.filter((p) => p.id !== dialogPlanId)
      await savePlans()
      return
    }
    if (result.action === 'save' && result.values) {
      const values = {
        title: result.values.title ?? '',
        start: result.values.start ?? '',
        end: result.values.end ?? '',
        status: result.values.status ?? '',
      }
      if (dialogPlanId === null) {
        const nextId = await invoke<number>('next_plan_id')
        plans.push({ id: nextId, ...values })
        await savePlans(nextId)
      } else {
        const plan = plans.find((p) => p.id === dialogPlanId)
        if (plan) {
          plan.title = values.title
          plan.start = values.start
          plan.end = values.end
          plan.status = values.status
          await savePlans(plan.id)
        }
      }
    }
    return
  }

  if (result.kind === 'period') {
    // apply（快捷按钮）与 save（保存并关闭）都立即写配置刷新主卡片。
    if ((result.action === 'apply' || result.action === 'save') && result.values) {
      await config.save(result.values)
      await tickWork()
    }
  }
}

/** 工作面板回传的 UI 事件分发。 */
async function handleWorkUi(payload: Record<string, unknown>): Promise<void> {
  const type = payload.type as string
  // 能收到面板事件就说明面板活着——即便 ready 那次错过了也在这里自愈。
  workReady = true
  if (type === 'ready') {
    void invoke('debug_log', { msg: '[pet] work panel ready' })
    // 启动时就处于工作模式（面板加载慢于 applyMode）时补一次状态推送。
    if (mode === 'work') {
      planDisplay = work.collectPlanValues(plans)
      await pushWorkState({ show: true, focusPlanId: work.firstOpenPlanId(plans) })
      startWorkTick()
    }
    return
  }
  // 弹窗打开期间面板交互一律忽略（模态语义）。
  if (dialogOpen) return
  if (type === 'scale') {
    // 缩放结束后上报当前比例，写入配置，下次进入工作模式沿用当前大小。
    await config.save({ work_scale: String(Math.round(Number(payload.value) * 1000) / 1000) })
    return
  }
  if (type === 'opacity') {
    // 透明度停止调整后上报落盘。
    await config.save({ work_opacity: String(Math.round(Number(payload.value) * 100) / 100) })
    return
  }
  if (type === 'page') {
    // 翻离信息卡页时收起生理期详情弹窗：卡片被翻走后弹窗会孤零零留在原处。
    if (payload.index !== 0) await closeDialog()
    return
  }
  if (type === 'period-click') {
    // 点击生理期卡片唤起详情弹窗。
    await openDialog('period', { center: centerOf(payload) })
    return
  }
  if (type === 'memo-toggle') {
    // 点行首方框直接翻转完成状态并落盘，不再弹窗确认。
    const id = Number(payload.id)
    const memo = memos.find((m) => m.id === id)
    if (!memo) return
    memo.done = !memo.done
    await saveMemos()
    return
  }
  if (type === 'memo-click') {
    const memo = memos.find((m) => m.id === Number(payload.id))
    // 指定的条目已不存在时直接放行，不把编辑当成新增弹出空白框。
    if (memo) await openMemoDialog(memo, centerOf(payload))
    return
  }
  if (type === 'plan-click') {
    const plan = plans.find((p) => p.id === Number(payload.id))
    if (plan) await openPlanDialog(plan, centerOf(payload))
    return
  }
  if (type === 'menu') {
    // 工作面板上的右键：复用菜单窗口（带工作模式的条目与计数）。
    if (typeof payload.cx === 'number' && typeof payload.cy === 'number') {
      workCenter = { x: payload.cx, y: payload.cy }
    }
    await invoke('open_menu_window', {
      x: Number(payload.x),
      y: Number(payload.y),
      mode: 'work',
      keyCountVisible: config.bool('key_count_visible', true),
      memoCount: memos.length,
      planCount: plans.length,
    })
  }
}

/** 事件里带的面板中心坐标（work.ts 计算好后随事件附上）。 */
function centerOf(payload: Record<string, unknown>): { x: number; y: number } | undefined {
  if (typeof payload.cx === 'number' && typeof payload.cy === 'number') {
    return { x: payload.cx, y: payload.cy }
  }
  return undefined
}

export const petActions = {
  async switchMode(next: Mode): Promise<void> {
    return enqueue(async () => {
      // 首次切工作模式时弹一次配置窗（保存后自动进入工作模式）。
      // 之后（存在配置信息）就直接进入：表单默认值也算有效配置。
      if (next === 'work' && !config.bool('work_config_initialized', false)) {
        await openWorkConfig()
        return
      }
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

  // 工作模式的事件监听必须先于 preloadAll 注册：面板窗口启动很快，它上报的
  // ready 比雪碧图逐张解码（数秒）先到，晚注册会把那次一次性事件整个错过，
  // workReady 永远为 false，之后进入工作模式就什么都推不出去。
  await listen<Record<string, unknown>>('work-ui', (event) => {
    void handleWorkUi(event.payload)
  })
  await listen<DialogResult>('dialog-result', (event) => {
    void handleDialogResult(event.payload)
  })

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

  // 备忘录与计划：启动即加载（菜单计数与工作模式都要用）。
  memos = await invoke<work.Memo[]>('load_memos')
  plans = await invoke<work.Plan[]>('load_plans')

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

  // pet 就绪后 ping 一次：面板的 ready 若在监听器注册前就已发出（两窗口
  // 并发加载的窗口期），这一次 ping 让它重新上报，握手必然完成。
  await emit('work-ping')

  mode = config.resolvedMode()
  await applyMode(mode)

  // 工作模式下宠物窗口保持隐藏（面板由 enterWorkMode 驱动亮相）。
  if (mode !== 'work') {
    await win.show()
  }
}
