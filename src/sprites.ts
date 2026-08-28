/**
 * 雪碧图资源声明：文件、行列数与目标尺寸。
 * 所有序列的单帧都是正方形，行列数决定帧数与绘制的换算。
 */
export interface SheetSpec {
  file: string
  cols: number
  rows: number
  /** 显示尺寸（像素），与 Python 版 target_size 一致。 */
  size: number
}

export const SHEETS: Record<string, SheetSpec> = {
  // 默认模式的两套猫：双击角色在两者之间来回切换。
  // 两张图都是 7 列 4 行、单格尺寸一致，换装时窗口尺寸不会跳。
  // 猫的单帧只有 240px（其余序列 2x 超采样后 280px），保持 PNG 原样。
  cat_normal: { file: 'yuexincat_spritesheet_transparent.png', cols: 7, rows: 4, size: 140 },
  cat_rest: { file: 'yuexincat_rest_spritesheet_transparent.png', cols: 7, rows: 4, size: 140 },
  // 噜噜序列：降采样到单帧 280px（显示 140 的 2 倍超采样）+ WebP q90，
  // 由 scripts/convert-sprites.mjs 生成；原 PNG 备份在 assets-png-backup/。
  // 行列数不变（一律 7 列），canvas 绘制按 naturalWidth/cols 自适应。
  lulu_hoop: { file: 'lulu_hoop_spritesheet_transparent.webp', cols: 7, rows: 9, size: 140 },
  lulu_anger: { file: 'lulu_anger_spritesheet_transparent.webp', cols: 7, rows: 10, size: 140 },
  lulu_cry: { file: 'lulu_cry_spritesheet_transparent.webp', cols: 7, rows: 4, size: 140 },
  lulu_pleasant: { file: 'lulu_pleasant_spritesheet_transparent.webp', cols: 7, rows: 3, size: 140 },
  lulu_sad: { file: 'lulu_sad_spritesheet_transparent.webp', cols: 7, rows: 3, size: 140 },
  lulu_salute: { file: 'lulu_salute_spritesheet_transparent.webp', cols: 7, rows: 3, size: 140 },
  lulu_shake: { file: 'lulu_shake_spritesheet_transparent.webp', cols: 7, rows: 1, size: 140 },
  lulu_stiff: { file: 'lulu_stiff_sway_spritesheet_transparent.webp', cols: 7, rows: 2, size: 140 },
  lulu_sway: { file: 'lulu_sway_spritesheet_transparent.webp', cols: 7, rows: 1, size: 140 },
  lulu_tickle: { file: 'lulu_tickle_spritesheet_transparent.webp', cols: 7, rows: 4, size: 140 },
}

export function assetUrl(file: string): string {
  return `assets/${file}`
}

/**
 * 已解码的雪碧图缓存。必须保留 Image 引用：
 * 只靠 onload 预载后丢弃引用，解码缓存可能被回收，切序列时又要重新解码。
 */
const imageCache = new Map<string, HTMLImageElement>()

export function getImage(name: string): HTMLImageElement | undefined {
  return imageCache.get(name)
}

/** 加载失败也放行，不阻塞启动；对应序列播放时会被跳过。 */
const failedSheets: string[] = []

export function loadFailures(): string[] {
  return failedSheets
}

/**
 * 加载并解码单张雪碧图。
 *
 * WebView2 对大 PNG 的 decode() 会偶发失败（EncodingError），文件本身是好的：
 * 先等 onload 确认字节到手，decode 失败就隔一拍重试；重试仍失败但像素已加载
 * （complete 且 naturalWidth > 0）时照样返回——drawImage 绘制时会同步解码，
 * 序列还能播，总比整个动作永远没反应强。真正加载失败（onerror）才返回 null。
 */
async function loadSheet(spec: SheetSpec): Promise<HTMLImageElement | null> {
  const img = new Image()
  const loaded = new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true)
    img.onerror = () => resolve(false)
  })
  img.src = assetUrl(spec.file)
  if (!(await loaded)) return null

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await img.decode()
      return img
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  return img.complete && img.naturalWidth > 0 ? img : null
}

/**
 * 预载并解码全部雪碧图（img.decode() 保证像素真正就绪），
 * 供 canvas 动画器同步取用。
 *
 * 逐张顺序解码：Promise.all 并发 decode 十来张大 PNG（合计 40+MB）时
 * WebView2 偶发把部分图片判为失败，那几张序列就永远播不出来。
 */
export async function preloadAll(): Promise<void> {
  failedSheets.length = 0
  for (const [name, spec] of Object.entries(SHEETS)) {
    const img = await loadSheet(spec)
    if (img) imageCache.set(name, img)
    else failedSheets.push(name)
  }
}

/**
 * 运行期补载：预载失败的序列在播放失败时后台再试一次，
 * 下次触发同一个动作就能正常播，而不是整个会话都点不动。
 */
export async function retryLoad(name: string): Promise<boolean> {
  if (imageCache.has(name)) return true
  const spec = SHEETS[name]
  if (!spec) return false
  const img = await loadSheet(spec)
  if (!img) return false
  imageCache.set(name, img)
  const i = failedSheets.indexOf(name)
  if (i >= 0) failedSheets.splice(i, 1)
  return true
}
