import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'

import { createCompanionManager } from '../src/companion.ts'

/**
 * 伴生进程管理器的生命周期：**重启必须只留下一个伴生进程**。
 *
 * 三条都是真踩过的坑：
 * 1. kill() 漏杀 → 老伴生进程还活着，两个进程各自钩全局鼠标、各自开浮层，
 *    用户看到两个菜单、两个回答窗口，而插件只认得新的那一个；
 * 2. 迟到的 exit（老伴生进程事后才退）把**新**进程的引用与状态一起抹掉；
 * 3. stop() 置位的 stopping 没复位 → /system/restart 之后看门狗永久失效，
 *    伴生进程再崩也不会自动重启。
 *
 * 假伴生进程用**真进程**（这样 kill 是真的），只是 stdio 不接管道——受限环境里
 * 管道的子进程会 EPERM，而这里也不需要那行端口上报。
 */

/** 起一个真实的常驻子进程当"伴生进程"。 */
function dummyChild() {
  return spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], { stdio: 'ignore', windowsHide: true })
}

/** kill() 杀不掉的假孩子：模拟"kill 没生效、exit 迟到"。 */
class ZombieChild extends EventEmitter {
  constructor() {
    super()
    this.pid = undefined
    this.exitCode = null
    this.signalCode = null
    this.stdout = null
    this.stderr = null
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }

  /** 老伴生进程"现在才退出"。 */
  die(code = 0) {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

function alive(pid) {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function until(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await delay(15)
  }
}

function harness(options = {}) {
  const children = []
  const makeChild = options.makeChild ?? dummyChild
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: (callback) => callback(),
    webServer: { port: 3080 },
  }
  const manager = createCompanionManager(ctx, {
    maxRestarts: 2,
    killGraceMs: 120,
    // 测试里不等真实退避（默认 1s/2s/…）
    restartDelayMs: () => 30,
    spawnChild: () => {
      const child = makeChild()
      children.push(child)
      return child
    },
  })
  return { manager, children }
}

test('restart：老进程真的退出，只剩一个新的伴生进程', async (t) => {
  const { manager, children } = harness()
  t.after(() => manager.stop())
  manager.start()
  assert.equal(children.length, 1)
  assert.ok(await until(() => alive(children[0].pid)), '第一个伴生进程应该起得来')

  await manager.restart()
  assert.equal(children.length, 2, 'restart 要拉起一个新的')
  assert.ok(await until(() => !alive(children[0].pid)), '老的必须死掉：否则两个进程各钩一次全局鼠标')
  assert.ok(alive(children[1].pid))
  assert.notEqual(manager.status().state, 'stopped', 'restart 之后状态不能停在 stopped')
})

test('restart 之后看门狗仍然有效（stopping 必须复位）', async (t) => {
  const { manager, children } = harness()
  t.after(() => manager.stop())
  manager.start()
  await manager.restart()
  const second = children[1]
  assert.ok(await until(() => alive(second.pid)))

  second.kill() // 模拟伴生进程崩溃
  assert.ok(await until(() => children.length === 3), '崩溃之后应该自动重启')
  assert.ok(await until(() => alive(children[2].pid)))
})

test('迟到的老进程 exit 不会把新进程抹掉', async (t) => {
  const queue = [new ZombieChild(), new ZombieChild()]
  const { manager, children } = harness({ makeChild: () => queue.shift() })
  t.after(() => manager.stop())
  manager.start()
  // kill 杀不掉 → 等强杀宽限超时，仍然拉起新的
  await manager.restart()
  assert.equal(children.length, 2)
  assert.equal(children[0].killed, true, 'restart 应该先试着 kill 老进程')

  children[0].die(0) // 老伴生进程现在才退出
  await delay(200)
  assert.equal(children.length, 2, '迟到的 exit 不能再触发一次重启')
  assert.notEqual(manager.status().state, 'stopped', '迟到的 exit 不能把状态写成 stopped')
})

test('stop() 会取消排队中的自动重启', async (t) => {
  const { manager, children } = harness()
  t.after(() => manager.stop())
  manager.start()
  const first = children[0]
  assert.ok(await until(() => alive(first.pid)))
  first.kill() // 崩溃 → 30ms 后排了自动重启
  manager.stop() // 立刻收工
  await delay(160)
  assert.equal(children.length, 1, 'stop() 之后不该再冒出新进程')
  assert.equal(manager.status().state, 'stopped')
})
