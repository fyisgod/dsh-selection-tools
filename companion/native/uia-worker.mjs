/**
 * UIA 上下文读取的 worker 线程入口。
 *
 * 单独一条线程的意义：
 * - UIA 的调用是同步 COM，目标应用无响应时会把调用线程一起卡住；跑在 worker 里，
 *   主进程可以用超时直接 terminate 掉它，取词/菜单循环不受影响。
 * - 读失败一律回 null，调用方安静降级成"只送选区"。
 */
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

import { createUiaReader } from './uia.mjs'

let reader = null

/** 懒建 reader（第一次真正要读上下文时才加载 koffi / 初始化 COM）。 */
function ensureReader() {
  if (reader !== null) return reader
  const hint = typeof workerData?.koffiHint === 'string' && workerData.koffiHint !== '' ? workerData.koffiHint : import.meta.url
  const koffi = createRequire(hint)('koffi')
  reader = createUiaReader(koffi)
  return reader
}

/** 睡眠（重试间隔）。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 读不到时的重试次数与间隔。 */
const RETRIES = 2
const RETRY_GAP_MS = 160

parentPort?.on('message', async (message) => {
  const id = message?.id
  try {
    const api = ensureReader()
    if (message?.type === 'diagnose') {
      parentPort.postMessage({ id, result: api.diagnose(message.point) })
      return
    }
    let result = api.read(message.point, message.expected)
    // 关键：**第一次 UIA 查询往往读不到**——Chromium 这类应用是"被 UIA 问到才打开
    // 无障碍树"，冷启动那一刻 TextPattern 还不存在（实测：第 0 次 no text pattern，
    // 第 1 次开始 selection/paragraph 都正常）。所以第一次空了就等一会儿再读。
    for (let attempt = 1; attempt <= RETRIES && result === null; attempt++) {
      await sleep(RETRY_GAP_MS)
      result = api.read(message.point, message.expected)
    }
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({ id, result: null, error: error instanceof Error ? error.message : String(error) })
  }
})
