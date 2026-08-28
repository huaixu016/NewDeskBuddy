/**
 * 右键菜单入口：请求 Rust 打开独立菜单悬浮窗（现代样式，不受宠物
 * 窗口尺寸裁剪）。选中项经 `menu-action` 事件回传，分发在 app.ts。
 */
import { invoke } from '@tauri-apps/api/core'
import * as config from './config'

export async function showPetMenu(x: number, y: number): Promise<void> {
  await invoke('open_menu_window', {
    x,
    y,
    mode: config.resolvedMode(),
    keyCountVisible: config.bool('key_count_visible', true),
  })
}
