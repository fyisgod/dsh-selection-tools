/**
 * 页内路径验收：用 headless Chrome 在跑着的 dsh web 上真鼠标划词，断言菜单/悬浮窗行为并顺手出图到 docs/。
 *
 * 依赖 puppeteer-core（不绑定浏览器，用本机 Chrome）。可用环境变量覆盖：
 *   DSH_WEB_URL    被验收的 dsh web 地址（默认 http://127.0.0.1:3080）
 *   DSH_CHROME     本机 Chrome 可执行文件路径（默认常见安装路径）
 *   PUPPETEER_CORE puppeteer-core 的解析路径或包名（默认按 Node 解析规则找，
 *                  再退回 DSH_HOME/profiles/web/node_modules 下的副本）
 *   DSH_SHOT_DIR   出图目录（默认本仓库的 docs/）
 *
 * 用法：node scripts/verify-ui.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function loadPuppeteer() {
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const candidates = [
    process.env.PUPPETEER_CORE,
    'puppeteer-core',
    path.join(dshHome, 'profiles', 'web', 'node_modules', 'puppeteer-core'),
  ].filter(Boolean)
  const failures = []
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      failures.push(candidate + ': ' + error.message)
    }
  }
  throw new Error('puppeteer-core 不可用（设 PUPPETEER_CORE 指向它）\n' + failures.join('\n'))
}

function chromePath() {
  const candidates = [
    process.env.DSH_CHROME,
    process.env['PROGRAMFILES'] ? path.join(process.env['PROGRAMFILES'], 'Google/Chrome/Application/chrome.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error('找不到 Chrome（设 DSH_CHROME 指向 chrome.exe）')
}

const puppeteer = loadPuppeteer()
const OUT = process.env.DSH_SHOT_DIR ?? path.join(__dirname, '..', 'docs')
const WEB_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
fs.mkdirSync(OUT, { recursive: true })

async function main() {
  const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ['--no-sandbox', '--window-size=1440,900'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  const errors = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()) })
  await page.goto(WEB_URL + '/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.dst-root', { timeout: 60000 })
  await sleep(1500)
  const out = { errors }

  // ---- 1. 真鼠标拖选 hero 标题 ----
  const headline = await page.evaluate(() => {
    const el = document.querySelector('[class*="headlineText"]') || document.querySelector('h1, h2')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2), right: Math.round(r.right - 2) }
  })
  if (headline === null) throw new Error('no headline found')
  await page.mouse.move(headline.x, headline.y)
  await page.mouse.down()
  await page.mouse.move(headline.right, headline.y, { steps: 12 })
  await page.mouse.up()
  await sleep(400)
  out.selected = await page.evaluate(() => window.getSelection()?.toString() || '')
  out.menu = await page.evaluate(() => {
    const el = document.querySelector('.dst-menu')
    if (el === null) return null
    const r = el.getBoundingClientRect()
    const sel = window.getSelection()
    const rect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
    return {
      at: { x: Math.round(r.x), y: Math.round(r.y) },
      anchor: rect ? { right: Math.round(rect.right), bottom: Math.round(rect.bottom) } : null,
      items: [...el.querySelectorAll('.dst-menu-item')].map((i) => i.textContent),
      icons: [...el.querySelectorAll('.dst-menu-item svg')].map((s) => s.getAttribute('viewBox')),
    }
  })
  await page.screenshot({ path: path.join(OUT, 'menu-in-conversation.png') })

  // ---- 2. 打开悬浮窗 ----
  await page.click('.dst-menu-item')
  await page.waitForSelector('.dst-panel', { timeout: 15000 })
  out.panel = await page.evaluate(() => {
    const r = document.querySelector('.dst-panel').getBoundingClientRect()
    const s = getComputedStyle(document.querySelector('.dst-panel'))
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), radius: s.borderRadius, shadow: s.boxShadow.slice(0, 60), background: s.backgroundColor }
  })
  for (let i = 0; i < 90; i++) { await sleep(1000); const f = await page.evaluate(() => document.querySelector('.dst-panel-foot')?.textContent || ''); if (f !== '' && !f.includes('生成中')) break }
  out.answer = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.dst-answer h1, .dst-answer h2, .dst-answer p, .dst-answer li, .dst-answer strong').length,
    officialMarkdown: document.querySelector('.dst-answer > div')?.className || '',
    text: (document.querySelector('.dst-answer')?.textContent || '').slice(0, 80),
    status: document.querySelector('.dst-panel-foot')?.textContent || '',
  }))
  await page.screenshot({ path: path.join(OUT, 'panel-in-conversation.png') })

  // ---- 3. 拖动 ----
  const hb = await (await page.$('.dst-panel-header')).boundingBox()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down(); await page.mouse.move(hb.x + hb.width / 2 - 300, hb.y + hb.height / 2 - 200, { steps: 12 }); await page.mouse.up()
  await sleep(200)
  out.afterDrag = await page.evaluate(() => { const r = document.querySelector('.dst-panel').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) } })

  // ---- 4. 缩放 ----
  const gb = await (await page.$('.dst-resize-se')).boundingBox()
  await page.mouse.move(gb.x + 3, gb.y + 3); await page.mouse.down(); await page.mouse.move(gb.x + 3 + 160, gb.y + 3 + 100, { steps: 12 }); await page.mouse.up()
  await sleep(200)
  out.afterResize = await page.evaluate(() => { const r = document.querySelector('.dst-panel').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })

  // ---- 5. 悬浮球与最小化都已移除 ----
  out.ballGone = (await page.$('.dst-ball')) === null
  out.minimizeGone = (await page.$('[aria-label="收起为悬浮球"]')) === null
  out.headerButtons = await page.evaluate(() => [...document.querySelectorAll('.dst-panel-actions .dst-icon-btn')].map((b) => b.getAttribute('aria-label')))

  // ---- 6. 几何持久化（刷新页面后仍在拖动后的位置） ----
  const stored = await page.evaluate(() => localStorage.getItem('dsh.selection-tools.layout'))
  out.storedLayout = stored

  // ---- 7. 关闭 ----
  await page.click('[aria-label="关闭"]')
  await sleep(300)
  out.closed = (await page.$('.dst-panel')) === null

  console.log(JSON.stringify(out, null, 2))
  await browser.close()
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
