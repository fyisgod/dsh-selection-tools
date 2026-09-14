import assert from 'node:assert/strict'
import { test } from 'node:test'

import { captureSelection } from '../companion/selection.mjs'
import { WIN } from '../companion/win32.mjs'

/**
 * 剪贴板取词的竞态。
 *
 * 取词的原理是"注入一次 Ctrl+C，再读剪贴板"，而剪贴板是全局的、谁都能写：
 * 用户自己在同一时间按 Ctrl+C、别的应用（剪贴板管理器）写了一次、我们上一次取词的
 * "还原"迟到了——这几件事都会让"读到的内容"不再是"用户选中的文字"，
 * 或者让"还原"把用户刚复制的东西踩掉。这一组测试用一个假 Win32 把这些时序钉住。
 *
 * 假 Win32 只实现 selection.mjs / win32.mjs 真正用到的那几个入口：
 * 前台窗口、剪贴板（含序号与属主）、按键状态、以及"应用响应注入的 Ctrl+C"。
 */
function fakeWin32(config = {}) {
  const APP = 100
  const FOREIGN = 200
  const windows = new Map([
    [APP, { pid: 500, root: APP, className: config.className ?? 'Chrome_WidgetWin_1' }],
    [FOREIGN, { pid: 900, root: FOREIGN, className: 'OtherApp' }],
  ])
  for (const [hwnd, info] of config.extraWindows ?? []) windows.set(hwnd, info)

  const chip = { text: config.clipboard ?? '旧剪贴板内容', seq: 1, owner: 0 }
  const keys = new Set()
  const timers = []
  const log = { injections: 0, reads: 0 }
  /** 注入之后、第一次读剪贴板的动作完成时触发（模拟"我们刚读完别人就写了"）。 */
  let readHookFired = false

  const at = (ms, run) => {
    const timer = setTimeout(run, ms)
    timer.unref?.()
    timers.push(timer)
    return timer
  }
  const writeClipboard = (text, owner) => {
    chip.text = text
    chip.owner = owner
    chip.seq += 1
  }

  const api = {
    // koffi 只被 readClipboardText 用来把指针解成字符串；这里直接回假剪贴板的内容。
    koffi: {
      decode: () => chip.text ?? '',
      // writeClipboardText 用它把一个 JS 缓冲区当成指针传给 RtlMoveMemory。
      as: (buffer) => buffer,
    },
    GetForegroundWindow: () => config.foreground ?? APP,
    GetWindowThreadProcessId: (hwnd, out) => {
      out[0] = windows.get(hwnd)?.pid ?? 0
      return 1
    },
    GetClassNameW: (hwnd, buffer) => {
      const name = windows.get(hwnd)?.className ?? ''
      for (let i = 0; i < name.length; i += 1) buffer[i] = name.charCodeAt(i)
      buffer[name.length] = 0
      return name.length
    },
    GetAncestor: (hwnd, flags) => {
      void flags
      return windows.get(hwnd)?.root ?? hwnd
    },
    GetClipboardSequenceNumber: () => chip.seq,
    GetClipboardOwner: () => chip.owner,
    GetAsyncKeyState: (vk) => (keys.has(vk) ? -32768 : 0),
    keybd_event: (vk, _scan, flags) => {
      if (vk !== WIN.VK_C || (Number(flags) & WIN.KEYEVENTF_KEYUP) === 0) return
      log.injections += 1
      if (config.respond === false) return
      // 可选：注入之后先来一次"没有属主的写入"（模拟上一次取词迟到的还原）
      if (config.staleRestoreMs !== undefined) {
        at(config.staleRestoreMs, () => writeClipboard(config.staleRestoreText ?? '上次取词时的旧内容', config.staleRestoreOwner ?? FOREIGN))
      }
      at(config.copyDelayMs ?? 5, () => writeClipboard(config.selection ?? '选中的文字', config.copyOwner ?? APP))
    },
    OpenClipboard: () => true,
    CloseClipboard: () => {
      if (readHookFired || log.injections === 0 || typeof config.onReadComplete !== 'function') return true
      readHookFired = true
      config.onReadComplete({ write: writeClipboard, hwnd: FOREIGN })
      return true
    },
    EmptyClipboard: () => {
      chip.text = null
      chip.owner = 0
      chip.seq += 1
      return true
    },
    GetClipboardData: () => {
      log.reads += 1
      return chip.text === null ? null : { handle: true }
    },
    SetClipboardData: (_format, handle) => {
      writeClipboard(handle.text ?? '', 0)
      return handle
    },
    // GlobalLock 拿到的指针就是 SetClipboardData 要交出去的那个句柄对象。
    GlobalLock: (handle) => handle,
    GlobalUnlock: () => true,
    GlobalSize: () => (chip.text === null ? 0 : (chip.text.length + 1) * 2),
    GlobalAlloc: () => ({ text: '' }),
    GlobalFree: () => true,
    // 真实现把 JS 缓冲区拷进 GlobalAlloc 的内存；假实现直接把 utf16 文本记在句柄上。
    RtlMoveMemory: (dest, src, count) => {
      dest.text = src.slice(0, Math.max(0, Number(count) - 2)).toString('utf16le')
    },
  }

  return {
    api,
    log,
    chip,
    keys,
    /**
     * 用户自己按 Ctrl+C：按键保持按下 holdMs，同时前台应用把选区写进剪贴板。
     * @param delayMs - 相对"现在"的延迟（用 0 表示注入之前就按下了）。
     */
    userCopy(text = '选中的文字', holdMs = 60, delayMs = 0) {
      at(delayMs, () => {
        keys.add(WIN.VK_CONTROL)
        keys.add(WIN.VK_C)
        writeClipboard(text, APP)
        if (holdMs > 0) {
          at(holdMs, () => {
            keys.delete(WIN.VK_CONTROL)
            keys.delete(WIN.VK_C)
          })
        }
      })
    },
    /** 别人（另一个进程）写剪贴板。 */
    foreignWrite(text = '别人的内容', delayMs = 0) {
      at(delayMs, () => writeClipboard(text, FOREIGN))
    },
    stop() {
      for (const timer of timers) clearTimeout(timer)
    },
  }
}

test('用户在取词窗口内自己按 Ctrl+C：用户复制的内容必须留在剪贴板里', async () => {
  // 应用对我们的注入迟迟不响应（慢应用），用户等不及自己按了 Ctrl+C——
  // 老实现会把"用户刚复制的东西"当成原内容还原掉，于是用户按了 Ctrl+C 却粘贴出旧内容。
  const fake = fakeWin32({ respond: false })
  try {
    fake.userCopy('选中的文字', 60, 20)
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5 })
    assert.equal(text, '选中的文字')
    assert.equal(fake.chip.text, '选中的文字', '不能把用户自己复制的内容还原掉')
  } finally {
    fake.stop()
  }
})

test('别的进程先写了一次（剪贴板管理器、上一次取词迟到的还原）：丢掉，继续等前台应用那次', async () => {
  const fake = fakeWin32({ staleRestoreMs: 10, copyDelayMs: 60 })
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 300, pollMs: 5 })
    assert.equal(text, '选中的文字', '只有不是"别的进程写的"那次才可能是取词结果')
  } finally {
    fake.stop()
  }
})

test('手势落下时用户正按着 Ctrl+C：不注入、不碰剪贴板', async () => {
  const fake = fakeWin32({})
  try {
    fake.keys.add(WIN.VK_CONTROL)
    fake.keys.add(WIN.VK_C)
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5 })
    assert.equal(text, null)
    assert.equal(fake.log.injections, 0, '用户正在按 Ctrl+C 时绝不能注入自己的 Ctrl+C')
    assert.equal(fake.chip.text, '旧剪贴板内容')
    assert.equal(fake.chip.seq, 1)
  } finally {
    fake.stop()
  }
})

test('我们读完剪贴板之后别人又写了一次：不还原，别踩掉新的内容', async () => {
  const fake = fakeWin32({
    onReadComplete: ({ write, hwnd }) => write('别人的内容', hwnd),
  })
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5 })
    assert.equal(text, '选中的文字')
    assert.equal(fake.chip.text, '别人的内容', '还原前要确认剪贴板还是我们刚读到的内容')
  } finally {
    fake.stop()
  }
})

test('一切正常：读到选中文字，并且把用户原来的剪贴板内容还原回去', async () => {
  const fake = fakeWin32({})
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5 })
    assert.equal(text, '选中的文字')
    assert.equal(fake.chip.text, '旧剪贴板内容')
    assert.equal(fake.log.injections, 1)
  } finally {
    fake.stop()
  }
})

test('前台窗口没人响应注入：超时返回 null，剪贴板一动不动', async () => {
  const fake = fakeWin32({ respond: false })
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 60, pollMs: 5 })
    assert.equal(text, null)
    assert.equal(fake.chip.text, '旧剪贴板内容')
    assert.equal(fake.chip.seq, 1)
  } finally {
    fake.stop()
  }
})

test('控制台/终端窗口照旧跳过（Ctrl+C 在那里是中断）', async () => {
  const fake = fakeWin32({ className: 'ConsoleWindowClass' })
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 60, pollMs: 5 })
    assert.equal(text, null)
    assert.equal(fake.log.injections, 0)
  } finally {
    fake.stop()
  }
})

test('UWP 那种"前台是框架窗口、真正复制的是它的子窗口"照样认', async () => {
  // 前台窗口 = 框架窗口（pid 700），剪贴板属主 = 它的子窗口（pid 500）：进程不同，
  // 但顶层祖先同一个——这是 Windows 上 UWP 应用（记事本、设置…）的常态。
  const fake = fakeWin32({
    foreground: 300,
    copyOwner: 301,
    extraWindows: [
      [300, { pid: 700, root: 300, className: 'ApplicationFrameWindow' }],
      [301, { pid: 500, root: 300, className: 'Windows.UI.Core.CoreWindow' }],
    ],
  })
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5 })
    assert.equal(text, '选中的文字')
  } finally {
    fake.stop()
  }
})

test('一整轮只有别的进程在写：这一轮就不算取到词（宁可不弹菜单，也不弹错的）', async () => {
  const fake = fakeWin32({ copyOwner: 200 })
  try {
    const reports = []
    const text = await captureSelection(fake.api, { timeoutMs: 80, pollMs: 5, onReport: (r) => reports.push(r) })
    assert.equal(text, null)
    assert.equal(reports[0].reason, 'foreign-write')
  } finally {
    fake.stop()
  }
})

test('认不出属主的写入放行：真实机器上"无属主"并不罕见，一律拒绝会让个别应用弹不出菜单', async () => {
  // 实测：本机剪贴板里上一次复制的内容就是"无属主"的（写入进程已退出/无窗口）。
  // 所以只有"确定是别的进程写的"才丢——"我们自己的还原落在别人取词窗口里"那条路
  // 已经由手势串行队列从根上排除（见 gesture.test.mjs 的队列用例）。
  const fake = fakeWin32({ copyOwner: 0 })
  try {
    const reports = []
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5, onReport: (r) => reports.push(r) })
    assert.equal(text, '选中的文字')
    assert.equal(reports[0].owner, 'no-owner')
  } finally {
    fake.stop()
  }
})

test('属主判断可以关掉（逃生舱）：不认属主时按序号变化取词', async () => {
  const fake = fakeWin32({ copyOwner: 0 })
  try {
    const text = await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5, checkOwner: false })
    assert.equal(text, '选中的文字')
  } finally {
    fake.stop()
  }
})

test('诊断报告说清楚这次取词做了什么（注入/属主/还原的取舍）', async () => {
  const fake = fakeWin32({})
  try {
    const reports = []
    await captureSelection(fake.api, { timeoutMs: 200, pollMs: 5, onReport: (r) => reports.push(r) })
    assert.equal(reports.length, 1)
    const report = reports[0]
    assert.equal(report.ok, true)
    assert.equal(report.reason, 'ok')
    assert.equal(report.injected, true)
    assert.equal(report.length, '选中的文字'.length)
    assert.equal(report.restore, 'restored')
    assert.equal(report.owner, 'ours')
  } finally {
    fake.stop()
  }
})
