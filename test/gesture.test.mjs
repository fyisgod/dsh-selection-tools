import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GESTURE_DEFAULTS, createGestureDetector, pointInRect } from '../companion/gesture.mjs'

/** 收集手势的最小 harness。 */
function harness(options = {}) {
  const gestures = []
  const detector = createGestureDetector({ ...options, onGesture: (g) => gestures.push(g) })
  return { gestures, push: detector.push }
}

test('拖选：按下 → 移动超过阈值 → 松开，触发一次 drag', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: true, x: 140, y: 104, time: 20 })
  push({ down: false, x: 160, y: 104, time: 40 })
  assert.equal(gestures.length, 1)
  assert.equal(gestures[0].kind, 'drag')
  assert.equal(gestures[0].x, 160)
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
})

test('两次间隔过久的点击不算双击', () => {
  const { gestures, push } = harness()
  push({ down: true, x: 100, y: 100, time: 0 })
  push({ down: false, x: 100, y: 100, time: 20 })
  push({ down: true, x: 100, y: 100, time: 2000 })
  push({ down: false, x: 100, y: 100, time: 2020 })
  assert.equal(gestures.length, 0)
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
