/**
 * 配置管理：类型安全的前端包装，后端负责 config.txt 的读写与容错。
 * 这里只做取值时的类型转换与默认值兜底。
 */
import { invoke } from '@tauri-apps/api/core'

export type Mode = 'default' | 'lulu' | 'work'
export type EarnMode = 'auto' | 'fixed'

/** 前端会用到的配置键与默认值（与 Rust 端 default_config 保持一致）。 */
export const DEFAULTS: Record<string, string> = {
  current_mode: '',
  cat_resting: 'false',
  lulu_top_drop: 'true',
  key_count_visible: 'true',
  // 工作模式：计薪参数（日赚自动累计）与面板参数。
  salary: '0',
  rest_type: '双休',
  custom_rest_days: '0',
  am_start: '09:00',
  am_end: '12:00',
  pm_start: '13:00',
  pm_end: '18:00',
  work_off_time: '17:00',
  work_payday: '15',
  work_festival_name: '',
  work_festival_date: '',
  work_target_weekday: '5',
  work_earn_mode: 'auto',
  work_fixed_earn: '0',
  // 工作配置是否保存过：保存过一次后切工作模式不再弹配置窗。
  work_config_initialized: 'false',
  work_scale: '0.65',
  work_opacity: '1',
  // 生理期参数：起始日为空表示尚未配置，卡片显示「待设置」。
  last_period_start: '',
  cycle_days: '28',
  period_days: '5',
  period_visible: 'false',
}

/** 完整配置的内存副本，load() 之后全程有效。 */
let values: Record<string, string> = { ...DEFAULTS }

export async function load(): Promise<void> {
  values = await invoke<Record<string, string>>('load_config')
}

/** 增量保存：改动过的键合并进后端并落盘。 */
export async function save(changes: Record<string, string>): Promise<void> {
  Object.assign(values, changes)
  await invoke('save_config', { changes })
}

export function raw(key: string): string {
  return values[key] ?? DEFAULTS[key] ?? ''
}

export function str(key: string, fallback = ''): string {
  const v = raw(key)
  return v === '' || v === undefined ? fallback : v
}

export function bool(key: string, fallback = false): boolean {
  const v = raw(key)
  if (v === '' || v === undefined) return fallback
  return v.toLowerCase() === 'true'
}

export function num(key: string, fallback = 0): number {
  const v = parseFloat(raw(key))
  return Number.isFinite(v) ? v : fallback
}

/** 当前生效的模式：认不出的 current_mode 一律回落默认模式。 */
export function resolvedMode(): Mode {
  const mode = str('current_mode') || 'default'
  if (mode === 'lulu' || mode === 'work') return mode
  return 'default'
}

/** 切换模式：默认模式存空字符串，与 Python 版的落盘格式一致。 */
export async function switchMode(mode: Mode): Promise<void> {
  await save({ current_mode: mode === 'default' ? '' : mode })
}
