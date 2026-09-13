/**
 * dsh-selection-tools 系统级伴生进程（Node + koffi + GDI+）。
 *
 * 1. **全局划词**：轮询鼠标左右中键与光标位置，识别"拖选/双击选词"，注入一次 Ctrl+C 读剪贴板取词。
 * 2. **两个原生浮层窗口**（都在本进程内，GDI+ 自绘，不依赖浏览器、不额外起进程）：
 *    - 划词菜单：出现在选区右下角，**有显示时限**（默认 3.6s）、任意键点到别处即消失；
 *    - 回答窗口（面板）：**只有手动关闭才会消失**，新划词不会动它；没有悬浮球、没有最小化。
 * 3. **上下文**：菜单弹出后用 UI Automation 读"选区所在的段落"（worker 线程 + 超时），
 *    点菜单项时连同选区一起交给 agent——像知乎划词解释那样带语境，读不到就安静降级。
 * 4. **跑 agent**：直接调用 DSH 插件的 /run 路由（SSE），把流式文本画到回答窗口上。
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createContextReader } from './context.mjs'
import { createGestureDetector } from './gesture.mjs'
import { captureSelection, clampSelection } from './selection.mjs'
import { createGdi } from './native/gdi.mjs'
import { captureScreenRect } from './native/capture.mjs'
import { createNativeWindow, hitTestCode } from './native/window.mjs'
import { createSpeaker } from './native/speech.mjs'
import { MODES, menuRowAt, paintMenu, paintPanel, panelHit, panelHitZone } from './native/ui.mjs'
import { createWin32, monitorScaleForPoint, primaryWorkArea, workAreaForPoint } from './win32.mjs'

const DSH_ORIGIN = process.env.DSH_SELECTION_DSH_ORIGIN ?? 'http://127.0.0.1:3080'
const KOFFI_HINT = process.env.DSH_SELECTION_KOFFI_HINT ?? ''
const POLL_MS = Number(process.env.DSH_SELECTION_POLL_MS ?? 40)
const HOOK_ENABLED = process.env.DSH_SELECTION_HOOK !== '0'
const MAX_TEXT = Number(process.env.DSH_SELECTION_MAX_TEXT ?? 12000)
const LOCALE = process.env.DSH_SELECTION_LOCALE === 'en' ? 'en' : 'zh'
/** 划词菜单的显示时限（毫秒）。 */
const MENU_TIMEOUT_MS = Number(process.env.DSH_SELECTION_MENU_TIMEOUT_MS ?? 3600)
/** 单次上下文读取的时间预算（毫秒）：超时就丢掉 worker，按"没有上下文"处理。 */
const CONTEXT_TIMEOUT_MS = Number(process.env.DSH_SELECTION_CONTEXT_TIMEOUT_MS ?? 1800)
/** 上下文开关（`DSH_SELECTION_CONTEXT=0` 可关掉）。 */
const CONTEXT_ENABLED = process.env.DSH_SELECTION_CONTEXT !== '0'
const GAP = 8
const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02
const VK_MBUTTON = 0x04
const VK_ESCAPE = 0x1b

const api = createWin32([KOFFI_HINT])
const gdi = api === null ? null : createGdi(api.koffi)

/** 回答窗口的业务状态（也是绘制输入）。 */
const ui = {
  mode: 'panel',
  dark: true,
  hover: -1,
  hoverButton: null,
  action: 'explain',
  source: '',
  context: '',
  answer: '',
  status: 'idle',
  error: '',
  copyFeedback: '',
  speaking: false,
  scroll: 0,
  contentHeight: 0,
  viewHeight: 0,
  stopBox: null,
}

/** 划词菜单状态。 */
const menu = { visible: false, rect: null, scale: 1, anchor: null, hover: -1, timer: null, dark: true }
/** 回答窗口状态（`size` 是用户手动改过的大小，物理像素）。 */
const panel = { mode: 'hidden', rect: null, scale: 1, position: null, size: null }

const state = {
  selection: null,
  lastGesture: null,
  lastCapture: null,
  lastMenuDismiss: null,
  lastContext: null,
  contextPending: null,
  run: null,
  startedAt: Date.now(),
  errors: [],
}

/** 上下文读取器（worker 线程；钩子关掉或显式禁用时不建）。 */
const contextReader = api !== null && gdi !== null && CONTEXT_ENABLED
  ? createContextReader({ koffiHint: KOFFI_HINT, timeoutMs: CONTEXT_TIMEOUT_MS })
  : null

function reportError(scope, error) {
  const message = error instanceof Error ? error.message : String(error)
  state.errors.push({ scope, message, time: Date.now() })
  if (state.errors.length > 20) state.errors.shift()
}

let themeCache = { value: true, at: 0 }
function systemDark() {
  if (Date.now() - themeCache.at < 60_000) return themeCache.value
  let dark = true
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8', windowsHide: true })
    const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout ?? '')
    if (match !== null) dark = Number.parseInt(match[1], 16) === 0
  } catch {
    /* 读不到就按深色 */
  }
  themeCache = { value: dark, at: Date.now() }
  return dark
}

// ---------------------------------------------------------------- 回答窗口（面板 / 悬浮球）

const mainWindow = api !== null && gdi !== null && gdi.startup()
  ? createNativeWindow({
      api,
      gdi,
      className: 'DshSelMainWnd',
      title: 'DSH 划词助手',
      // 缩放下限（DIP）：再小布局就没法看了
      minSize: { width: 260, height: 200 },
      initialState: ui,
      onPaint(painter, width, height, data, scale) {
        paintPanel(painter, width, height, data, scale)
      },
      onHitTest(x, y, data) {
        return hitZone(x, y, data)
      },
      onHover(x, y, data) {
        const scale = mainWindow.scale()
        if (x < 0) {
          const changed = data.hover !== -1 || data.hoverButton !== null
          data.hover = -1
          data.hoverButton = null
          return changed
        }
        const button = y / scale < 44 ? panelHit(x / scale, y / scale, data, currentPanelSize().width) : null
        const next = button === 'body' ? null : button
        if (next !== data.hoverButton) {
          data.hoverButton = next
          return true
        }
        return false
      },
      onMouseDown() {
        // 拖动交给标题栏（HTCAPTION），客户区一律按点击处理
        return 'click'
      },
      onDragEnd(x, y) {
        panel.position = { x, y }
      },
      onResized(width, height) {
        // 创建期（窗口是 10×10 的占位尺寸）与隐藏期都会收到 WM_SIZE，不能当作用户改过大小
        // ——踩过：把创建期的 10×10 记成"用户尺寸"，回答窗口直接以 10×10 打开。
        if (panel.mode === 'hidden') return
        const scale = mainWindow.scale()
        if (width < 200 * scale || height < 150 * scale) return
        // 用户手动改过大小：记住它（下次打开仍用这个尺寸），并同步对外汇报的矩形
        // —— 否则命中判断与 /capture 会按旧尺寸错位。
        panel.size = { width, height }
        if (panel.rect !== null) panel.rect = { ...panel.rect, width, height }
      },
      onMoved(x, y) {
        // 原生拖动（标题栏）之后同步位置，避免下一次重绘把窗口拉回去。
        // 窗口隐藏时不记：创建期与隐藏期都会收到 WM_MOVE（例如 -32000 的初始位置）。
        if (panel.mode === 'hidden') return
        panel.position = { x, y }
        // 同时修正对外汇报的矩形：否则 /capture 之类会按旧坐标抓错区域
        if (panel.rect !== null) panel.rect = { ...panel.rect, x, y }
      },
      onClick(x, y, data) {
        try {
          return clickMain(x / mainWindow.scale(), y / mainWindow.scale(), data)
        } catch (error) {
          reportError('click', error)
          return false
        }
      },
      onRightClick() {
        // 只有标题栏的关闭按钮会关掉窗口（悬浮球已移除，右键不再有特殊含义）
        return false
      },
      onWheel(delta, data) {
        if (data.mode !== 'panel') return false
        const maxScroll = Math.max(0, data.contentHeight - data.viewHeight)
        const next = Math.min(maxScroll, Math.max(0, data.scroll - Math.sign(delta) * 60))
        if (next === data.scroll) return false
        data.scroll = next
        return true
      },
      onDpiChanged() {
        if (panel.mode !== 'hidden') applyMainMode(panel.mode)
      },
      onError(error) {
        reportError('main-window', error)
      },
    })
  : null

/**
 * 回答窗口的实际尺寸（DIP）+ 缩放。
 *
 * 尺寸一律取**窗口当前的实际尺寸**：用户可以把窗口拖大拖小，命中区要是还按
 * 设计尺寸算，四边四角的缩放手柄都会跑偏（踩过：改完大小后右下角手柄偏出窗口）。
 */
function currentPanelSize() {
  const scale = mainWindow === null ? 1 : mainWindow.scale()
  const size = mainWindow === null ? { width: MODES.panel.width * scale, height: MODES.panel.height * scale } : mainWindow.size()
  return { scale, width: Math.max(1, size.width) / scale, height: Math.max(1, size.height) / scale }
}

/**
 * 回答窗口的命中区（物理 → 语义）。
 *
 * 区在 ui.mjs 的 panelHitZone 里（纯函数、可单测）：**四边 + 四角，八个方向都能
 * 用鼠标拖着改大小**。优先级是 标题栏按钮 / 页脚「停止」 > 缩放手柄 > 标题栏拖动 >
 * 客户区——上边最外面 6 DIP 是缩放手柄，再往下才轮到 HTCAPTION 拖动，两者不打架。
 */
function hitZone(x, y, data) {
  const { scale, width, height } = currentPanelSize()
  return panelHitZone(x / scale, y / scale, data, width, height)
}

/** 回答窗口标题栏上的点击（复制 / 关闭 / 停止）。 */
function clickMain(cssX, cssY, data) {
  const hit = panelHit(cssX, cssY, data, currentPanelSize().width)
  if (hit === 'copy') {
    void copyAnswer()
    return true
  }
  if (hit === 'speak') {
    toggleSpeak()
    return true
  }
  if (hit === 'close') {
    hideMain()
    return true
  }
  if (hit === 'stop') {
    void stopRun()
    return true
  }
  return true
}

/** 页脚回执的定时器。 */
let copyFeedbackTimer = null
/** 朗读器（第一次点朗读才建 COM 对象）。 */
let speaker = null
/** 朗读状态轮询定时器。 */
let speakingTimer = null

/** 懒建朗读器。 */
function ensureSpeaker() {
  if (speaker !== null) return speaker
  try {
    speaker = createSpeaker(api.koffi)
  } catch (error) {
    reportError('speech', error)
    speaker = null
  }
  return speaker
}

/** 刷新朗读状态（读完自动把按钮复原）。 */
function watchSpeaking() {
  if (speakingTimer !== null) return
  speakingTimer = setInterval(() => {
    if (speaker === null) return
    const speaking = speaker.isSpeaking()
    if (speaking === ui.speaking) return
    ui.speaking = speaking
    if (!speaking && speakingTimer !== null) {
      clearInterval(speakingTimer)
      speakingTimer = null
    }
    refreshMain()
  }, 400)
  speakingTimer.unref?.()
}

/** 朗读选中的原文（再点一次 = 停下）。 */
function toggleSpeak() {
  const instance = ensureSpeaker()
  if (instance === null || !instance.available()) {
    setCopyFeedback('朗读不可用')
    return
  }
  if (ui.speaking) {
    instance.stop()
    ui.speaking = false
    refreshMain()
    return
  }
  const text = ui.source
  if (text === '') return
  const started = instance.speak(text)
  ui.speaking = started
  refreshMain()
  if (started) watchSpeaking()
}

/** 停止朗读（换内容 / 关窗口时用）。 */
function stopSpeaking() {
  if (speaker === null) return
  speaker.stop()
  ui.speaking = false
  if (speakingTimer !== null) {
    clearInterval(speakingTimer)
    speakingTimer = null
  }
}

/** 回答窗口是否可用。 */
function mainReady() {
  return mainWindow !== null && mainWindow.isAlive()
}

/** 把回答状态推给窗口并重绘。 */
function refreshMain() {
  if (!mainReady()) return
  mainWindow.setState({
    mode: ui.mode,
    dark: ui.dark,
    hover: ui.hover,
    hoverButton: ui.hoverButton,
    action: ui.action,
    source: ui.source,
    answer: ui.answer,
    context: ui.context,
    speaking: ui.speaking,
    status: ui.status,
    error: ui.error,
    copyFeedback: ui.copyFeedback,
    scroll: ui.scroll,
    contentHeight: ui.contentHeight,
    viewHeight: ui.viewHeight,
    stopBox: ui.stopBox,
  })
}

/**
 * 显示回答窗口并定位（只有"面板"一种形态：悬浮球与最小化都已移除）。
 * 原生分层窗口没有边框，尺寸即内容尺寸。
 */
function applyMainMode(mode) {
  if (!mainReady()) return null
  if (mode === 'hidden') {
    hideMain()
    return null
  }
  ui.dark = systemDark()
  const css = MODES[mode]
  const anchor = state.selection !== null ? { x: state.selection.x, y: state.selection.y } : null
  const work = anchor !== null ? workAreaForPoint(api, anchor.x, anchor.y) : primaryWorkArea(api)
  const scale = anchor !== null
    ? monitorScaleForPoint(api, anchor.x, anchor.y)
    : monitorScaleForPoint(api, (work.left + work.right) / 2, (work.top + work.bottom) / 2)
  // 用户手动改过大小就沿用他的尺寸（否则用设计尺寸），再夹回工作区。
  const preferred = panel.size ?? { width: css.width * scale, height: css.height * scale }
  const width = Math.min(Math.round(preferred.width), Math.max(240, work.right - work.left))
  const height = Math.min(Math.round(preferred.height), Math.max(180, work.bottom - work.top))
  const base = panel.position ?? { x: work.right - width - 20, y: work.bottom - height - 20 }
  const x = Math.min(Math.max(base.x, work.left), Math.max(work.left, work.right - width))
  const y = Math.min(Math.max(base.y, work.top), Math.max(work.top, work.bottom - height))

  ui.mode = mode
  panel.mode = mode
  panel.scale = scale
  panel.rect = { x, y, width, height }
  panel.position = { x, y }
  if (mode === 'panel') ui.scroll = 0
  refreshMain()
  mainWindow.show(x, y, width, height)
  return { x, y, width, height, scale, mode }
}

/** 关闭回答窗口（只有手动关闭会走到这里）。 */
function hideMain() {
  stopSpeaking()
  if (!mainReady()) return
  mainWindow.hide()
  panel.mode = 'hidden'
  ui.mode = 'hidden'
}

// ---------------------------------------------------------------- 划词菜单窗口

const menuUi = { dark: true, hover: -1 }

const menuWindow = api !== null && gdi !== null
  ? createNativeWindow({
      api,
      gdi,
      className: 'DshSelMenuWnd',
      title: 'DSH 划词助手菜单',
      initialState: menuUi,
      onPaint(painter, width, height, data, scale) {
        paintMenu(painter, width, height, data, scale)
      },
      onHitTest() {
        // 菜单整块都要能点：返回 client（返回 caption 收不到 WM_LBUTTONDOWN）
        return 'client'
      },
      onHover(x, y, data) {
        const scale = menuWindow.scale()
        if (x < 0) {
          const changed = data.hover !== -1
          data.hover = -1
          return changed
        }
        const row = menuRowAt(x / scale, y / scale)
        if (row !== data.hover) {
          data.hover = row
          return true
        }
        return false
      },
      onClick(x, y, data) {
        const scale = menuWindow.scale()
        const row = menuRowAt(x / scale, y / scale)
        void data
        if (row >= 0) {
          hideMenu('item-click')
          startRun(row === 0 ? 'explain' : 'translate')
        }
        return true
      },
      onError(error) {
        reportError('menu-window', error)
      },
    })
  : null

// 两个窗口都在这里创建（不可见），之后按需 show / hide
if (mainWindow !== null) {
  mainWindow.create()
  mainWindow.hide()
}
if (menuWindow !== null) {
  menuWindow.create()
  menuWindow.hide()
}

function menuReady() {
  return menuWindow !== null && menuWindow.isAlive()
}

/**
 * 启动上下文读取（菜单弹出之后调用，不阻塞菜单）。
 *
 * 读到的上下文写回 `state.selection.context`：点菜单项时 startRun 直接用；
 * 读不到（应用不支持 UIA 文本、选区串台、超时）就保持空串，安静降级。
 */
function startContextRead(selection) {
  state.contextPending = null
  state.lastContext = { state: 'disabled', at: Date.now() }
  if (contextReader === null) return
  selection.contextState = 'reading'
  state.lastContext = { state: 'reading', at: Date.now() }
  const pending = contextReader.read({ x: selection.x, y: selection.y }, selection.text)
  state.contextPending = pending
  void pending
    .then((result) => {
      if (state.selection !== selection) return
      if (result === null || typeof result.text !== 'string' || result.text.trim() === '') {
        selection.contextState = 'none'
        state.lastContext = { state: 'none', at: Date.now(), stats: contextReader.stats() }
        return
      }
      selection.context = result.text
      selection.contextUnit = result.unit
      selection.contextState = 'ready'
      state.lastContext = {
        state: 'ready',
        unit: result.unit,
        length: result.text.length,
        className: result.className,
        at: Date.now(),
        stats: contextReader.stats(),
      }
    })
    .catch((error) => {
      if (state.selection === selection) selection.contextState = 'error'
      reportError('context', error)
    })
}

/** 显示划词菜单（带时限）。 */
function showMenu(text, x, y) {
  if (!menuReady()) return null
  // 只记"这次选了什么"：回答窗口的内容归它自己，绝不在弹菜单时被改写
  // （踩过：这里顺手把 ui.source/answer/status 重置了，于是新划词后只要窗口重绘一次，
  //  就变成"显示新选中的文字 + 没有文本输出 + 就绪"。现在只有点解释/翻译才换内容。）
  state.selection = { text, x, y, at: Date.now(), context: '', contextUnit: '', contextState: 'idle' }
  menu.dark = systemDark()
  const css = MODES.menu
  const work = workAreaForPoint(api, x, y)
  const scale = monitorScaleForPoint(api, x, y)
  const width = Math.round(css.width * scale)
  const height = Math.round(css.height * scale)
  const px = Math.min(Math.max(x + GAP, work.left), Math.max(work.left, work.right - width))
  const py = Math.min(Math.max(y + GAP, work.top), Math.max(work.top, work.bottom - height))
  menu.visible = true
  menu.rect = { x: px, y: py, width, height }
  menu.scale = scale
  menu.anchor = { x, y }
  menu.hover = -1
  menuWindow.setState({ dark: menu.dark, hover: -1 })
  menuWindow.show(px, py, width, height)
  if (menu.timer !== null) clearTimeout(menu.timer)
  menu.timer = setTimeout(() => {
    hideMenu('timeout')
  }, MENU_TIMEOUT_MS)
  menu.timer.unref?.()
  // 菜单已经可见了才开始读上下文：不给"划词 → 菜单"这条链路加延迟。
  startContextRead(state.selection)
  return menu.rect
}

/** 收起划词菜单（不影响回答窗口）。 */
function hideMenu(reason) {
  if (menu.timer !== null) {
    clearTimeout(menu.timer)
    menu.timer = null
  }
  if (menu.visible) {
    state.lastMenuDismiss = { reason, at: Date.now() }
    menu.visible = false
    if (menuReady()) menuWindow.hide()
  }
  menu.rect = null
  menu.hover = -1
}

// ---------------------------------------------------------------- 跑一轮 agent

/** 复制回答到剪贴板，并在页脚给一个看得见的回执。 */
async function copyAnswer() {
  if (ui.answer === '') {
    setCopyFeedback('没有可复制的内容')
    return
  }
  let copied = false
  try {
    const { writeClipboardText } = await import('./win32.mjs')
    copied = writeClipboardText(api, ui.answer) !== false
  } catch (error) {
    reportError('copy', error)
  }
  setCopyFeedback(copied ? '已复制' : '复制失败')
}

/** 页脚回执（1.6s 后自动消失）。 */
function setCopyFeedback(text) {
  ui.copyFeedback = text
  refreshMain()
  if (copyFeedbackTimer !== null) clearTimeout(copyFeedbackTimer)
  copyFeedbackTimer = setTimeout(() => {
    copyFeedbackTimer = null
    ui.copyFeedback = ''
    refreshMain()
  }, text === '已复制' ? 1600 : 2400)
  copyFeedbackTimer.unref?.()
}

async function stopRun() {
  const sessionId = state.run?.sessionId
  state.run?.abort?.()
  state.run = null
  ui.status = 'done'
  refreshMain()
  if (sessionId === undefined) return
  try {
    await fetch(DSH_ORIGIN + '/api/dsh-selection-tools/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch (error) {
    reportError('stop', error)
  }
}

/** 发起一轮解释/翻译，流式画到回答窗口。 */
function startRun(action) {
  state.run?.abort?.()
  ui.action = action
  // 只有点菜单项才换内容：这里把"这次要处理什么"写进回答窗口
  // （别处一律不动 ui.source —— 新划词只更新 state.selection，不会改窗口）
  ui.source = state.selection === null ? '' : state.selection.text
  ui.answer = ''
  ui.error = ''
  ui.copyFeedback = ''
  ui.status = 'running'
  stopSpeaking()
  ui.scroll = 0
  // 第一次打开时落在屏幕右下角；之后沿用用户拖到的位置
  if (panel.mode === 'hidden') panel.position = null
  applyMainMode('panel')
  refreshMain()

  const controller = new AbortController()
  state.run = { abort: () => controller.abort(), sessionId: undefined }
  const selection = state.selection
  const text = selection === null ? '' : selection.text
  void (async () => {
    try {
      // 点菜单项时上下文通常已经读好了；还在读就再等一下（读不读得到都不影响出结果）
      let context = selection === null ? '' : selection.context
      if (context === '' && state.contextPending !== null) {
        const result = await state.contextPending
        if (result !== null && state.selection === selection) context = result.text
      }
      ui.context = context
      refreshMain()
      const response = await fetch(DSH_ORIGIN + '/api/dsh-selection-tools/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, text, context, locale: LOCALE }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pending = ''
      let lastPaint = Date.now()
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const payload = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
          if (payload !== '') {
            const event = JSON.parse(payload)
            if (event.type === 'delta') pending += event.text
            else if (event.type === 'session') {
              if (state.run !== null) state.run.sessionId = event.sessionId
            } else if (event.type === 'done') {
              pending = ''
              ui.answer = event.text !== '' ? event.text : ui.answer
              ui.status = 'done'
            } else if (event.type === 'error') {
              ui.status = 'error'
              ui.error = event.message
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
        const now = Date.now()
        if (pending !== '' && now - lastPaint > 80) {
          ui.answer += pending
          pending = ''
          lastPaint = now
          refreshMain()
        }
      }
      if (pending !== '') {
        ui.answer += pending
        refreshMain()
      }
    } catch (error) {
      if (controller.signal.aborted) return
      ui.status = 'error'
      ui.error = error instanceof Error ? error.message : String(error)
      refreshMain()
    } finally {
      if (state.run !== null && state.run.sessionId === undefined) state.run = null
      refreshMain()
    }
  })()
}

// ---------------------------------------------------------------- 划词

/**
 * 点是否落在某个窗口矩形内。
 *
 * 注意：这里的矩形是 `{ x, y, width, height }`（窗口几何用的就是这套字段），
 * 而 gesture.mjs 的 pointInRect 读的是 `{ left, right, top, bottom }`。
 * 两者混用会让"点在窗口内"恒为 false——表现为按任何键都立刻收起菜单（菜单"点了就消失"
 * 且点不动），踩过一次。
 */
function inRect(point, rect) {
  if (rect === null || rect === undefined) return false
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

async function handleGesture(gesture) {
  state.lastGesture = { ...gesture, at: Date.now() }
  if (inRect(gesture, menu.rect) || inRect(gesture, panel.rect)) return
  const text = await captureSelection(api, {
    onSkip: (reason) => {
      state.lastCapture = { ok: false, reason, at: Date.now() }
    },
  })
  if (text === null || text.trim() === '') return
  const clamped = clampSelection(text, MAX_TEXT)
  if (clamped === '') return
  state.lastCapture = { ok: true, length: clamped.length, at: Date.now() }
  // 只弹菜单：回答窗口与悬浮球不受影响
  showMenu(clamped, gesture.x, gesture.y)
}

/** 鼠标轮询：手势检测 + 任意键点到别处收起菜单 + Esc 收起菜单。 */
function startHook() {
  const detector = createGestureDetector({
    onGesture: (gesture) => {
      void handleGesture(gesture).catch((error) => reportError('gesture', error))
    },
  })
  const buttons = { left: false, right: false, middle: false }
  let escapePressed = false
  const point = {}
  setInterval(() => {
    try {
      if (!api.GetCursorPos(point)) return
      const left = (Number(api.GetAsyncKeyState(VK_LBUTTON)) & 0x8000) !== 0
      const right = (Number(api.GetAsyncKeyState(VK_RBUTTON)) & 0x8000) !== 0
      const middle = (Number(api.GetAsyncKeyState(VK_MBUTTON)) & 0x8000) !== 0
      detector.push({ down: left, x: point.x, y: point.y, time: Date.now() })

      // 任意按键在别处按下 → 菜单收起（点在菜单自己身上不算）
      const anyDown = (left && !buttons.left) || (right && !buttons.right) || (middle && !buttons.middle)
      if (anyDown && menu.visible && !inRect(point, menu.rect)) hideMenu('outside-click')
      buttons.left = left
      buttons.right = right
      buttons.middle = middle

      const escapeDown = (Number(api.GetAsyncKeyState(VK_ESCAPE)) & 0x8000) !== 0
      if (escapeDown && !escapePressed && menu.visible) hideMenu('escape')
      escapePressed = escapeDown
    } catch (error) {
      reportError('poll', error)
    }
  }, POLL_MS).unref?.()
}

// ---------------------------------------------------------------- HTTP（状态 / 验收）

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

function respondJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/status') {
    respondJson(res, 200, {
      ok: true,
      hookEnabled: HOOK_ENABLED,
      menuTimeoutMs: MENU_TIMEOUT_MS,
      menu: { visible: menu.visible, rect: menu.rect, scale: menu.scale, hover: menu.hover },
      panel: { mode: panel.mode, rect: panel.rect, position: panel.position, scale: panel.scale },
      ui: {
        status: ui.status,
        answerLength: ui.answer.length,
        sourceLength: ui.source.length,
        speaking: ui.speaking,
        copyFeedback: ui.copyFeedback,
        scroll: ui.scroll,
        contentHeight: Math.round(ui.contentHeight),
        viewHeight: Math.round(ui.viewHeight),
      },
      lastGesture: state.lastGesture,
      lastCapture: state.lastCapture,
      lastMenuDismiss: state.lastMenuDismiss ?? null,
      context: {
        enabled: contextReader !== null,
        unit: state.selection === null ? '' : (state.selection.contextUnit ?? ''),
        state: state.selection === null ? 'idle' : (state.selection.contextState ?? 'idle'),
        length: ui.context.length,
        last: state.lastContext,
        stats: contextReader === null ? null : contextReader.stats(),
      },
      errors: state.errors.slice(-5),
      dshOrigin: DSH_ORIGIN,
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/simulate') {
    void (async () => {
      try {
        const body = await readJson(req)
        const text = clampSelection(String(body.text ?? '选中文本'), MAX_TEXT)
        const work = primaryWorkArea(api)
        const x = typeof body.x === 'number' ? body.x : work.right - 400
        const y = typeof body.y === 'number' ? body.y : 300
        const rect = showMenu(text, x, y)
        if (typeof body.context === 'string' && body.context !== '' && state.selection !== null) {
          state.selection.context = body.context
          state.selection.contextState = 'ready'
        }
        respondJson(res, 200, { ok: true, menu: rect })
      } catch (error) {
        reportError('simulate', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/window') {
    void (async () => {
      try {
        const body = await readJson(req)
        const op = String(body.op ?? '')
        if (op === 'mode') {
          const mode = ['panel', 'hidden'].includes(body.mode) ? body.mode : 'panel'
          const geometry = mode === 'hidden' ? (hideMain(), null) : applyMainMode(mode)
          respondJson(res, 200, { ok: true, geometry, mode: panel.mode })
          return
        }
        if (op === 'hide-menu') {
          hideMenu('api')
          respondJson(res, 200, { ok: true, menu: menu.visible })
          return
        }
        respondJson(res, 400, { ok: false, message: 'unknown op "' + op + '"' })
      } catch (error) {
        reportError('window', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/click') {
    void (async () => {
      try {
        const body = await readJson(req)
        const target = String(body.target ?? (menu.visible ? 'menu' : 'main'))
        const cssX = Number(body.x ?? 0)
        const cssY = Number(body.y ?? 0)
        if (target === 'menu') {
          const scale = menuWindow.scale()
          const row = menuRowAt(cssX, cssY)
          if (row >= 0) {
            hideMenu('item-click')
            startRun(row === 0 ? 'explain' : 'translate')
          }
          respondJson(res, 200, { ok: true, target, row })
          return
        }
        const scale = mainWindow.scale()
        const handled = clickMain(cssX, cssY, ui)
        void scale
        respondJson(res, 200, { ok: true, target, handled })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/wheel') {
    void (async () => {
      try {
        const body = await readJson(req)
        const delta = Number(body.delta ?? -120)
        const maxScroll = Math.max(0, ui.contentHeight - ui.viewHeight)
        ui.scroll = Math.min(maxScroll, Math.max(0, ui.scroll - Math.sign(delta) * 60))
        refreshMain()
        respondJson(res, 200, { ok: true, scroll: ui.scroll, maxScroll, rect: panel.rect })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/hittest') {
    void (async () => {
      try {
        const body = await readJson(req)
        const target = String(body.target ?? 'main')
        const cssX = Number(body.x ?? 0)
        const cssY = Number(body.y ?? 0)
        const zone = target === 'menu' ? 'client' : hitZone(cssX * mainWindow.scale(), cssY * mainWindow.scale(), ui)
        // code 是真正回给 Windows 的 WM_NCHITTEST 返回值（10=左 11=右 12=上 15=下，
        // 13/14/16/17 是四个对角）：验收时看这个，别只看语义名字。
        respondJson(res, 200, { ok: true, target, zone, code: hitTestCode(zone) })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/context') {
    void (async () => {
      try {
        const body = await readJson(req)
        if (contextReader === null) {
          respondJson(res, 200, { ok: false, message: 'context reader disabled' })
          return
        }
        const point = { x: Number(body.x ?? 0), y: Number(body.y ?? 0) }
        if (body.diagnose === true) {
          respondJson(res, 200, { ok: true, diagnose: await contextReader.diagnose(point) })
          return
        }
        const expected = typeof body.expected === 'string' ? body.expected : undefined
        respondJson(res, 200, { ok: true, context: await contextReader.read(point, expected), stats: contextReader.stats() })
      } catch (error) {
        reportError('context', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/capture') {
    void (async () => {
      try {
        const body = await readJson(req)
        const file = String(body.file ?? join(tmpdir(), 'dsh-selection-overlay.bmp'))
        const target = String(body.target ?? (panel.mode !== 'hidden' ? 'main' : 'menu'))
        const rect = target === 'menu' ? menu.rect : panel.rect
        if (rect === null) {
          respondJson(res, 400, { ok: false, message: 'window hidden' })
          return
        }
        const shot = captureScreenRect(api, gdi, rect.x, rect.y, rect.width, rect.height, file)
        respondJson(res, 200, { ok: true, ...shot })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  respondJson(res, 404, { ok: false, message: 'not found' })
})

server.listen(Number(process.env.DSH_SELECTION_PORT ?? 0), '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write('dsh-selection-tools companion (native) listening on http://127.0.0.1:' + port + ' (hook=' + (HOOK_ENABLED ? 'on' : 'off') + ')\n')
  if (api === null || gdi === null) {
    reportError('init', new Error('koffi / GDI+ 不可用：系统级划词已禁用'))
    return
  }
  if (HOOK_ENABLED) startHook()
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
process.on('uncaughtException', (error) => reportError('uncaught', error))
process.on('unhandledRejection', (error) => reportError('unhandled', error))
