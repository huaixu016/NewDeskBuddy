/**
 * 工作模式的纯逻辑：生理期周期计算、计划状态推导、日赚累计与信息卡文案。
 * 对应 Python 版 period_tracker.py / plan_store.py（状态部分）/ main.py
 * （_collect_work_values 一族）。只做纯函数，不碰窗口与 DOM。
 */
import * as config from './config'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface Memo {
  id: number
  text: string
  done: boolean
}

/** 计划安排：时间为 `YYYY-MM-DD HH:mm` 或空串，status 空串表示自动推导。 */
export interface Plan {
  id: number
  title: string
  start: string
  end: string
  status: string
}

// ---------------------------------------------------------------------------
// 星期与通用
// ---------------------------------------------------------------------------

/** 星期序号沿用 ISO：周一为 1，周日为 7。 */
export const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

export const EARN_MODE_AUTO = 'auto'
export const EARN_MODE_FIXED = 'fixed'

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// ---------------------------------------------------------------------------
// 计划状态推导（plan_store.py）
// ---------------------------------------------------------------------------

export const STATUS_AUTO = ''
export const STATUS_TODO = 'todo'
export const STATUS_ACTIVE = 'active'
export const STATUS_DONE = 'done'
export const STATUS_CANCELED = 'canceled'

export const STATUS_LABELS: Record<string, string> = {
  [STATUS_TODO]: '待办',
  [STATUS_ACTIVE]: '进行中',
  [STATUS_DONE]: '已结束',
  [STATUS_CANCELED]: '已取消',
}

/** 解析 `YYYY-MM-DD HH:mm`，空值或格式非法时返回 null（与 Python strptime 同口径）。 */
export function parsePlanTime(text: string | undefined | null): Date | null {
  if (!text) return null
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  const date = new Date(y, mo - 1, d, h, mi)
  // Date 会把 2026-02-31 悄悄滚到 3 月，回查一次才能拦住。
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date
}

/** 把 Date 写成存储文本。 */
export function formatPlanTime(moment: Date): string {
  return `${moment.getFullYear()}-${pad2(moment.getMonth() + 1)}-${pad2(moment.getDate())} ${pad2(moment.getHours())}:${pad2(moment.getMinutes())}`
}

/** 取计划当前状态：用户手动设置的值优先，否则按时间推导。 */
export function statusOf(plan: Plan, now: Date = new Date()): string {
  if (plan.status && STATUS_LABELS[plan.status]) return plan.status
  const end = parsePlanTime(plan.end)
  const start = parsePlanTime(plan.start)
  // 有结束时间且已过点即为已结束；只填开始时间的永不自动结束。
  if (end && now >= end) return STATUS_DONE
  // 还没到开始时间即为待办；只填结束时间的直接算进行中。
  if (start && now < start) return STATUS_TODO
  return STATUS_ACTIVE
}

/** 条目的最后一个时刻，取开始与结束里晚的那个。 */
function lastMoment(plan: Plan): Date | null {
  const moments = [parsePlanTime(plan.start), parsePlanTime(plan.end)].filter(
    (m): m is Date => m !== null,
  )
  return moments.length ? new Date(Math.max(...moments.map((m) => m.getTime()))) : null
}

/** 条目是否该从列表里退场：已经收尾，并且整条都落在今天之前。 */
export function isArchived(plan: Plan, now: Date = new Date(), status?: string): boolean {
  const st = status ?? statusOf(plan, now)
  if (st !== STATUS_DONE && st !== STATUS_CANCELED) return false
  const moment = lastMoment(plan)
  // 按日期比而不是按时刻比：今天刚结束的事今天还要看得见，明天才退场。
  if (!moment) return false
  return moment.getFullYear() < now.getFullYear()
    || (moment.getFullYear() === now.getFullYear() && (
      moment.getMonth() < now.getMonth()
      || (moment.getMonth() === now.getMonth() && moment.getDate() < now.getDate())
    ))
}

// ---------------------------------------------------------------------------
// 计划展示内容（main.py _collect_plan_values）
// ---------------------------------------------------------------------------

/**
 * 计划安排的状态外观：待办蓝、进行中绿、已结束灰、已取消橙。
 * 每项为（徽章底色、徽章文字色、事项文字色、事项是否加删除线）。
 */
export const PLAN_PALETTE: Record<string, [string, string, string, boolean]> = {
  [STATUS_TODO]: ['#E7F0FB', '#4A90D9', '#55595E', false],
  [STATUS_ACTIVE]: ['#E3F4E6', '#4CA85E', '#55595E', false],
  // 已结束只转灰不划线：时间过去是事实，不是「作废」。
  [STATUS_DONE]: ['#ECEEF0', '#A5AAB0', '#A9AFB5', false],
  [STATUS_CANCELED]: ['#FBEEE7', '#D08A55', '#A9AFB5', true],
}

export interface PlanDisplay {
  id: number
  time: string
  title: string
  status: string
  palette: [string, string, string, boolean]
}

/**
 * 时刻文案：当天只给时刻，别的日期补上月日，跨年再补四位年份。
 * 只省当天这一种，「没有日期」本身就成了「就是今天」的信息。
 */
function stamp(moment: Date, today: Date): string {
  const sameDay =
    moment.getDate() === today.getDate()
    && moment.getMonth() === today.getMonth()
    && moment.getFullYear() === today.getFullYear()
  if (sameDay) return `${pad2(moment.getHours())}:${pad2(moment.getMinutes())}`
  if (moment.getFullYear() === today.getFullYear()) {
    return `${pad2(moment.getMonth() + 1)}-${pad2(moment.getDate())} ${pad2(moment.getHours())}:${pad2(moment.getMinutes())}`
  }
  return formatPlanTime(moment)
}

/** 把计划列表换算成面板的展示内容；过完又收尾的条目自己退场。 */
export function collectPlanValues(plans: Plan[], now: Date = new Date()): PlanDisplay[] {
  const today = now
  const values: PlanDisplay[] = []
  for (const plan of plans) {
    const start = parsePlanTime(plan.start)
    const end = parsePlanTime(plan.end)
    if (!start && !end) continue
    const status = statusOf(plan, now)
    if (isArchived(plan, now, status)) continue
    let time: string
    if (start && end) {
      // 起止都摆出来：只给开始时间的话，进行中的条目看不出还剩多久。
      time = `${stamp(start, today)} - ${stamp(end, today)}`
    } else if (start) {
      time = stamp(start, today)
    } else {
      // 没有开始时间，「截止」二字点明这个时刻是终点而不是起点。
      time = `截止 ${stamp(end!, today)}`
    }
    values.push({
      id: plan.id,
      time,
      title: plan.title,
      status: STATUS_LABELS[status],
      palette: PLAN_PALETTE[status] ?? PLAN_PALETTE[STATUS_TODO],
    })
  }
  return values
}

/** 第一条还没收尾的计划 id，供首次显示时定位列表。 */
export function firstOpenPlanId(plans: Plan[], now: Date = new Date()): number | null {
  const finished = [STATUS_DONE, STATUS_CANCELED]
  for (const plan of plans) {
    if (!finished.includes(statusOf(plan, now))) return plan.id
  }
  return null
}

// ---------------------------------------------------------------------------
// 生理期周期计算（period_tracker.py）
// ---------------------------------------------------------------------------

export const PERIOD_STATE_UNSET = 'unset'
export const PERIOD_STATE_START = 'start'
export const PERIOD_STATE_IN_PERIOD = 'in_period'
export const PERIOD_STATE_UPCOMING = 'upcoming'
export const PERIOD_STATE_WAITING = 'waiting'

export const PHASE_PERIOD = '经期'
export const PHASE_FOLLICULAR = '卵泡期'
export const PHASE_OVULATION = '排卵期'
export const PHASE_LUTEAL = '黄体期'

export const CYCLE_DAYS_MIN = 15
export const CYCLE_DAYS_MAX = 90
export const PERIOD_DAYS_MIN = 1
export const PERIOD_DAYS_MAX = 14
export const DEFAULT_CYCLE_DAYS = 28
export const DEFAULT_PERIOD_DAYS = 5

/** 上次经期起始日最多允许回溯的天数，超出视为配置异常。 */
export const MAX_BACKTRACK_DAYS = 730

/** 距离下次经期不足该天数时切换为「即将到来」。 */
const UPCOMING_DAYS = 3
/** 黄体期长度相对固定，排卵日由下次经期倒推得到。 */
const LUTEAL_DAYS = 14
/** 排卵日前后各若干天计入排卵期。 */
const OVULATION_SPAN = 2

/**
 * 生理期卡片底色：正常倒计时为豆沙浅粉，即将到来与经期中依次加深强化
 * 提醒，未配置数据时置灰弱化。每项为（底色、标题色、数值色）。
 */
export const PERIOD_PALETTE: Record<string, [string, string, string]> = {
  [PERIOD_STATE_WAITING]: ['#F7E3EA', '#AE979F', '#6E5A62'],
  [PERIOD_STATE_UPCOMING]: ['#F2C9D8', '#A2798A', '#9B4661'],
  [PERIOD_STATE_START]: ['#EDB6C9', '#95687A', '#8E3350'],
  [PERIOD_STATE_IN_PERIOD]: ['#EDB6C9', '#95687A', '#8E3350'],
  [PERIOD_STATE_UNSET]: ['#ECEDEF', '#B9BEC4', '#A0A5AB'],
}

function daysBetween(a: Date, b: Date): number {
  // 以本地日期差计算（截断到零点），与 Python (a - b).days 一致。
  const day0 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((day0(a) - day0(b)) / 86400000)
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** 解析上次经期起始日；缺失、格式非法或超出回溯范围时返回 null。 */
export function parseStartDate(value: string | undefined | null): Date | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const parsed = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (daysBetween(new Date(), parsed) > MAX_BACKTRACK_DAYS) return null
  return parsed
}

export interface PeriodInput {
  lastPeriodStart: string
  cycleDays: number
  periodDays: number
}

export interface PeriodStatus {
  state: string
  configured: boolean
  cycleDay: number
  daysUntilNext: number
  daysUntilOvulation: number
  ovulationDate: Date | null
  nextStartDate: Date | null
  lastStartDate: Date | null
  phase: string
  periodDays: number
  cardTitle: string
  cardValue: string
  nextStartText: string
  phaseText: string
  ovulationText: string
  lastStartText: string
  periodDaysText: string
}

/** 按参数与系统日期计算生理期状态，配置异常时回落到「待设置」。 */
export function buildStatus(input: PeriodInput, today: Date = new Date()): PeriodStatus {
  const lastStart = parseStartDate(input.lastPeriodStart)
  const cycleDays = clamp(
    Number.isFinite(input.cycleDays) ? input.cycleDays : DEFAULT_CYCLE_DAYS,
    CYCLE_DAYS_MIN,
    CYCLE_DAYS_MAX,
  )
  // 经期天数必须短于整个周期，否则阶段划分会失去意义。
  const periodDays = Math.min(
    clamp(
      Number.isFinite(input.periodDays) ? input.periodDays : DEFAULT_PERIOD_DAYS,
      PERIOD_DAYS_MIN,
      PERIOD_DAYS_MAX,
    ),
    cycleDays - 1,
  )

  const status: PeriodStatus = {
    state: PERIOD_STATE_UNSET,
    configured: false,
    cycleDay: 0,
    daysUntilNext: 0,
    daysUntilOvulation: 0,
    ovulationDate: null,
    nextStartDate: null,
    lastStartDate: lastStart,
    phase: PHASE_PERIOD,
    periodDays,
    cardTitle: '🩸 生理期',
    cardValue: '待设置',
    nextStartText: '待设置',
    phaseText: '待设置',
    ovulationText: '待设置',
    lastStartText: '待设置',
    periodDaysText: `${periodDays} 天`,
  }
  if (!lastStart) return status

  // 取模让周期向前向后都能延伸，起始日填成未来日期时同样成立。
  const dayInCycle = ((daysBetween(today, lastStart) % cycleDays) + cycleDays) % cycleDays
  const cycleDay = dayInCycle + 1
  const daysUntilNext = cycleDays - dayInCycle

  // 排卵日在周期内的下标（0 起），由下次经期倒推黄体期长度。
  const ovulationIndex = Math.max(periodDays, cycleDays - LUTEAL_DAYS - 1)
  const daysUntilOvulation =
    dayInCycle <= ovulationIndex
      ? ovulationIndex - dayInCycle
      : cycleDays - dayInCycle + ovulationIndex
  const ovulationDate = addDays(today, daysUntilOvulation)
  const nextStartDate = addDays(addDays(today, -dayInCycle), cycleDays)

  let state: string
  if (dayInCycle === 0) state = PERIOD_STATE_START
  else if (dayInCycle < periodDays) state = PERIOD_STATE_IN_PERIOD
  else if (daysUntilNext <= UPCOMING_DAYS) state = PERIOD_STATE_UPCOMING
  else state = PERIOD_STATE_WAITING

  let phase: string
  if (dayInCycle < periodDays) {
    phase = PHASE_PERIOD
  } else {
    const windowStart = Math.max(periodDays, ovulationIndex - OVULATION_SPAN)
    const windowEnd = Math.min(cycleDays - 1, ovulationIndex + OVULATION_SPAN)
    if (dayInCycle < windowStart) phase = PHASE_FOLLICULAR
    else if (dayInCycle <= windowEnd) phase = PHASE_OVULATION
    else phase = PHASE_LUTEAL
  }

  let cardTitle = '🩸 生理期'
  if (state === PERIOD_STATE_IN_PERIOD) cardTitle = '🩸 经期中'
  else if (state === PERIOD_STATE_UPCOMING) cardTitle = '🩸 即将到来'

  let cardValue: string
  if (state === PERIOD_STATE_START) cardValue = '今日来潮'
  else if (state === PERIOD_STATE_IN_PERIOD) cardValue = `第 ${cycleDay} 天`
  else if (state === PERIOD_STATE_UPCOMING) cardValue = `还有 ${daysUntilNext} 天`
  else cardValue = `${daysUntilNext} 天`

  status.state = state
  status.configured = true
  status.cycleDay = cycleDay
  status.daysUntilNext = daysUntilNext
  status.daysUntilOvulation = daysUntilOvulation
  status.ovulationDate = ovulationDate
  status.nextStartDate = nextStartDate
  status.phase = phase
  status.cardTitle = cardTitle
  status.cardValue = cardValue
  status.nextStartText = `${isoDate(nextStartDate)}（${daysUntilNext} 天后）`
  status.phaseText = `${phase}（周期第 ${cycleDay} 天）`
  status.ovulationText =
    daysUntilOvulation === 0
      ? `今天（${isoDate(ovulationDate)}）`
      : `${daysUntilOvulation} 天后（${isoDate(ovulationDate)}）`
  status.lastStartText = isoDate(lastStart)
  return status
}

// ---------------------------------------------------------------------------
// 日赚与信息卡（main.py）
// ---------------------------------------------------------------------------

const REST_WORK_DAYS: Record<string, number> = { 双休: 8, 大小周: 6, 单休: 4 }

function parseHm(text: string): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((text ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min)
}

function workDaysPerMonth(restType: string, customRestDays: number): number {
  const rest = restType === '其他' ? customRestDays : (REST_WORK_DAYS[restType] ?? 8)
  return Math.max(1, 30 - rest)
}

function effectiveSecondsPerDay(
  amStart: string, amEnd: string, pmStart: string, pmEnd: string,
): number {
  const amS = parseHm(amStart)
  const amE = parseHm(amEnd)
  const pmS = parseHm(pmStart)
  const pmE = parseHm(pmEnd)
  if (!amS || !amE || !pmS || !pmE) return 0
  const secs = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 1000
  return Math.max(0, secs(amS, amE) + secs(pmS, pmE))
}

function perSecondSalary(salary: number, restType: string, customRestDays: number,
  amStart: string, amEnd: string, pmStart: string, pmEnd: string): number {
  if (salary <= 0) return 0
  const wd = workDaysPerMonth(restType, customRestDays)
  const es = effectiveSecondsPerDay(amStart, amEnd, pmStart, pmEnd)
  return wd > 0 && es > 0 ? salary / wd / es : 0
}

/** 今日截至此刻已赚多少：按计薪参数现算，不累加、不依赖上一次调用。 */
function earnedToday(now: Date, salary: number, restType: string, customRestDays: number,
  amStart: string, amEnd: string, pmStart: string, pmEnd: string): number {
  const ps = perSecondSalary(salary, restType, customRestDays, amStart, amEnd, pmStart, pmEnd)
  if (ps <= 0) return 0
  const amS = parseHm(amStart)
  const amE = parseHm(amEnd)
  const pmS = parseHm(pmStart)
  const pmE = parseHm(pmEnd)
  if (!amS || !amE || !pmS || !pmE) return 0
  const t = now.getTime()
  const amTotal = (amE.getTime() - amS.getTime()) / 1000
  let workedSeconds: number
  if (t < amS.getTime()) workedSeconds = 0
  else if (t <= amE.getTime()) workedSeconds = (t - amS.getTime()) / 1000
  else if (t < pmS.getTime()) workedSeconds = amTotal
  else if (t <= pmE.getTime()) workedSeconds = amTotal + (t - pmS.getTime()) / 1000
  else workedSeconds = amTotal + (pmE.getTime() - pmS.getTime()) / 1000
  return ps * Math.max(0, workedSeconds)
}

/** 工作模式的日赚金额：固定金额或按计薪参数自动累计。 */
export function workDailyEarn(now: Date = new Date()): number {
  if (config.str('work_earn_mode', EARN_MODE_AUTO) === EARN_MODE_FIXED) {
    return config.num('work_fixed_earn', 0)
  }
  return earnedToday(
    now,
    config.num('salary', 0),
    config.str('rest_type', '双休'),
    config.num('custom_rest_days', 0),
    config.str('am_start', '09:00'),
    config.str('am_end', '12:00'),
    config.str('pm_start', '13:00'),
    config.str('pm_end', '18:00'),
  )
}

/** 返回距离今天下班的剩余秒数；已过下班时间时返回 null。 */
export function secondsUntilOffWork(now: Date = new Date()): number | null {
  const off = parseHm(config.str('work_off_time', '17:00'))
  if (!off) return null
  const remaining = (off.getTime() - now.getTime()) / 1000
  return remaining > 0 ? Math.floor(remaining) : null
}

/** 按每月发薪日计算剩余天数，月末不足时顺延到当月最后一天。 */
export function daysUntilPayday(today: Date = new Date()): number {
  const payday = clamp(Math.round(config.num('work_payday', 15)), 1, 31)
  const paydayOf = (year: number, month: number) => {
    const lastDay = new Date(year, month + 1, 0).getDate()
    return new Date(year, month, Math.min(payday, lastDay))
  }
  const thisMonth = paydayOf(today.getFullYear(), today.getMonth())
  if (thisMonth.getTime() >= new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
    return daysBetween(thisMonth, today)
  }
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 1)
  return daysBetween(paydayOf(next.getFullYear(), next.getMonth()), today)
}

/** 返回距离节日的天数；日期无效返回 null，已过去时返回 false。 */
export function daysUntilFestival(today: Date = new Date()): number | false | null {
  const raw = config.str('work_festival_date', '')
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim())
  if (!m) return null
  const festival = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const days = daysBetween(festival, today)
  return days >= 0 ? days : false
}

export function targetWeekday(): number {
  return clamp(Math.round(config.num('work_target_weekday', 5)), 1, 7)
}

export function daysUntilTargetWeekday(today: Date = new Date()): number {
  const iso = today.getDay() === 0 ? 7 : today.getDay()
  return (targetWeekday() - iso + 7) % 7
}

function formatDays(days: number): string {
  return days === 0 ? '今天' : `${days} 天`
}

// ---------------------------------------------------------------------------
// 信息卡汇总（main.py _collect_work_values / _collect_todo_counts）
// ---------------------------------------------------------------------------

export interface CardValue {
  title: string
  value: string
  palette?: [string, string, string]
}

export interface WorkValues {
  countdownTitle: string
  countdown: string
  payday: CardValue
  festival: CardValue
  weekday: CardValue
  earn: CardValue
  period?: CardValue
  todo: { memo: string; plan: string }
}

/** 左侧待办统计的条数：备忘录未勾选、计划未收尾。 */
export function collectTodoCounts(memos: Memo[], plans: Plan[], now: Date = new Date()): { memo: string; plan: string } {
  const finished = [STATUS_DONE, STATUS_CANCELED]
  const openPlans = plans.filter((p) => !finished.includes(statusOf(p, now))).length
  const openMemos = memos.filter((m) => !m.done).length
  return { memo: String(openMemos), plan: String(openPlans) }
}

/** 汇总工作模式信息卡与倒计时所需的展示文案。 */
export function collectWorkValues(memos: Memo[], plans: Plan[], now: Date = new Date()): WorkValues {
  const remaining = secondsUntilOffWork(now)
  let countdownTitle: string
  let countdown: string
  if (remaining === null) {
    countdownTitle = '今天已下班'
    countdown = '00:00:00'
  } else {
    countdownTitle = '下班还有'
    const hours = Math.floor(remaining / 3600)
    const minutes = Math.floor((remaining % 3600) / 60)
    const seconds = Math.floor(remaining % 60)
    countdown = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
  }

  const weekdayIndex = targetWeekday() - 1
  const festivalDays = daysUntilFestival(now)
  const values: WorkValues = {
    countdownTitle,
    countdown,
    payday: { title: '发薪', value: formatDays(daysUntilPayday(now)) },
    festival: {
      title: config.str('work_festival_name', '') || '节日',
      value:
        festivalDays === null
          ? '未设置'
          : festivalDays === false
            ? '已过'
            : formatDays(festivalDays),
    },
    weekday: {
      title: WEEKDAY_NAMES[weekdayIndex],
      value: formatDays(daysUntilTargetWeekday(now)),
    },
    earn: { title: '日赚', value: `${workDailyEarn(now).toFixed(3)} ¥` },
    todo: collectTodoCounts(memos, plans, now),
  }

  // 生理期卡片隐藏时不必再推算周期状态。
  if (config.bool('period_visible', false)) {
    const status = buildStatus({
      lastPeriodStart: config.str('last_period_start', ''),
      cycleDays: config.num('cycle_days', DEFAULT_CYCLE_DAYS),
      periodDays: config.num('period_days', DEFAULT_PERIOD_DAYS),
    }, now)
    values.period = {
      title: status.cardTitle,
      value: status.cardValue,
      palette: PERIOD_PALETTE[status.state],
    }
  }
  return values
}
