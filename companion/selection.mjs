/**
 * 从"当前前台应用"里取回用户刚选中的文字。
 *
 * 做法是 Windows 划词工具的通行方案：注入一次 Ctrl+C，然后读剪贴板。它的代价
 * 是短暂改写剪贴板——所以默认会把用户原来的剪贴板内容**原样还原**。控制台类
 * 窗口（Ctrl+C 是中断）默认跳过，避免误伤正在跑的命令。
 */
import { WIN, readClipboardText, sendCopyShortcut, windowClass } from './win32.mjs'

/** 控制台/终端窗口类名（Ctrl+C 在这些窗口里是中断而不是复制）。 */
const TERMINAL_CLASSES = [
  'ConsoleWindowClass',
  'CASCADIA_HOSTING_WINDOW_CLASS',
  'mintty',
  'PuTTY',
  'ConEmu',
  'Windows.UI.Core.CoreWindow',
]

/** 前台窗口是否是终端（取词前先排除）。 */
export function isTerminalWindow(api, hwnd) {
  const name = windowClass(api, hwnd)
  return TERMINAL_CLASSES.some((prefix) => name.startsWith(prefix))
}

/** 睡眠。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 取回选中文本。
 * @param api - createWin32() 的产物。
 * @param options - \`restoreClipboard\`（默认 true）、\`timeoutMs\`、\`onSkip\`。
 * @returns 选中文本；没取到返回 null。
 */
export async function captureSelection(api, options = {}) {
  const restoreClipboard = options.restoreClipboard !== false
  const timeoutMs = options.timeoutMs ?? 900
  const foreground = api.GetForegroundWindow()
  if (isTerminalWindow(api, foreground)) {
    options.onSkip?.('terminal')
    return null
  }

  const before = readClipboardText(api)
  const beforeSeq = Number(api.GetClipboardSequenceNumber())
  sendCopyShortcut(api)

  const deadline = Date.now() + timeoutMs
  let text = null
  while (Date.now() < deadline) {
    await delay(40)
    const seq = Number(api.GetClipboardSequenceNumber())
    if (seq === beforeSeq) continue
    const captured = readClipboardText(api)
    if (typeof captured === 'string' && captured.trim() !== '') {
      text = captured
      break
    }
  }

  if (restoreClipboard && text !== null && typeof before === 'string' && before !== text) {
    try {
      const { writeClipboardText } = await import('./win32.mjs')
      writeClipboardText(api, before)
    } catch {
      /* 还原失败不影响本次取词 */
    }
  }
  return text
}

/** 供路由使用：把选中文本裁到上限。 */
export function clampSelection(text, limit) {
  if (typeof text !== 'string') return ''
  return text.length > limit ? text.slice(0, limit) : text
}
