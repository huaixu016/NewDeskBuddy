/**
 * 弹窗窗逻辑：按 `dialog-state` 下发的 kind 渲染四个弹窗之一。
 * 对应 Python 版 work_dialog.py / memo_dialog.py / plan_dialog.py /
 * period_dialog.py。
 *
 * 弹窗只编辑并返回数据：保存 / 删除 / 应用（生理期参数即时生效）分别以
 * `dialog-result` 事件回传 pet 窗口，落盘全部由 pet 窗口完成。
 * 定位：以 dialog-state 携带的 (cx, cy) 为中心显示（pet 窗口算好的
 * 「父窗口中心」），越界往屏幕内侧收敛。
 */
import { listen } from '@tauri-apps/api/event'
import { emit } from '@tauri-apps/api/event'
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import * as logic from './work-logic'

const win = getCurrentWindow()
const root = document.getElementById('dialog-root')!

export type DialogKind = 'work-config' | 'memo' | 'plan' | 'period'

export interface DialogState {
  kind: DialogKind
  memo?: logic.Memo | null
  plan?: logic.Plan | null
  /** pet 窗口的配置快照（work-config / period 弹窗回填用）。 */
  config: Record<string, string>
  /** 弹窗中心对准的屏幕坐标（CSS 像素）。 */
  cx: number
  cy: number
}

export interface DialogResult {
  kind: DialogKind
  action: 'save' | 'delete' | 'apply' | 'cancel'
  values?: Record<string, string>
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function cfgStr(cfg: Record<string, string>, key: string, fallback = ''): string {
  const v = cfg[key]
  return v === undefined || v === '' ? fallback : v
}

function cfgNum(cfg: Record<string, string>, key: string, fallback = 0): number {
  const v = parseFloat(cfg[key])
  return Number.isFinite(v) ? v : fallback
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date → `yyyy-MM-dd`。 */
function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Date → `HH:mm`。 */
function toTimeInput(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** Date → datetime-local 的 `yyyy-MM-ddTHH:mm`。 */
function toDateTimeInput(d: Date): string {
  return `${toDateInput(d)}T${toTimeInput(d)}`
}

/** datetime-local 的值 → 存储文本 `yyyy-MM-dd HH:mm`。 */
function fromDateTimeInput(value: string): string {
  return value ? value.replace('T', ' ') : ''
}

/** 存储文本 → datetime-local 的值。 */
function toDateTimeInputText(text: string): string {
  return text ? text.replace(' ', 'T') : ''
}

/** 下一个整点，供「设置」按钮回落使用。 */
function nextWholeHour(): Date {
  const moment = new Date(Date.now() + 3600000)
  return new Date(moment.getFullYear(), moment.getMonth(), moment.getDate(), moment.getHours(), 0)
}

function result(kind: DialogKind, action: DialogResult['action'], values?: Record<string, string>): void {
  void emit('dialog-result', { kind, action, values } satisfies DialogResult)
}

// ---------------------------------------------------------------------------
// 弹窗骨架：标题栏（可拖动）+ 内容 + 结果上报
// ---------------------------------------------------------------------------

interface DialogFrame {
  container: HTMLElement
  body: HTMLElement
  hint: HTMLElement
  close: () => void
}

function makeFrame(kind: DialogKind, title: string): DialogFrame {
  const container = el(
    'div',
    'dialog-container' + (kind === 'period' ? ' period' : kind === 'work-config' ? ' config' : ''),
  )
  const header = el('div', 'dialog-header')
  header.appendChild(el('div', 'dialog-title', title))
  const closeBtn = el('button', 'dialog-close', '✕')
  header.appendChild(closeBtn)
  container.appendChild(header)
  container.appendChild(el('div', 'dialog-divider'))

  const body = el('div', 'dialog-body')
  body.style.display = 'flex'
  body.style.flexDirection = 'column'
  body.style.gap = '12px'
  container.appendChild(body)

  const hint = el('div', 'dialog-hint')
  container.appendChild(hint)

  const close = () => {
    result(kind, 'cancel')
    void win.hide()
  }
  closeBtn.addEventListener('click', close)

  // 标题栏拖动弹窗。
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const startScreen = { x: e.screenX, y: e.screenY }
    let startPos: { x: number; y: number } | null = null
    const move = (ev: PointerEvent) => {
      void (async () => {
        if (!startPos) {
          const pos = await win.outerPosition()
          startPos = { x: pos.x, y: pos.y }
        }
        await win.setPosition(new PhysicalPosition(
          startPos.x + (ev.screenX - startScreen.x),
          startPos.y + (ev.screenY - startScreen.y),
        ))
      })()
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  return { container, body, hint, close }
}

function showHint(frame: DialogFrame, text: string, ok = false): void {
  frame.hint.textContent = text
  frame.hint.className = 'dialog-hint ' + (ok ? 'ok' : 'error')
}

function makeFormRow(label?: string): { row: HTMLElement; body: HTMLElement } {
  const row = el('div', 'form-row')
  const body = el('div', 'form-body')
  if (label) row.appendChild(el('div', 'form-label', label))
  row.appendChild(body)
  return { row, body }
}

function makeSwitch(checked: boolean, onToggle: (checked: boolean) => void): HTMLElement {
  const label = el('label', 'switch')
  const input = el('input') as HTMLInputElement
  input.type = 'checkbox'
  input.checked = checked
  const slider = el('span', 'slider')
  label.appendChild(input)
  label.appendChild(slider)
  input.addEventListener('change', () => onToggle(input.checked))
  return label
}

function makeNumber(value: number, min: number, max: number, step: number): HTMLInputElement {
  const input = el('input') as HTMLInputElement
  input.type = 'number'
  input.min = String(min)
  input.max = String(max)
  input.step = String(step)
  input.value = String(value)
  return input
}

// ---------------------------------------------------------------------------
// 工作配置弹窗（work_dialog.py）
// ---------------------------------------------------------------------------

const REST_TYPES = ['双休', '大小周', '单休', '其他']
const WEEKDAY_NAMES = logic.WEEKDAY_NAMES

function buildWorkConfig(frame: DialogFrame, state: DialogState): void {
  const cfg = state.config
  const body = frame.body

  const addRow = (label: string, ...controls: HTMLElement[]) => {
    const { row, body: rowBody } = makeFormRow(label)
    for (const control of controls) rowBody.appendChild(control)
    body.appendChild(row)
    return row
  }

  const offTime = el('input') as HTMLInputElement
  offTime.type = 'time'
  offTime.value = cfgStr(cfg, 'work_off_time', '17:00')
  addRow('下班时间:', offTime)

  const payday = makeNumber(Math.round(cfgNum(cfg, 'work_payday', 15)), 1, 31, 1)
  addRow('发薪日:', payday, el('span', 'form-hint', ' 号'))

  const festivalName = el('input') as HTMLInputElement
  festivalName.type = 'text'
  festivalName.maxLength = 8
  festivalName.value = cfgStr(cfg, 'work_festival_name')
  festivalName.style.flex = '1'
  addRow('节日名称:', festivalName)

  // 节日日期：空 = 未设置，按钮在「设置 / 清空」间切换。
  const festivalDate = el('input') as HTMLInputElement
  festivalDate.type = 'date'
  const festivalBtn = el('button', 'btn-minor') as HTMLButtonElement
  const syncFestival = () => {
    const unset = festivalDate.value === ''
    festivalDate.disabled = unset
    festivalBtn.textContent = unset ? '设置' : '清空'
  }
  festivalBtn.addEventListener('click', () => {
    festivalDate.value = festivalDate.value ? '' : toDateInput(new Date())
    syncFestival()
  })
  festivalDate.value = cfgStr(cfg, 'work_festival_date')
  syncFestival()
  addRow('节日日期:', festivalDate, festivalBtn)

  const weekday = el('select') as HTMLSelectElement
  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    const option = el('option', undefined, WEEKDAY_NAMES[i]) as HTMLOptionElement
    option.value = String(i + 1)
    weekday.appendChild(option)
  }
  const weekdayValue = Math.round(cfgNum(cfg, 'work_target_weekday', 5))
  weekday.value = String(Math.min(7, Math.max(1, weekdayValue)))
  addRow('盼望的日子:', weekday)

  // 生理期卡片开关。
  const periodHint = el('span', 'form-hint')
  const periodSwitch = makeSwitch(cfgStr(cfg, 'period_visible', 'false') === 'true', (checked) => {
    periodHint.textContent = checked ? '面板中显示' : '面板中隐藏'
  })
  periodHint.textContent = cfgStr(cfg, 'period_visible', 'false') === 'true' ? '面板中显示' : '面板中隐藏'
  addRow('生理期卡片:', periodSwitch, periodHint)

  // 面板透明度滑块（百分比整数）。
  const opacityHint = el('span', 'range-hint')
  const opacitySlider = el('input') as HTMLInputElement
  opacitySlider.type = 'range'
  opacitySlider.min = '30'
  opacitySlider.max = '100'
  opacitySlider.step = '5'
  opacitySlider.value = String(Math.round(cfgNum(cfg, 'work_opacity', 1) * 100))
  opacityHint.textContent = `${opacitySlider.value}%`
  opacitySlider.addEventListener('input', () => {
    opacityHint.textContent = `${opacitySlider.value}%`
  })
  addRow('面板透明度:', opacitySlider, opacityHint)

  // ---- 日赚金额 ----
  const earnRadios: Record<string, HTMLInputElement> = {}
  const earnGroup = el('div', 'radio-group')
  for (const [value, text] of [
    ['auto', '自动累计（按下方计薪参数实时计算）'],
    ['fixed', '固定金额'],
  ] as Array<[string, string]>) {
    const label = el('label')
    const radio = el('input') as HTMLInputElement
    radio.type = 'radio'
    radio.name = 'earn-mode'
    radio.value = value
    label.appendChild(radio)
    label.appendChild(el('span', undefined, text))
    earnGroup.appendChild(label)
    earnRadios[value] = radio
  }
  const isFixed = cfgStr(cfg, 'work_earn_mode', 'auto') === 'fixed'
  earnRadios[isFixed ? 'fixed' : 'auto'].checked = true
  addRow('日赚金额:', earnGroup)

  const salary = makeNumber(cfgNum(cfg, 'salary', 0), 0, 999999, 0.01)
  salary.style.width = '130px'
  addRow('月薪资:', salary)

  const fixedEarn = makeNumber(cfgNum(cfg, 'work_fixed_earn', 0), 0, 999999, 0.001)
  fixedEarn.style.width = '130px'
  addRow('固定日赚:', fixedEarn)

  body.appendChild(el('div', 'section-hint', '以下为「自动累计」的计薪参数'))

  // 休息制度（2×2 单选）。
  const restRadios: Record<string, HTMLInputElement> = {}
  const restGrid = el('div', 'radio-grid')
  for (const text of REST_TYPES) {
    const label = el('label')
    const radio = el('input') as HTMLInputElement
    radio.type = 'radio'
    radio.name = 'rest-type'
    radio.value = text
    label.appendChild(radio)
    label.appendChild(el('span', undefined, text))
    restGrid.appendChild(label)
    restRadios[text] = radio
  }
  let restType = cfgStr(cfg, 'rest_type', '双休')
  if (!REST_TYPES.includes(restType)) restType = REST_TYPES[0]
  restRadios[restType].checked = true
  addRow('休息制度:', restGrid)

  // 月休息天数：只有「其他」才要填。
  const customRest = makeNumber(cfgNum(cfg, 'custom_rest_days', 0), 0, 31, 1)
  const customRestRow = addRow('月休息天数:', customRest)
  const syncCustomRest = () => {
    customRestRow.style.display = restRadios['其他'].checked ? '' : 'none'
  }
  for (const radio of Object.values(restRadios)) {
    radio.addEventListener('change', syncCustomRest)
  }
  syncCustomRest()

  // 上下班时间。
  const timeEdits: Array<[string, HTMLInputElement]> = []
  for (const [key, label] of [
    ['am_start', '上午上班:'],
    ['am_end', '上午下班:'],
    ['pm_start', '下午上班:'],
    ['pm_end', '下午下班:'],
  ] as Array<[string, string]>) {
    const input = el('input') as HTMLInputElement
    input.type = 'time'
    input.value = cfgStr(cfg, key, key.endsWith('start') ? (key === 'am_start' ? '09:00' : '13:00') : (key === 'am_end' ? '12:00' : '18:00'))
    addRow(label, input)
    timeEdits.push([key, input])
  }

  // 选「固定金额」时月薪与整组计薪参数一个都用不上，一起置灰。
  const earnDependent = [salary, customRest, ...timeEdits.map(([, input]) => input)]
  const syncEarnFields = () => {
    const fixed = earnRadios['fixed'].checked
    for (const control of earnDependent) control.disabled = fixed
    restGrid.style.opacity = fixed ? '0.5' : ''
    restGrid.style.pointerEvents = fixed ? 'none' : ''
  }
  for (const radio of Object.values(earnRadios)) {
    radio.addEventListener('change', syncEarnFields)
  }
  syncEarnFields()

  const buttons = el('div', 'dialog-buttons')
  const saveBtn = el('button', 'btn btn-primary', '✨ 保存配置') as HTMLButtonElement
  buttons.appendChild(el('div', 'spacer'))
  buttons.appendChild(saveBtn)
  body.appendChild(buttons)

  saveBtn.addEventListener('click', () => {
    const values: Record<string, string> = {
      work_off_time: offTime.value || '17:00',
      work_payday: payday.value,
      work_festival_name: festivalName.value.trim(),
      work_festival_date: festivalDate.value,
      work_target_weekday: weekday.value,
      period_visible: String(periodSwitch.querySelector('input')!.checked),
      work_opacity: String(Math.round(Number(opacitySlider.value) / 100 * 100) / 100),
      work_earn_mode: earnRadios['fixed'].checked ? 'fixed' : 'auto',
      work_fixed_earn: fixedEarn.value || '0',
      salary: salary.value || '0',
      rest_type: Object.entries(restRadios).find(([, radio]) => radio.checked)?.[0] ?? '双休',
      custom_rest_days: customRest.value || '0',
    }
    for (const [key, input] of timeEdits) values[key] = input.value
    result('work-config', 'save', values)
    void win.hide()
  })
}

// ---------------------------------------------------------------------------
// 备忘录弹窗（memo_dialog.py）
// ---------------------------------------------------------------------------

const MEMO_TEXT_MAX = 200

function buildMemo(frame: DialogFrame, state: DialogState): void {
  const memo = state.memo ?? null
  const body = frame.body

  const captionRow = makeFormRow()
  captionRow.body.appendChild(el('span', 'form-hint', '备忘内容'))
  const countLabel = el('span', 'count-label')
  captionRow.body.appendChild(el('div', 'spacer'))
  captionRow.body.appendChild(countLabel)
  captionRow.row.classList.add('stacked')
  body.appendChild(captionRow.row)

  const textEdit = el('textarea') as HTMLTextAreaElement
  textEdit.rows = 5
  textEdit.style.height = '110px'
  textEdit.placeholder = '例如：整理会议纪要并同步团队'
  if (memo) textEdit.value = memo.text
  body.appendChild(textEdit)

  body.appendChild(el('div', 'field-tip', 'Enter 换行，Ctrl + Enter 直接保存'))

  const doneHint = el('span', 'form-hint')
  const doneSwitch = makeSwitch(!!memo?.done, (checked) => {
    doneHint.textContent = checked ? '已完成' : '未完成'
  })
  doneHint.textContent = memo?.done ? '已完成' : '未完成'
  const doneRow = makeFormRow('完成状态:')
  doneRow.body.appendChild(doneSwitch)
  doneRow.body.appendChild(doneHint)
  body.appendChild(doneRow.row)

  const limitText = () => {
    if (textEdit.value.length > MEMO_TEXT_MAX) {
      textEdit.value = textEdit.value.slice(0, MEMO_TEXT_MAX)
    }
    countLabel.textContent = `${textEdit.value.length}/${MEMO_TEXT_MAX}`
  }
  textEdit.addEventListener('input', limitText)
  limitText()

  const buttons = el('div', 'dialog-buttons')
  if (memo) {
    const deleteBtn = el('button', 'btn btn-delete', '🗑 删除') as HTMLButtonElement
    deleteBtn.title = '直接移除这条备忘录，不再二次确认'
    deleteBtn.addEventListener('click', () => {
      result('memo', 'delete')
      void win.hide()
    })
    buttons.appendChild(deleteBtn)
  }
  buttons.appendChild(el('div', 'spacer'))
  const saveBtn = el('button', 'btn btn-primary', '✨ 保存') as HTMLButtonElement
  buttons.appendChild(saveBtn)
  body.appendChild(buttons)

  const save = () => {
    if (!textEdit.value.trim()) {
      showHint(frame, '备忘内容不能为空。')
      textEdit.focus()
      return
    }
    result('memo', 'save', {
      text: textEdit.value.trim(),
      done: String(doneSwitch.querySelector('input')!.checked),
    })
    void win.hide()
  }
  saveBtn.addEventListener('click', save)
  textEdit.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') save()
  })
  textEdit.focus()
}

// ---------------------------------------------------------------------------
// 计划安排弹窗（plan_dialog.py）
// ---------------------------------------------------------------------------

function buildPlan(frame: DialogFrame, state: DialogState): void {
  const plan = state.plan ?? null
  const body = frame.body

  const titleEdit = el('input') as HTMLInputElement
  titleEdit.type = 'text'
  titleEdit.maxLength = 40
  titleEdit.placeholder = '例如：站会 · 会议室 A'
  titleEdit.style.flex = '1'
  if (plan) titleEdit.value = plan.title
  const titleRow = makeFormRow('事项:')
  titleRow.body.appendChild(titleEdit)
  body.appendChild(titleRow.row)

  /** 一个时间输入框 + 一个「清空 / 设置」小按钮。 */
  const makeTimeRow = (label: string, tooltip: string) => {
    const input = el('input') as HTMLInputElement
    input.type = 'datetime-local'
    input.title = tooltip
    const button = el('button', 'btn-minor') as HTMLButtonElement
    const sync = () => {
      const unset = input.value === ''
      input.disabled = unset
      button.textContent = unset ? '设置' : '清空'
    }
    button.addEventListener('click', () => {
      if (input.value) {
        input.value = ''
      } else if (!startEdit.input.value) {
        // 已填开始时间时默认给它之后一小时，少改一次。
        input.value = toDateTimeInput(nextWholeHour())
      } else {
        const base = new Date(startEdit.input.value)
        base.setHours(base.getHours() + 1)
        input.value = toDateTimeInput(base)
      }
      sync()
      syncStatusHint()
    })
    input.addEventListener('change', syncStatusHint)
    const row = makeFormRow(label)
    row.body.appendChild(input)
    row.body.appendChild(button)
    body.appendChild(row.row)
    return { input, sync }
  }

  const startEdit = makeTimeRow('开始时间:', '留空表示不设开始时间，该条直接算进行中')
  const endEdit = makeTimeRow('结束时间:', '留空表示不设结束时间，做完了点「✅ 标记结束」收尾')

  // 状态：没有下拉可挑，一行小字写出当前会显示成什么状态。
  const statusHint = el('div', 'form-hint')
  const statusRow = makeFormRow('状态:')
  statusRow.body.appendChild(statusHint)
  body.appendChild(statusRow.row)

  // 手动状态记在弹窗里，点保存才写回。
  let manualStatus = ''
  const loadedStatus = plan?.status && logic.STATUS_LABELS[plan.status] ? plan.status : ''

  let doneBtn: HTMLButtonElement | null = null
  let cancelBtn: HTMLButtonElement | null = null
  if (plan) {
    doneBtn = el('button', 'btn-quick', '✅ 标记结束') as HTMLButtonElement
    doneBtn.title = '把这条标成「已结束」，保存后不再按时间推导'
    cancelBtn = el('button', 'btn-quick', '🚫 标记取消') as HTMLButtonElement
    cancelBtn.title = '把这条标成「已取消」，列表里徽章转橙、事项加删除线'
    doneBtn.addEventListener('click', () => {
      manualStatus = logic.STATUS_DONE
      syncStatusActions()
      syncStatusHint()
    })
    cancelBtn.addEventListener('click', () => {
      manualStatus = logic.STATUS_CANCELED
      syncStatusActions()
      syncStatusHint()
    })
    const actionRow = makeFormRow()
    actionRow.body.appendChild(doneBtn)
    actionRow.body.appendChild(cancelBtn)
    body.appendChild(actionRow.row)
  }

  const syncStatusActions = () => {
    if (!doneBtn || !cancelBtn) return
    doneBtn.disabled = manualStatus === logic.STATUS_DONE
    cancelBtn.disabled = manualStatus === logic.STATUS_CANCELED
  }

  const syncStatusHint = () => {
    if (manualStatus) {
      const label = logic.STATUS_LABELS[manualStatus]
      statusHint.textContent = manualStatus === loadedStatus
        ? `已手动标为「${label}」，不再按时间推导`
        : `将改为「${label}」，保存后生效`
      return
    }
    const start = fromDateTimeInput(startEdit.input.value)
    const end = fromDateTimeInput(endEdit.input.value)
    if (!start && !end) {
      statusHint.textContent = '填好时间后按当前时刻自动推导状态'
      return
    }
    const current = logic.statusOf({ id: 0, title: '', start, end, status: '' })
    statusHint.textContent = `按时间自动推导，当前显示为：${logic.STATUS_LABELS[current]}`
  }

  // 回填现有内容；新增态默认从下一个整点开始。
  if (plan) {
    startEdit.input.value = toDateTimeInputText(plan.start)
    endEdit.input.value = toDateTimeInputText(plan.end)
    manualStatus = loadedStatus
  } else {
    startEdit.input.value = toDateTimeInput(nextWholeHour())
  }
  startEdit.sync()
  endEdit.sync()
  syncStatusActions()
  syncStatusHint()

  const buttons = el('div', 'dialog-buttons')
  if (plan) {
    const deleteBtn = el('button', 'btn btn-delete', '🗑 删除') as HTMLButtonElement
    deleteBtn.title = '直接移除这条计划，不再二次确认'
    deleteBtn.addEventListener('click', () => {
      result('plan', 'delete')
      void win.hide()
    })
    buttons.appendChild(deleteBtn)
  }
  buttons.appendChild(el('div', 'spacer'))
  const saveBtn = el('button', 'btn btn-primary', '✨ 保存') as HTMLButtonElement
  buttons.appendChild(saveBtn)
  body.appendChild(buttons)

  const save = () => {
    if (!titleEdit.value.trim()) {
      showHint(frame, '事项内容不能为空。')
      titleEdit.focus()
      return
    }
    const start = startEdit.input.value
    const end = endEdit.input.value
    if (!start && !end) {
      showHint(frame, '开始时间与结束时间至少要填一个。')
      return
    }
    if (start && end && end <= start) {
      showHint(frame, '结束时间要晚于开始时间。')
      return
    }
    result('plan', 'save', {
      title: titleEdit.value.trim(),
      start: fromDateTimeInput(start),
      end: fromDateTimeInput(end),
      status: manualStatus,
    })
    void win.hide()
  }
  saveBtn.addEventListener('click', save)
  titleEdit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save()
  })
  titleEdit.focus()
}

// ---------------------------------------------------------------------------
// 生理期详情弹窗（period_dialog.py）
// ---------------------------------------------------------------------------

function buildPeriod(frame: DialogFrame, state: DialogState): void {
  const cfg = state.config
  const body = frame.body

  // 详情区：随表单值实时刷新。
  const detailValues: Record<string, HTMLElement> = {}
  const grid = el('div', 'detail-grid')
  for (const [key, caption] of [
    ['next_start', '预估下次生理期'],
    ['phase', '当前生理阶段'],
    ['ovulation', '剩余排卵天数'],
    ['last_start', '上次生理期起始日'],
    ['period_days', '预估经期天数'],
  ] as Array<[string, string]>) {
    grid.appendChild(el('div', 'detail-key', caption))
    const value = el('div', 'detail-value', '--')
    grid.appendChild(value)
    detailValues[key] = value
  }
  body.appendChild(grid)
  body.appendChild(el('div', 'dialog-divider'))

  body.appendChild(el('div', 'section-hint', '调整周期参数'))

  const today = new Date()
  const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - logic.MAX_BACKTRACK_DAYS)
  const startEdit = el('input') as HTMLInputElement
  startEdit.type = 'date'
  startEdit.min = toDateInput(earliest)
  startEdit.max = toDateInput(today)

  const cycleSpin = makeNumber(logic.DEFAULT_CYCLE_DAYS, logic.CYCLE_DAYS_MIN, logic.CYCLE_DAYS_MAX, 1)
  const periodSpin = makeNumber(logic.DEFAULT_PERIOD_DAYS, logic.PERIOD_DAYS_MIN, logic.PERIOD_DAYS_MAX, 1)

  // 回填配置；起始日为空表示尚未配置，输入框显示今天但不算已设置。
  const parsedStart = logic.parseStartDate(cfgStr(cfg, 'last_period_start'))
  let hasStart = parsedStart !== null
  const cycleValue = Math.round(cfgNum(cfg, 'cycle_days', logic.DEFAULT_CYCLE_DAYS))
  const periodValue = Math.round(cfgNum(cfg, 'period_days', logic.DEFAULT_PERIOD_DAYS))
  startEdit.value = toDateInput(parsedStart ?? today)
  cycleSpin.value = String(Math.min(logic.CYCLE_DAYS_MAX, Math.max(logic.CYCLE_DAYS_MIN, cycleValue)))
  periodSpin.value = String(Math.min(logic.PERIOD_DAYS_MAX, Math.max(logic.PERIOD_DAYS_MIN, periodValue)))

  const rows: Array<[string, HTMLElement[]]> = [
    ['上次经期起始', [startEdit]],
    ['平均周期天数', [cycleSpin, el('span', 'form-hint', ' 天')]],
    ['平均经期天数', [periodSpin, el('span', 'form-hint', ' 天')]],
  ]
  for (const [label, controls] of rows) {
    const row = makeFormRow(label)
    for (const control of controls) row.body.appendChild(control)
    body.appendChild(row.row)
  }

  // 快捷按钮：标记今日来潮 / 标记经期结束。
  const todayBtn = el('button', 'btn-quick', '🩸 标记今日来潮') as HTMLButtonElement
  const endBtn = el('button', 'btn-quick', '✅ 标记经期结束') as HTMLButtonElement
  endBtn.title = '以今天为本次经期最后一天，回写经期天数'
  const quickRow = makeFormRow()
  quickRow.body.appendChild(todayBtn)
  quickRow.body.appendChild(endBtn)
  body.appendChild(quickRow.row)

  const saveBtn = el('button', 'btn btn-primary', '✨ 保存设置') as HTMLButtonElement
  const saveWrap = el('div', 'dialog-buttons')
  saveWrap.style.justifyContent = 'center'
  saveWrap.appendChild(saveBtn)
  body.appendChild(saveWrap)

  body.appendChild(el('div', 'foot-note', '*仅为预估，实际以身体状态为准。'))

  const formConfig = (): logic.PeriodInput => ({
    lastPeriodStart: hasStart ? startEdit.value : '',
    cycleDays: Number(cycleSpin.value) || logic.DEFAULT_CYCLE_DAYS,
    periodDays: Number(periodSpin.value) || logic.DEFAULT_PERIOD_DAYS,
  })

  const refreshDetail = () => {
    const status = logic.buildStatus(formConfig())
    detailValues['next_start'].textContent = status.nextStartText
    detailValues['phase'].textContent = status.phaseText
    detailValues['ovulation'].textContent = status.ovulationText
    detailValues['last_start'].textContent = status.lastStartText
    detailValues['period_days'].textContent = status.periodDaysText
    // 仅在经期内才允许标记结束，否则回写天数没有意义。
    endBtn.disabled = !(status.state === logic.PERIOD_STATE_START || status.state === logic.PERIOD_STATE_IN_PERIOD)
  }

  const validate = (): string | null => {
    if (!hasStart) return '请先设置上次经期起始时间。'
    const start = new Date(startEdit.value + 'T00:00:00')
    if (start > today) return '上次经期起始时间不能晚于今天。'
    if (Math.round((today.getTime() - start.getTime()) / 86400000) > logic.MAX_BACKTRACK_DAYS) {
      return '上次经期起始时间距今过久，请重新选择。'
    }
    if (Number(periodSpin.value) >= Number(cycleSpin.value)) {
      return '平均经期天数必须小于平均周期天数。'
    }
    return null
  }

  const apply = (closeAfter: boolean) => {
    const error = validate()
    if (error) {
      showHint(frame, error)
      return
    }
    const values = {
      last_period_start: hasStart ? startEdit.value : '',
      cycle_days: cycleSpin.value,
      period_days: periodSpin.value,
    }
    refreshDetail()
    if (closeAfter) {
      result('period', 'save', values)
      void win.hide()
    } else {
      // 参数一经上报立即生效，主卡片无需等到弹窗关闭即可刷新。
      result('period', 'apply', values)
      showHint(frame, '已生效 ✓', true)
    }
  }

  startEdit.addEventListener('change', () => {
    hasStart = true
    refreshDetail()
  })
  cycleSpin.addEventListener('input', refreshDetail)
  periodSpin.addEventListener('input', refreshDetail)

  todayBtn.addEventListener('click', () => {
    hasStart = true
    startEdit.value = toDateInput(new Date())
    refreshDetail()
    apply(false)
  })

  endBtn.addEventListener('click', () => {
    const status = logic.buildStatus(formConfig())
    if (status.state !== logic.PERIOD_STATE_START && status.state !== logic.PERIOD_STATE_IN_PERIOD) {
      showHint(frame, '当前不在经期内，无需标记结束。')
      return
    }
    periodSpin.value = String(
      Math.min(logic.PERIOD_DAYS_MAX, Math.max(logic.PERIOD_DAYS_MIN, status.cycleDay)),
    )
    refreshDetail()
    apply(false)
  })

  saveBtn.addEventListener('click', () => apply(true))
  refreshDetail()
}

// ---------------------------------------------------------------------------
// 窗口显示 / 事件接线
// ---------------------------------------------------------------------------

async function showDialog(state: DialogState): Promise<void> {
  root.innerHTML = ''
  const frame = makeFrame(state.kind, titleOf(state))
  if (state.kind === 'work-config') buildWorkConfig(frame, state)
  else if (state.kind === 'memo') buildMemo(frame, state)
  else if (state.kind === 'plan') buildPlan(frame, state)
  else buildPeriod(frame, state)
  root.appendChild(frame.container)

  // 隐藏状态下量尺寸（容器定宽，量出的值不依赖窗口当前大小）。
  const rect = frame.container.getBoundingClientRect()
  const margin = 40 // root padding 20 × 2
  const w = Math.ceil(rect.width) + margin
  const h = Math.ceil(rect.height) + margin

  const factor = await win.scaleFactor()
  const monitor = await currentMonitor()
  let x = state.cx - w / 2
  let y = state.cy - h / 2
  if (monitor) {
    const left = monitor.position.x / factor
    const top = monitor.position.y / factor
    const right = (monitor.position.x + monitor.size.width) / factor
    const bottom = (monitor.position.y + monitor.size.height) / factor
    x = Math.min(Math.max(x, left), Math.max(left, right - w))
    y = Math.min(Math.max(y, top), Math.max(top, bottom - h))
  }

  await win.setSize(new PhysicalSize(Math.round(w * factor), Math.round(h * factor)))
  await win.setPosition(new PhysicalPosition(Math.round(x * factor), Math.round(y * factor)))
  await win.show()
  await win.setFocus()
}

function titleOf(state: DialogState): string {
  switch (state.kind) {
    case 'work-config':
      return '🖥️ 工作模式配置'
    case 'memo':
      return state.memo ? '📝 编辑备忘录' : '📝 新增备忘录'
    case 'plan':
      return state.plan ? '📅 编辑计划' : '📅 新增计划'
    case 'period':
      return '🩸 生理期详情'
  }
}

// Esc 关闭当前弹窗。
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    void (async () => {
      await win.hide()
    })()
  }
})

void listen<DialogState>('dialog-state', (event) => {
  void showDialog(event.payload)
})

// pet 窗口请求收起弹窗（切页 / 切模式 / 关闭生理期开关）。
void listen('dialog-close', () => {
  void win.hide()
})
