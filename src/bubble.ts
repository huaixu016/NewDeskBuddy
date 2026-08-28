/**
 * 气泡提示：上浮 + 淡出，2.2 秒后自动销毁。
 * 对应 Python 版 BubbleLabel。
 */

const BUBBLE_CLICK = ['嘿嘿~', '开心!', '❤️', '✨']
const BUBBLE_DBLCLICK = ['好痒!', '别戳了!', '哈哈哈', '抖抖~']
const BUBBLE_DROP = ['安全着陆!', '噗~', '屁屁疼~', '😵']

/** 左右交替的初始偏移方向，与原版一致。 */
let lastOffsetDir = 1

export function bubbleText(kind: 'click' | 'dblclick' | 'drop'): string {
  const pool = kind === 'click' ? BUBBLE_CLICK : kind === 'dblclick' ? BUBBLE_DBLCLICK : BUBBLE_DROP
  return pool[Math.floor(Math.random() * pool.length)]
}

export function showBubble(container: HTMLElement, text: string, x: number, y: number): void {
  const el = document.createElement('div')
  el.className = 'bubble'
  el.textContent = text
  container.appendChild(el)

  const offsetX = (10 + Math.floor(Math.random() * 11)) * lastOffsetDir
  lastOffsetDir *= -1
  const startX = x + offsetX
  const startY = y
  // transform 由 CSS 动画接管，起点位置用 left/top 一次放好。
  el.style.left = `${startX}px`
  el.style.top = `${startY}px`
  // 漂移方向跟初始偏移相反（与原版 _last_offset_dir 已翻转后的值同号）。
  const driftX = (25 + Math.floor(Math.random() * 16)) * lastOffsetDir
  const rise = 100 + Math.floor(Math.random() * 21)

  el.style.setProperty('--drift-x', `${driftX}px`)
  el.style.setProperty('--rise', `-${rise}px`)
  // 强制 reflow 让起点先生效，再触发动画。
  void el.offsetWidth
  el.classList.add('bubble-run')
  el.addEventListener('animationend', () => el.remove())
}
