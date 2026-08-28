/**
 * 配置管理：类型安全的前端包装，后端负责 config.txt 的读写与容错。
 * 这里只做取值时的类型转换与默认值兜底。
 */
import { invoke } from '@tauri-apps/api/core'

export type Mode = 'default' | 'lulu'
export type EarnMode = 'auto' | 'fixed'

/** 前端会用到的配置键与默认值（与 Rust 端 default_config 保持一致）。 */
export const DEFAULTS: Record<string, string> = {
  current_mode: '',
  cat_resting: 'false',
  lulu_top_drop: 'true',
  key_count_visible: 'true',
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
  return mode === 'lulu' ? 'lulu' : 'default'
}

/** 切换模式：默认模式存空字符串，与 Python 版的落盘格式一致。 */
export async function switchMode(mode: Mode): Promise<void> {
  await save({ current_mode: mode === 'default' ? '' : mode })
}
