import { startApp } from './app'
import { win } from './window'

startApp().catch(async (err) => {
  console.error('启动失败:', err)
  // 把错误顶到窗口里：透明无边框窗口没有别的可见反馈渠道。
  // 窗口初始是隐藏的（等角色就绪一起亮相），失败路径必须自己把窗口
  // 拉出来，否则错误写在了一个永远看不见的窗口里。
  const el = document.getElementById('key-count')
  if (el) el.textContent = `启动失败: ${String(err)}`
  try {
    await win.show()
  } catch {
    /* show 失败时至少控制台有日志 */
  }
})
