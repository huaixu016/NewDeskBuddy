/**
 * 雪碧图动画器：canvas 逐帧绘制。
 *
 * 不用 CSS background-image 切换：两张雪碧图互换时合成器可能出现
 * 一帧空白（透明闪屏）。canvas 的 drawImage 在同一 JS 回合内同步出帧，
 * 已解码的图片不存在空窗。
 */
import { SHEETS, getImage, type SheetSpec } from './sprites'

export class SpriteAnimator {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private spec: SheetSpec | null = null
  private frame = 0
  private timer: number | null = null
  private playbackId = 0
  private endTimer: number | null = null
  private loop = true

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.ctx.imageSmoothingEnabled = true
    this.ctx.imageSmoothingQuality = 'high'
  }

  /** 当前序列的显示尺寸；未加载时为 0。 */
  get size(): number {
    return this.spec?.size ?? 0
  }

  play(name: string, fps = 12, loop = true): boolean {
    const spec = SHEETS[name]
    const img = getImage(name)
    if (!spec || !img) return false
    this.stop()
    this.spec = spec
    this.loop = loop
    this.frame = 0
    ++this.playbackId

    // 画布物理分辨率 = 显示尺寸 × dpr，高分屏上保持清晰。
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.round(spec.size * dpr)
    this.canvas.height = Math.round(spec.size * dpr)
    this.canvas.style.width = `${spec.size}px`
    this.canvas.style.height = `${spec.size}px`

    this.draw(img)
    const interval = Math.max(1, Math.floor(1000 / fps))
    this.timer = window.setInterval(() => this.tick(img), interval)
    return true
  }

  /**
   * 一次性播放并在结束后回调（不循环的反应动画用）。
   * 返回 false 表示序列不可用（未声明或图片没加载成功），此时不会有结束回调。
   */
  playOnce(name: string, fps: number, onEnded: () => void): boolean {
    if (!this.play(name, fps, false)) return false
    const playbackId = this.playbackId
    const spec = SHEETS[name]
    if (!spec) return false
    const total = spec.cols * spec.rows
    const duration = (total / fps) * 1000 + 100
    this.endTimer = window.setTimeout(() => {
      this.endTimer = null
      // 只有仍是这次播放实例时才回调；同一序列重复播放也会生成新 id。
      if (this.playbackId === playbackId && this.spec === spec) onEnded()
    }, duration)
    return true
  }

  /** 停止逐帧定时器，并作废尚未触发的 playOnce 结束回调。 */
  stop(): void {
    this.stopFrames()
    if (this.endTimer !== null) {
      window.clearTimeout(this.endTimer)
      this.endTimer = null
    }
  }

  /** 只停逐帧绘制：不循环的序列播到最后一帧要停在那儿等结束回调。 */
  private stopFrames(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(img: HTMLImageElement): void {
    if (!this.spec) return
    this.frame += 1
    const total = this.spec.cols * this.spec.rows
    if (this.frame >= total) {
      if (this.loop) {
        this.frame = 0
      } else {
        // 用 stopFrames 而非 stop：结束回调（回到待机）还没到点，不能被清掉。
        this.stopFrames()
        return
      }
    }
    this.draw(img)
  }

  /** 把当前帧号换算成源矩形，整帧绘制到画布。 */
  private draw(img: HTMLImageElement): void {
    if (!this.spec) return
    const { cols, rows } = this.spec
    const total = cols * rows
    const frame = ((this.frame % total) + total) % total
    const col = frame % cols
    const row = Math.floor(frame / cols)
    const sw = img.naturalWidth / cols
    const sh = img.naturalHeight / rows
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.ctx.drawImage(
      img,
      col * sw,
      row * sh,
      sw,
      sh,
      0,
      0,
      this.canvas.width,
      this.canvas.height,
    )
  }
}
