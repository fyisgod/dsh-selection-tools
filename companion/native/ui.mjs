/**
 * 浮层 UI：划词菜单与回答窗口（面板）两种形态的布局、绘制与命中测试。
 *
 * 全部用 GDI+ 画（圆角卡片、字体、换行文本），颜色取 DSH 主题令牌的真实取值，
 * 深色/浅色跟随系统；不依赖任何浏览器、不额外起进程。
 *
 * 尺寸：设计尺寸是 DIP（=CSS px），绘制时统一乘显示器缩放。
 */
import { rgb } from './gdi.mjs'

/** DSH 主题令牌的真实取值（与官方 light / dark 一致）。 */
export const THEMES = {
  dark: { menu: '#353638', layer1: '#232324', labelPrimary: '#f9fafb', labelSecondary: '#cfd3d6', labelTertiary: '#adb2b8', hoverAlpha: 0x14, borderAlpha: 0x1a, accent: '#4176e6', danger: '#ec1313', success: '#22c55e' },
  light: { menu: '#ffffff', layer1: '#f5f6f7', labelPrimary: '#0f1115', labelSecondary: '#61666b', labelTertiary: '#81858c', hoverAlpha: 0x0f, borderAlpha: 0x14, accent: '#4176e6', danger: '#ec1313', success: '#22c55e' },
}

/** 设计尺寸（DIP）。回答窗口只有"面板"一种形态（悬浮球已移除）。 */
export const MODES = {
  menu: { width: 236, height: 104, radius: 20 },
  panel: { width: 400, height: 480, radius: 16 },
}

/** 取调色板（按明暗主题）。 */
export function palette(dark) {
  const t = dark ? THEMES.dark : THEMES.light
  return {
    ...t,
    menuColor: rgb(t.menu),
    layer1Color: rgb(t.layer1),
    labelPrimaryColor: rgb(t.labelPrimary),
    labelSecondaryColor: rgb(t.labelSecondary),
    labelTertiaryColor: rgb(t.labelTertiary),
    hoverColor: rgb(dark ? '#ffffff' : '#263148', t.hoverAlpha),
    borderColor: rgb(dark ? '#ffffff' : '#000000', t.borderAlpha),
    dividerColor: rgb(dark ? '#ffffff' : '#000000', dark ? 0x0f : 0x0a),
    accentColor: rgb(t.accent),
    dangerColor: rgb(t.danger),
    successColor: rgb(t.success),
    // 不可用状态（例如还没有回答时的"复制"）
    disabledColor: rgb(dark ? '#5c6066' : '#c2c6cc'),
  }
}

/** 面板布局常量（DIP）。 */
export const PANEL = { padding: 14, headerHeight: 44, buttonSize: 28, sourcePadding: 8, sourceMaxHeight: 84, footerHeight: 34, scrollbarWidth: 4 }
/** 正文区底部与状态条之间留出的空隙（DIP）。 */
const BOTTOM_INSET = 6

/**
 * 缩放手柄的宽度（DIP）：四条边一样窄，四个角都更大。
 *
 * 角必须比边宽：窗口圆角（`MODES.panel.radius` = 16 DIP）让最角落的几个像素画出来是
 * 全透明的，而分层窗口（UpdateLayeredWindow）的透明像素**不接收鼠标**——角区窄了就等于
 * 抓不住（尤其是左上/右上这种"角上就是圆角"的地方）。
 */
export const PANEL_RESIZE = { edge: 6, corner: 16 }

/**
 * 面板各区域（DIP）。
 *
 * 宽高必须传**窗口的实际尺寸**：窗口可以被用户拖着改大小，布局不能钉死在设计尺寸上
 * （踩过：拖动改大小后正文/页脚还按 400×480 排版，窗口下方留一大片空白）。
 * @param width - 实际宽度（DIP），省略时用设计尺寸。
 * @param height - 实际高度（DIP），省略时用设计尺寸。
 */
export function panelLayout(state, width = MODES.panel.width, height = MODES.panel.height) {
  const bodyTop = PANEL.headerHeight
  const bodyHeight = height - PANEL.headerHeight - PANEL.footerHeight
  const sourceHeight = state.source === '' ? 0 : Math.min(PANEL.sourceMaxHeight, 22 + Math.ceil(state.source.length / 34) * 18)
  // 上下文提示行：告诉用户这次回答是"带着上下文"跑的
  const contextLine = state.context === undefined || state.context === '' ? 0 : 18
  const answerTop = bodyTop + sourceHeight + (sourceHeight > 0 ? 10 : 0) + contextLine
  return {
    width,
    height,
    bodyTop,
    bodyHeight,
    sourceHeight,
    contextLine,
    answerTop,
    answerHeight: Math.max(20, bodyHeight - sourceHeight - (sourceHeight > 0 ? 10 : 0) - contextLine),
    contentWidth: width - PANEL.padding * 2,
  }
}

/** 标题栏按钮（DIP）：只有复制与关闭；从**实际宽度**的右边往左排。 */
export function panelButtons(state, width = MODES.panel.width) {
  // 从右往左排：关闭永远在最右（与 DSH 和其他窗口的习惯一致），往左依次是复制、朗读
  const ids = ['close', 'copy', 'speak']
  const boxes = []
  let right = width - 6
  for (const id of ids) {
    right -= PANEL.buttonSize
    boxes.push({ id, x: right, y: 8, size: PANEL.buttonSize })
    right -= 2
  }
  return boxes
}

/** 菜单行命中（DIP）→ 0/1/-1。 */
export function menuRowAt(x, y) {
  if (x < 4 || x > MODES.menu.width - 4) return -1
  if (y < 4) return -1
  if (y < 52) return 0
  if (y < 100) return 1
  return -1
}

function insideBox(x, y, box) {
  return box !== undefined && box !== null && x >= box.x && x <= box.x + box.size && y >= box.y && y <= box.y + box.size
}

/** 面板命中：按钮 id / 'stop' / 'body' / null。 */
export function panelHit(x, y, state, width = MODES.panel.width) {
  for (const button of panelButtons(state, width)) {
    if (insideBox(x, y, button)) return button.id
  }
  if (state.stopBox !== null && state.stopBox !== undefined) {
    const box = state.stopBox
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return 'stop'
  }
  return 'body'
}

/**
 * 回答窗口的缩放命中区（DIP）：**四边 + 四角，八个方向都算**。
 *
 * 坐标传窗口的**实际**宽高（用户可以把窗口拖大拖小），钉死在设计尺寸上手柄就会跑偏。
 * 落在边缘外一点点（原生缩放时坐标可能微负数）也算：比较本身就是"越界即命中"。
 *
 * @param width - 实际宽度（DIP）。
 * @param height - 实际高度（DIP）。
 * @returns `resize-<方向>`（left/right/top/bottom + 四个对角）；不在边缘上返回 null。
 */
export function panelEdgeZone(x, y, width = MODES.panel.width, height = MODES.panel.height) {
  const nearLeft = x < PANEL_RESIZE.corner
  const nearRight = x > width - PANEL_RESIZE.corner
  const nearTop = y < PANEL_RESIZE.corner
  const nearBottom = y > height - PANEL_RESIZE.corner
  // 角优先：只有角区够宽，圆角那一圈才点得到（边只有 6 DIP）
  if (nearLeft && nearTop) return 'resize-topleft'
  if (nearRight && nearTop) return 'resize-topright'
  if (nearLeft && nearBottom) return 'resize-bottomleft'
  if (nearRight && nearBottom) return 'resize-bottomright'
  if (x < PANEL_RESIZE.edge) return 'resize-left'
  if (x > width - PANEL_RESIZE.edge) return 'resize-right'
  // 上边只有最外面这 6 DIP 是缩放手柄：再往下就是标题栏，交给拖动（HTCAPTION）
  if (y < PANEL_RESIZE.edge) return 'resize-top'
  if (y > height - PANEL_RESIZE.edge) return 'resize-bottom'
  return null
}

/**
 * 回答窗口的完整命中区（DIP → 语义），原生窗口的 WM_NCHITTEST 直接吃这个结果。
 *
 * 优先级：**标题栏按钮 / 页脚「停止」 > 八向缩放手柄 > 标题栏（拖动） > 客户区**。
 * 按钮必须先判：缩放手柄就压在它们旁边（上右角贴着关闭按钮、底边贴着「停止」），
 * 反过来会把这两个按钮的边角抢走（踩过的方向：菜单项被 HTCAPTION 吃掉点不动）。
 */
export function panelHitZone(x, y, state, width = MODES.panel.width, height = MODES.panel.height) {
  if (panelHit(x, y, state, width) !== 'body') return 'client'
  const edge = panelEdgeZone(x, y, width, height)
  if (edge !== null) return edge
  return y < PANEL.headerHeight ? 'caption' : 'client'
}

// ---------------------------------------------------------------- 绘制

/** 画划词菜单。 */
export function paintMenu(painter, width, height, state, scale) {
  const p = palette(state.dark)
  const s = scale
  painter.fillRoundRect(0, 0, width, height, MODES.menu.radius * s, p.menuColor)
  painter.strokeRoundRect(0.5 * s, 0.5 * s, width - s, height - s, MODES.menu.radius * s, p.borderColor, Math.max(1, s))
  const rows = [
    { label: 'DeepSeek Harness 解释', icon: 'sparkle' },
    { label: 'DeepSeek Harness 翻译', icon: 'globe' },
  ]
  for (let i = 0; i < rows.length; i++) {
    const top = (4 + i * 48) * s
    if (state.hover === i) painter.fillRoundRect(4 * s, top, width - 8 * s, 48 * s, 12 * s, p.hoverColor)
    drawIcon(painter, rows[i].icon, 14 * s, top + 16 * s, 16 * s, p.labelTertiaryColor, s)
    painter.text(rows[i].label, 38 * s, top + 13 * s, width - 52 * s, 22 * s, { size: 14 * s, color: p.labelPrimaryColor })
  }
}

/** 画悬浮窗。 */
export function paintPanel(painter, width, height, state, scale) {
  const p = palette(state.dark)
  const s = scale
  // 窗口可以被用户拖动改大小：布局一律按**实际**宽高（DIP）算，不能钉死设计尺寸。
  const dipWidth = Math.max(200, width / s)
  const dipHeight = Math.max(160, height / s)
  painter.fillRoundRect(0, 0, width, height, MODES.panel.radius * s, p.menuColor)
  painter.strokeRoundRect(0.5 * s, 0.5 * s, width - s, height - s, MODES.panel.radius * s, p.borderColor, Math.max(1, s))

  painter.text(state.action === 'translate' ? '翻译' : '解释', PANEL.padding * s, 11 * s, 220 * s, 24 * s, { size: 14 * s, bold: true, color: p.labelPrimaryColor })
  const hasAnswer = typeof state.answer === 'string' && state.answer !== ''
  const hasSource = typeof state.source === 'string' && state.source !== ''
  for (const button of panelButtons(state, dipWidth)) {
    // 没有内容可复制 / 没有原文可读时对应按钮画成灰的，让"点了没反应"变成"看得出点不了"
    const disabled = (button.id === 'copy' && !hasAnswer) || (button.id === 'speak' && !hasSource)
    const speaking = button.id === 'speak' && state.speaking === true
    const active = (state.hoverButton === button.id || speaking) && !disabled
    const centerX = (button.x + button.size / 2) * s
    const centerY = (button.y + button.size / 2) * s
    if (active) painter.fillCircle(button.x * s, button.y * s, button.size * s, p.hoverColor)
    const color = disabled ? p.disabledColor : speaking ? p.accentColor : active ? p.labelSecondaryColor : p.labelTertiaryColor
    drawIcon(painter, button.id, centerX - 8 * s, centerY - 8 * s, 16 * s, color, s)
  }

  const layout = panelLayout(state, dipWidth, dipHeight)
  if (layout.sourceHeight > 0) {
    painter.fillRoundRect(PANEL.padding * s, (layout.bodyTop + 2) * s, layout.contentWidth * s, layout.sourceHeight * s, 10 * s, p.layer1Color)
    painter.paragraph(state.source, (PANEL.padding + PANEL.sourcePadding) * s, (layout.bodyTop + 10) * s, (layout.contentWidth - PANEL.sourcePadding * 2) * s, {
      size: 12 * s,
      lineHeight: 18 * s,
      color: p.labelSecondaryColor,
      maxHeight: (layout.sourceHeight - 16) * s,
    })
  }

  if (layout.contextLine > 0) {
    painter.text('已结合上下文', PANEL.padding * s, (layout.bodyTop + layout.sourceHeight + 12) * s, layout.contentWidth * s, 16 * s, {
      size: 11 * s,
      color: p.labelTertiaryColor,
    })
  }

  const previousHeight = state.contentHeight
  const clipTop = layout.answerTop * s
  // 底部留一点内边距：滚动内容被裁时不会紧贴状态条的分隔线
  const clipBottom = (layout.bodyTop + layout.bodyHeight - BOTTOM_INSET) * s
  state.viewHeight = layout.answerHeight - BOTTOM_INSET
  // 必须裁剪：否则正文会盖到页脚（状态条）上——踩过。
  painter.setClip(0, clipTop, width, Math.max(0, clipBottom - clipTop))
  const contentHeight = drawAnswer(painter, state, PANEL.padding * s, clipTop - state.scroll * s, layout.contentWidth * s, s, p, clipTop, clipBottom)
  painter.resetClip()
  if (previousHeight !== contentHeight / s && state.status === 'running') state.contentHeight = contentHeight / s
  state.contentHeight = contentHeight / s

  const maxScroll = Math.max(0, state.contentHeight - layout.answerHeight)
  if (state.scroll > maxScroll) state.scroll = maxScroll
  if (maxScroll > 0) {
    const visible = Math.max(24, (layout.answerHeight / state.contentHeight) * layout.answerHeight)
    const offset = (state.scroll / maxScroll) * (layout.answerHeight - visible)
    painter.fillRoundRect((dipWidth - PANEL.padding) * s, (layout.answerTop + offset) * s, PANEL.scrollbarWidth * s, visible * s, (PANEL.scrollbarWidth / 2) * s, p.borderColor)
  }

  const footerTop = dipHeight - PANEL.footerHeight
  // 先铺一层底色再分隔线：即使有溢出也不会在页脚区域看到正文残影
  painter.fillRect(0, footerTop * s, width, (dipHeight - footerTop) * s, p.menuColor)
  painter.line(0, footerTop * s, width, footerTop * s, p.dividerColor, 1)
  const statusText = state.status === 'running' ? 'Harness agent 生成中…' : state.status === 'done' ? '完成' : state.status === 'error' ? '失败' : '就绪'
  const statusColor = state.status === 'running' ? p.accentColor : state.status === 'done' ? p.successColor : state.status === 'error' ? p.dangerColor : p.labelTertiaryColor
  painter.fillCircle(PANEL.padding * s, (footerTop + 14) * s, 6 * s, statusColor)
  painter.text(statusText, (PANEL.padding + 12) * s, (footerTop + 8) * s, 150 * s, 18 * s, { size: 12 * s, color: state.status === 'error' ? p.dangerColor : p.labelTertiaryColor })
  if (state.status === 'error' && state.error !== '') {
    painter.text(state.error, (PANEL.padding + 86) * s, (footerTop + 8) * s, Math.max(40, dipWidth - PANEL.padding * 2 - 160) * s, 18 * s, { size: 12 * s, color: p.dangerColor })
  }
  // 复制结果回执：点了复制一定要看得见"已复制 / 复制失败"
  if (typeof state.copyFeedback === 'string' && state.copyFeedback !== '') {
    painter.text(state.copyFeedback, (dipWidth - PANEL.padding - 96) * s, (footerTop + 8) * s, 96 * s, 18 * s, {
      size: 12 * s,
      color: state.copyFeedback === '已复制' || state.copyFeedback === 'Copied' ? p.successColor : p.dangerColor,
    })
  }
  if (state.status === 'running') {
    const stopX = dipWidth - PANEL.padding - 26
    painter.text('停止', stopX * s, (footerTop + 8) * s, 26 * s, 18 * s, { size: 12 * s, color: p.accentColor })
    state.stopBox = { x: stopX - 6, y: footerTop + 4, width: 36, height: 26 }
  } else {
    state.stopBox = null
  }
}

/** 画答案（markdown-lite），返回内容高度（物理像素）。 */
function drawAnswer(painter, state, x, y, width, s, p, clipTop, clipBottom) {
  if (state.answer === '') {
    if (state.status === 'running') {
      painter.fillRect(x, y + 3 * s, 6 * s, 15 * s, p.labelTertiaryColor)
      return y + 22 * s - (clipTop - state.scroll * s)
    }
    painter.text('（没有文本输出）', x, y, width, 22 * s, { size: 14 * s, color: p.labelTertiaryColor })
    return 26 * s
  }
  const blocks = parseBlocks(state.answer)
  let cursor = y
  const bodySize = 14 * s
  const lineHeight = 22 * s
  for (const block of blocks) {
    const near = cursor > clipTop - 600 * s && cursor < clipBottom + 600 * s
    if (block.kind === 'heading') {
      const size = (block.level <= 1 ? 16.5 : 15.5) * s
      cursor += near
        ? painter.paragraph(block.text, x, cursor + 6 * s, width, { size, lineHeight: size * 1.5, bold: true, color: p.labelPrimaryColor })
        : measure(painter, block.text, width, size, size * 1.5, true)
      cursor += 6 * s
    } else if (block.kind === 'bullet' || block.kind === 'ordered') {
      const marker = block.kind === 'ordered' ? String(block.marker) + '.' : '•'
      painter.text(marker, x, cursor, 20 * s, lineHeight, { size: bodySize, color: p.labelSecondaryColor })
      cursor += near
        ? painter.paragraph(block.text, x + 16 * s, cursor, width - 16 * s, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
        : measure(painter, block.text, width - 16 * s, bodySize, lineHeight, false)
      cursor += 2 * s
    } else if (block.kind === 'code') {
      const codeSize = 12.5 * s
      const codeLine = 19 * s
      const boxHeight = block.lines.length * codeLine + 16 * s
      if (near) {
        painter.fillRoundRect(x, cursor + 2 * s, width, boxHeight, 10 * s, p.layer1Color)
        for (let i = 0; i < block.lines.length; i++) {
          painter.text(block.lines[i], x + 10 * s, cursor + 10 * s + i * codeLine, width - 20 * s, codeLine, { size: codeSize, mono: true, color: p.labelPrimaryColor })
        }
      }
      cursor += boxHeight + 6 * s
    } else if (block.kind === 'quote') {
      const used = near
        ? painter.paragraph(block.text, x + 12 * s, cursor, width - 12 * s, { size: bodySize, lineHeight, color: p.labelSecondaryColor })
        : measure(painter, block.text, width - 12 * s, bodySize, lineHeight, false)
      if (near) painter.fillRect(x, cursor + 2 * s, 2 * s, Math.max(4, used - 4 * s), p.borderColor)
      cursor += used + 4 * s
    } else if (block.kind === 'table') {
      const rowLine = 20 * s
      for (const row of block.rows) {
        // 走 paragraph 而不是单行 text：表格单元格里的 **粗体** / `代码` 才会被解析掉（踩过：直接 text 会把 ** 原样画出来）。
        cursor += near
          ? painter.paragraph(row, x, cursor, width, { size: 12.5 * s, lineHeight: rowLine, color: p.labelSecondaryColor })
          : measure(painter, row, width, 12.5 * s, rowLine, false)
      }
      cursor += 4 * s
    } else if (block.kind === 'hr') {
      if (near) painter.line(x, cursor + 9 * s, x + width, cursor + 9 * s, p.dividerColor, 1)
      cursor += 20 * s
    } else {
      cursor += near
        ? painter.paragraph(block.text, x, cursor, width, { size: bodySize, lineHeight, color: p.labelPrimaryColor })
        : measure(painter, block.text, width, bodySize, lineHeight, false)
      cursor += 4 * s
    }
  }
  return cursor - (clipTop - state.scroll * s)
}

function measure(painter, text, width, size, lineHeight, bold) {
  return painter.paragraph(text, 0, 0, width, { size, lineHeight, bold, dryRun: true })
}

// ---------------------------------------------------------------- Markdown-lite 解析

/** 把答案切成块（标题 / 列表 / 代码 / 引用 / 表格 / 段落）。 */
export function parseBlocks(text) {
  const TICK = String.fromCharCode(96)
  const FENCE = TICK + TICK + TICK
  const lines = String(text).split(/\r?\n/)
  const blocks = []
  let code = null
  let table = null
  const flushTable = () => {
    if (table !== null && table.length > 0) blocks.push({ kind: 'table', rows: table })
    table = null
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, '')
    if (code !== null) {
      if (line.trim().startsWith(FENCE)) {
        blocks.push({ kind: 'code', lines: code })
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (line.trim().startsWith(FENCE)) {
      flushTable()
      code = []
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue
      if (table === null) table = []
      table.push(line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()).join('   '))
      continue
    }
    flushTable()
    // 分隔线（---、***、___）画成一条细分隔线，而不是把字符原样画出来。
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      blocks.push({ kind: 'bullet', text: bullet[1] })
      continue
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      blocks.push({ kind: 'ordered', marker: ordered[1] + '.', text: ordered[2] })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote !== null) {
      blocks.push({ kind: 'quote', text: quote[1] })
      continue
    }
    if (line.trim() === '') continue
    blocks.push({ kind: 'paragraph', text: line })
  }
  if (code !== null && code.length > 0) blocks.push({ kind: 'code', lines: code })
  flushTable()
  return blocks
}

// ---------------------------------------------------------------- 图标

/** 画一个 16×16 设计栅格的小图标。 */
export function drawIcon(painter, id, x, y, size, color, s = 1) {
  const u = size / 16
  const px = (v) => x + v * u
  const py = (v) => y + v * u
  const w = Math.max(1, 1.4 * u)
  switch (id) {
    case 'sparkle': {
      // 四角星：内凹的 8 点路径填充，比"两根交叉条"更像官方图标
      const star = (cx, cy, r) => {
        const inner = r * 0.28
        const points = []
        for (let i = 0; i < 8; i++) {
          const angle = (Math.PI / 4) * i - Math.PI / 2
          const radius = i % 2 === 0 ? r : inner
          points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius])
        }
        painter.fillPolygon(points.map(([sx, sy]) => [px(sx), py(sy)]), color)
      }
      star(6.0, 9.6, 3.6)
      star(12.0, 4.6, 2.2)
      return
    }
    case 'globe': {
      painter.strokeEllipse(px(1.5), py(1.5), 13 * u, 13 * u, color, w)
      painter.line(px(1.5), py(8), px(14.5), py(8), color, w * 0.8)
      painter.line(px(8), py(2), px(8), py(14), color, w * 0.8)
      return
    }
    case 'copy': {
      painter.strokeRoundRect(px(2), py(2), 9 * u, 10 * u, 2 * u, color, w)
      painter.strokeRoundRect(px(5.5), py(5), 9 * u, 10 * u, 2 * u, color, w)
      return
    }
    case 'speak': {
      // 喇叭 + 两道声波：朗读按钮
      painter.fillPolygon(
        [
          [px(3), py(6.5)],
          [px(5.6), py(6.5)],
          [px(8.6), py(3.4)],
          [px(8.6), py(12.6)],
          [px(5.6), py(9.5)],
          [px(3), py(9.5)],
        ],
        color,
      )
      // 两道声波用短线段拼弧线（画成同心圆环会看不出是"声波"）
      const wave = (radius) => {
        const points = []
        for (let i = 0; i <= 4; i++) {
          const angle = -Math.PI / 3 + ((2 * Math.PI) / 3) * (i / 4)
          points.push([9 + Math.cos(angle) * radius * 0.55, 8 + Math.sin(angle) * radius])
        }
        for (let i = 0; i + 1 < points.length; i++) {
          painter.line(px(points[i][0]), py(points[i][1]), px(points[i + 1][0]), py(points[i + 1][1]), color, w * 0.8)
        }
      }
      wave(3.1)
      wave(5.2)
      return
    }
    case 'min': {
      painter.line(px(4), py(8.5), px(12), py(8.5), color, w)
      return
    }
    case 'close': {
      painter.line(px(4.4), py(4.4), px(11.6), py(11.6), color, w)
      painter.line(px(11.6), py(4.4), px(4.4), py(11.6), color, w)
      return
    }
    default:
      return
  }
}
