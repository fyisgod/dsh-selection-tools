/**
 * 浏览器半边对宿主插件路由的调用层：同源 fetch + SSE 帧解析，
 * 外加从官方 client 服务读取「当前会话/当前模型」的只读快照。
 */
import {
  API_PREFIX,
  MAX_CONTEXT_LENGTH,
  parseRunEvent,
  type RunRequest,
  type SelectionAction,
  type UiLocale,
} from '../shared/protocol.js'

/** 一轮运行的订阅面。 */
export interface RunHandlers {
  /** 宿主解析出运行会话后立即回调。 */
  onSession?: (sessionId: string) => void
  /** assistant 文本增量。 */
  onDelta: (text: string) => void
  /** 服务端汇总后的最终文本。 */
  onDone: (text: string, sessionId: string) => void
  /** 失败（含 HTTP / 网络 / 业务错误）。 */
  onError: (message: string) => void
}

/** 当前会话上下文：cwd 决定复用哪条插件会话，provider/model 与 DSH 保持一致。 */
export interface CurrentContext {
  sessionId?: string
  cwd?: string
  provider?: string
  model?: string
}

/** 从字符串里取第一个非空字符串字段。 */
function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 读取当前会话的 cwd 与生效模型（与 DSH 输入框模型座位同源）。
 * 任何一步缺席都安静降级——宿主会回落到部署默认模型。
 * @param ctx - 客户端 Cordis 上下文。
 */
export function readCurrentContext(ctx: { get?: (name: string) => any }): CurrentContext {
  const result: CurrentContext = {}
  try {
    const sessions = ctx.get?.('sessions')
    const snapshot = sessions?.list?.getSnapshot?.()
    const current = pickString(snapshot?.current)
    if (current === undefined) return result
    result.sessionId = current
    result.cwd = pickString(snapshot?.byId?.[current]?.cwd)
    const selection = ctx.get?.('modelDirectories')?.directoryFor?.(current)?.store?.getSnapshot?.()?.current
    result.provider = pickString(selection?.provider)
    result.model = pickString(selection?.model)
  } catch {
    /* 服务缺席或作用域尚未就绪：按缺省处理 */
  }
  return result
}

/** 界面语言：与宿主 html lang / 浏览器语言一致。 */
export function detectLocale(): UiLocale {
  try {
    const lang = String(document?.documentElement?.lang ?? '')
    if (lang.toLowerCase().startsWith('zh')) return 'zh'
    if (lang !== '') return 'en'
    return String(navigator?.language ?? 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}

/**
 * 发起一轮划词翻译/解释。
 * @param action - 菜单动作。
 * @param text - 选中文本。
 * @param ctx - 客户端上下文（读取当前会话）。
 * @param context - 选中文本所在的上下文段落（页内路径取块级元素文本；没有就传空串）。
 * @returns abort：中止本次流（宿主侧仍会跑完，除非另行调用 stop）。
 */
export function startRun(
  action: SelectionAction,
  text: string,
  ctx: { get?: (name: string) => any },
  context: string,
  handlers: RunHandlers,
): { abort: () => void; sessionId: () => string | undefined } {
  const controller = new AbortController()
  let sessionId: string | undefined
  const session = readCurrentContext(ctx)
  const trimmed = typeof context === 'string' ? context.trim() : ''
  const request: RunRequest = {
    action,
    text,
    locale: detectLocale(),
    ...(trimmed === '' ? {} : { context: trimmed.slice(0, MAX_CONTEXT_LENGTH) }),
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(session.provider === undefined ? {} : { provider: session.provider }),
    ...(session.model === undefined ? {} : { model: session.model }),
  }

  void (async () => {
    try {
      const response = await fetch(`${API_PREFIX}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        handlers.onError(detail === '' ? `HTTP ${response.status}` : detail)
        return
      }
      if (response.body === null) {
        handlers.onError('response body is not streamable')
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
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
          const event = payload === '' ? undefined : parseRunEvent(payload)
          if (event?.type === 'session') {
            sessionId = event.sessionId
            handlers.onSession?.(event.sessionId)
          } else if (event?.type === 'delta') {
            handlers.onDelta(event.text)
          } else if (event?.type === 'done') {
            sessionId = event.sessionId
            handlers.onDone(event.text, event.sessionId)
          } else if (event?.type === 'error') {
            handlers.onError(event.message)
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return
      handlers.onError(error instanceof Error ? error.message : String(error))
    }
  })()

  return {
    abort: () => controller.abort(),
    sessionId: () => sessionId,
  }
}

/** 请求宿主停止某条会话上正在跑的一轮（与官方 Stop 走同一条 agent.cancel）。 */
export async function stopRun(sessionId: string | undefined): Promise<void> {
  if (sessionId === undefined) return
  try {
    await fetch(`${API_PREFIX}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch {
    /* 停止失败不阻塞界面 */
  }
}
