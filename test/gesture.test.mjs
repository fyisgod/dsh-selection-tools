import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GESTURE_DEFAULTS, createGestureDetector, createLatestQueue, pointInRect } from '../companion/gesture.mjs'
import { menuDecision } from '../companion/policy.mjs'

/** 收集手势的最小 harness。 */
function harness(options = {}) {
  const gestures = []
  const presses = []
  const detector = createGestureDetector({ ...options, onGesture: (g) => gestures.push(g), onPress: (p) => presses.push(p) })
  return { gestures, presses, push: detector.push }
}

test('拖选：按下 → 移动超过阈值 → 松开，触发一次 drag', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: true, x: 140, y: 104, time: 20 })
  push({ down: false, x: 160, y: 104, time: 40 })
  assert.equal(gestures.length, 1)
  assert.equal(gestures[0].kind, 'drag')
  assert.equal(gestures[0].x, 160)
  // 按下的位置也要带上：调用方靠它判断"这次手势是不是选出了那段文字"
  assert.equal(gestures[0].downX, 100)
  assert.equal(gestures[0].downY, 100)
})

test('单击：位移小于阈值不触发任何手势', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: false, x: 101, y: 101, time: 30 })
  assert.equal(gestures.length, 0)
})

test('双击选词：两次快速同点点击触发一次 double', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: false, x: 100, y: 100, time: 20 })
  push({ down: true, x: 101, y: 100, time: 120 })
  push({ down: false, x: 101, y: 100, time: 140 })
  assert.equal(gestures.length, 1)
  assert.equal(gestures[0].kind, 'double')
  assert.equal(gestures[0].downX, 101)
  assert.equal(gestures[0].downY, 100)
})

test('两次间隔过久的点击不算双击', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: false, x: 100, y: 100, time: 20 })
  push({ down: true, x: 100, y: 100, time: 2000 })
  push({ down: false, x: 100, y: 100, time: 2020 })
  assert.equal(gestures.length, 0)
})

test('按下的那一刻要回调一次 onPress：调用方靠它拍"手势之前的选区"快照', () => {
  const { presses, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  // 按住期间的采样不能重复回调（快照只拍一次）
  push({ down: true, x: 120, y: 100, time: 20 })
  push({ down: false, x: 140, y: 100, time: 40 })
  assert.deepEqual(presses, [{ x: 100, y: 100, time: 0, second: false }])
})

test('双击的第二下要标出来（second=true）：那时不能重拍快照——要的是这一串点击之前的选区', () => {
  const { presses, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: false, x: 100, y: 100, time: 20 })
  push({ down: true, x: 101, y: 100, time: 120 })
  push({ down: false, x: 101, y: 100, time: 140 })
  assert.deepEqual(presses.map((p) => p.second), [false, true])
})

test('串起采样与策略：拖动一个"按下时就已经选中"的元素不弹菜单，拖选文字才弹', () => {
  // 复现用户报的那条：按下时 UIA 报着"这个对象被选中"，拖完还是同一段（元素被挪走了）。
  // 两个手势的采样完全一样，唯一的差别是按下那一刻拍到的快照。
  const decide = (preselected) => {
    const decisions = []
    const detector = createGestureDetector({
      onPress: () => {},
      onGesture: (gesture) => decisions.push(menuDecision(
        { selection: '形状里的文字', source: 'point', atGesture: true },
        '',
        { kind: gesture.kind, pressProbe: preselected ? { selection: '形状里的文字' } : { selection: '' } },
      )),
    })
    for (const [down, time, x] of [[true, 0, 100], [true, 20, 140], [false, 40, 160]]) {
      detector.push({ down, time, x, y: 100 })
    }
    return decisions
  }
  assert.deepEqual(decide(true), [{ open: false, reason: 'unchanged-selection' }])
  assert.deepEqual(decide(false), [{ open: true, reason: 'selection' }])
})

test('拖动中的位置抖动不会误判成双击', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: false, x: 100, y: 100, time: 20 })
  push({ down: true, x: 100, y: 100, time: 120 })
  push({ down: true, x: 180, y: 130, time: 200 })
  push({ down: false, x: 200, y: 130, time: 260 })
  assert.equal(gestures.length, 1)
  assert.equal(gestures[0].kind, 'drag')
})

test('阈值可覆盖', () => {
  const { gestures, push } = harness({ dragMinDistance: 50 })
  push({ down: true, x: 0, y: 0, time: 0 })
  push({ down: false, x: 20, y: 0, time: 20 })
  assert.equal(gestures.length, 0)
  assert.equal(GESTURE_DEFAULTS.dragMinDistance, 5)
})

test('pointInRect 边界', () => {
  const rect = { left: 0, top: 0, right: 10, bottom: 10 }
  assert.equal(pointInRect({ x: 5, y: 5 }, rect), true)
  assert.equal(pointInRect({ x: 11, y: 5 }, rect), false)
  assert.equal(pointInRect({ x: 5, y: 5 }, null), false)
})


/**
 * 取词不能重叠：两次取词同时注入 Ctrl+C / 读同一个全局剪贴板，结果就会串台
 * （用户看到的是"点菜单按钮后窗口里的输入内容与选中的文字不符"）。
 * 队列负责"同一时刻只跑一个 + 只作数最新那次"。
 */
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('手势串行：同一时刻只有一个在跑，排队时只保留最新那次', async () => {
  const events = []
  const queue = createLatestQueue({
    run: async (payload) => {
      events.push('start:' + payload)
      await tick(20)
      events.push('end:' + payload)
    },
  })
  const first = queue.submit('A')
  queue.submit('B') // 跑 A 期间来的：被更晚的 C 顶掉
  const third = queue.submit('C')
  await tick(80)
  assert.deepEqual(events, ['start:A', 'end:A', 'start:C', 'end:C'])
  assert.equal(queue.isLatest(first), false, 'A 的结果已经被 C 取代，不能再拿去弹菜单')
  assert.equal(queue.isLatest(third), true)
})

test('队列吃掉异常：一个任务抛错不影响后面的手势', async () => {
  const errors = []
  const done = []
  const queue = createLatestQueue({
    run: async (payload) => {
      if (payload === 'boom') throw new Error('取词炸了')
      done.push(payload)
    },
    onError: (error) => errors.push(error.message),
  })
  queue.submit('boom')
  queue.submit('ok')
  await tick(10)
  assert.deepEqual(errors, ['取词炸了'])
  assert.deepEqual(done, ['ok'])
})
