/**
 * 雪碧图优化：降采样到 2x + WebP q90。
 *
 * 目标：单帧源图统一缩到 280px（显示 140px 的 2 倍超采样），再转 WebP。
 * 单帧不足 280px 的图（两套猫 240px）跳过——升采样没有收益。
 *
 * 用法：node scripts/convert-sprites.mjs
 * 产物：public/assets/<name>.webp（原 PNG 保留在原处，确认无误后可移走）。
 */
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'

const ASSETS = path.resolve('public/assets')
const COLS = 7 // 所有序列都是 7 列
const TARGET_FRAME = 280 // 显示 140px 的 2 倍

const files = fs.readdirSync(ASSETS).filter((f) => /^lulu_.*\.png$/.test(f))

const mb = (n) => (n / 1024 / 1024).toFixed(2)
const rows = []
let beforeBytes = 0
let afterBytes = 0
let beforeMem = 0
let afterMem = 0

for (const file of files) {
  const src = path.join(ASSETS, file)
  const img = sharp(src)
  const { width, height } = await img.metadata()

  const frameW = width / COLS
  if (frameW < TARGET_FRAME) {
    console.log(`跳过 ${file}（单帧 ${frameW}px 已小于目标，升采样无收益）`)
    continue
  }
  const scale = TARGET_FRAME / frameW
  const outW = Math.round(width * scale)
  const outH = Math.round(height * scale)
  const out = src.replace(/\.png$/, '.webp')

  await img
    .resize(outW, outH, { kernel: 'lanczos3' })
    .webp({ quality: 90, alphaQuality: 90 })
    .toFile(out)

  const beforeSize = fs.statSync(src).size
  const afterSize = fs.statSync(out).size
  // 解码后的位图占用只由像素尺寸决定（RGBA 每像素 4 字节），
  // 与文件格式无关——这是运行期内存的真实口径。
  const memBefore = width * height * 4
  const memAfter = outW * outH * 4
  beforeBytes += beforeSize
  afterBytes += afterSize
  beforeMem += memBefore
  afterMem += memAfter

  rows.push({
    file,
    dims: `${width}x${height} -> ${outW}x${outH}`,
    size: `${mb(beforeSize)}MB -> ${mb(afterSize)}MB`,
    mem: `${mb(memBefore)}MB -> ${mb(memAfter)}MB`,
  })
}

console.table(rows)
console.log(`文件体积合计: ${mb(beforeBytes)}MB -> ${mb(afterBytes)}MB（${(100 - (afterBytes / beforeBytes) * 100).toFixed(1)}% 缩减）`)
console.log(`解码内存合计: ${mb(beforeMem)}MB -> ${mb(afterMem)}MB（${(100 - (afterMem / beforeMem) * 100).toFixed(1)}% 缩减）`)
