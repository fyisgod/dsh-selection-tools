/**
 * 系统级划词伴生进程的生命周期管理。
 *
 * 插件本体跑在 dsh 进程里，做不了"全局划词 + 置顶浮层"这类系统级动作，
 * 于是把这块交给一个独立的 Node 伴生进程（companion/main.mjs，用 dsh 自带的
 * koffi 调 Win32）。这里只负责：按需拉起、读取它上报的端口、异常退出后退避重启、
 * 插件卸载时收尸。
 *
 * 伴生进程崩溃或不可用，只影响"系统级划词"这一条能力，DSH 本体与页内划词不受影响。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 伴生进程入口（本包内的相对路径）。 */
const COMPANION_ENTRY = fileURLToPath(new URL('../companion/main.mjs', import.meta.url))

/** 伴生进程对外状态。 */
export interface CompanionStatus {
  state: 'stopped' | 'starting' | 'running' | 'failed'
  port?: number
  pid?: number
  restarts: number
  lastError?: string
  startedAt?: number
}

/** 插件侧上下文里本模块用到的最小面。 */
export interface CompanionContext {
  logger?: { warn?: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
  effect: (callback: () => unknown, label?: string) => unknown
  webServer: { port?: number }
  get?: (name: string) => any
}

/** 监听端口上报的日志行：\`... listening on http://127.0.0.1:<port>\`。 */
const PORT_PATTERN = /listening on http:\/\/127\.0\.0\.1:(\d+)/

/**
 * 创建伴生进程管理器。
 * @param ctx - 插件上下文。
 * @param options - \`enabled\`（默认 true）、\`maxRestarts\`。
 */
export function createCompanionManager(
  ctx: CompanionContext,
  options: { enabled?: boolean; maxRestarts?: number } = {},
) {
  const enabled = options.enabled !== false
  const maxRestarts = options.maxRestarts ?? 5
  let child: ChildProcess | null = null
  let stopping = false
  let status: CompanionStatus = { state: 'stopped', restarts: 0 }

  /** dsh 安装目录里的某个文件（用作 koffi 解析锚点）。 */
  function koffiHint(): string {
    const argv1 = process.argv[1]
    return typeof argv1 === 'string' && argv1.endsWith('.js') ? argv1 : ''
  }

  /** 启动伴生进程。 */
  function start(): void {
    if (!enabled || child !== null) return
    const port = ctx.webServer?.port
    const origin = typeof port === 'number' && port > 0 ? 'http://127.0.0.1:' + port : 'http://127.0.0.1:3080'
    status = { state: 'starting', restarts: status.restarts, startedAt: Date.now() }
    const spawned = spawn(process.execPath, [COMPANION_ENTRY], {
      env: {
        ...process.env,
        DSH_SELECTION_DSH_ORIGIN: origin,
        DSH_SELECTION_KOFFI_HINT: koffiHint(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child = spawned
    spawned.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      const match = PORT_PATTERN.exec(text)
      if (match !== null) {
        status = { ...status, state: 'running', port: Number(match[1]), pid: spawned.pid }
        ctx.logger?.info?.('dsh-selection-tools: companion ready on ' + match[1])
      }
    })
    spawned.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text !== '') status = { ...status, lastError: text.slice(-400) }
    })
    spawned.on('exit', (code, signal) => {
      child = null
      if (stopping) {
        status = { ...status, state: 'stopped', pid: undefined }
        return
      }
      status = { ...status, state: 'failed', pid: undefined, lastError: 'exited (code=' + String(code) + ' signal=' + String(signal) + ')' }
      ctx.logger?.warn?.('dsh-selection-tools: companion exited (code=' + String(code) + ')')
      if (status.restarts < maxRestarts) {
        status.restarts += 1
        const delay = Math.min(30_000, 1000 * 2 ** status.restarts)
        setTimeout(() => {
          if (!stopping) start()
        }, delay).unref?.()
      }
    })
  }

  /** 停止伴生进程。 */
  function stop(): void {
    stopping = true
    if (child !== null) {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      child = null
    }
    status = { ...status, state: 'stopped', pid: undefined }
  }

  return {
    start,
    stop,
    status: () => ({ ...status, enabled, entry: COMPANION_ENTRY }),
    /** 把伴生进程绑到插件生命周期上。 */
    install(): void {
      ctx.effect(() => {
        start()
        return () => {
          stopping = true
          stop()
        }
      }, 'dsh-selection-tools: companion')
    },
  }
}
