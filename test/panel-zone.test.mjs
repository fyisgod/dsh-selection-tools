import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MODES, PANEL_RESIZE, panelButtons, panelEdgeZone, panelHit, panelHitZone } from '../companion/native/ui.mjs'
import { hitTestCode } from '../companion/native/window.mjs'

/**
 * 回答窗口的缩放手柄：**四边 + 四角，八个方向都能用鼠标拖着改大小**。
 *
 * 命中区是纯函数（ui.mjs 的 panelEdgeZone / panelHitZone），所以这里能直接把
 * "某个 DIP 坐标会落到哪条边、回给 Windows 哪个 HT 代码"钉住——浮层是自绘的弹窗，
 * 没有系统边框帮忙，错了只能靠人肉拖窗口才发现（右下角曾经就是这么跑偏的）。
 */
const W = MODES.panel.width
const H = MODES.panel.height
/** 空闲面板：没有原文/上下文，也没有「停止」按钮。 */
const IDLE = { source: '', context: '', stopBox: null }

test('四条边都能缩放（上边过去留给拖动，现在也是缩放手柄）', () => {
  const edges = {
    'resize-left': [2, H / 2],
    'resize-right': [W - 2, H / 2],
    'resize-top': [W / 2, 2],
    'resize-bottom': [W / 2, H - 2],
  }
  for (const [zone, [x, y]] of Object.entries(edges)) {
    assert.equal(panelEdgeZone(x, y, W, H), zone)
    assert.equal(panelHitZone(x, y, IDLE, W, H), zone)
  }
})

test('四个角都是对角缩放手柄（上左/上右不再只是"左右边"）', () => {
  const corners = {
    'resize-topleft': [2, 2],
    'resize-topright': [W - 2, 2],
    'resize-bottomleft': [2, H - 2],
    'resize-bottomright': [W - 2, H - 2],
  }
  for (const [zone, [x, y]] of Object.entries(corners)) {
    assert.equal(panelEdgeZone(x, y, W, H), zone)
    assert.equal(panelHitZone(x, y, IDLE, W, H), zone)
  }
})

test('八个方向各自映射到不同的 HT 代码（真正回给 Windows 的那个）', () => {
  // 10=左 11=右 12=上 15=下；13/14/16/17 = 四个对角（HTLEFT / HTTOP …）
  const expected = {
    'resize-left': 10,
    'resize-right': 11,
    'resize-top': 12,
    'resize-topleft': 13,
    'resize-topright': 14,
    'resize-bottom': 15,
    'resize-bottomleft': 16,
    'resize-bottomright': 17,
  }
  const codes = new Set()
  for (const [zone, code] of Object.entries(expected)) {
    assert.equal(hitTestCode(zone), code, zone)
    // 退化成客户区（1）就等于"这块拉不动"
    assert.notEqual(code, hitTestCode('client'))
    codes.add(code)
  }
  assert.equal(codes.size, 8)
})

test('窗口中间既不是手柄也不是拖动区', () => {
  assert.equal(panelEdgeZone(W / 2, H / 2, W, H), null)
  assert.equal(panelHitZone(W / 2, H / 2, IDLE, W, H), 'client')
})

test('标题栏（按钮之外）仍然是拖动区', () => {
  assert.equal(panelHitZone(W / 2, 22, IDLE, W, H), 'caption')
  assert.equal(hitTestCode('caption'), 2) // HTCAPTION
})

test('标题栏按钮压过右上角的缩放手柄', () => {
  const close = panelButtons(IDLE, W).find((button) => button.id === 'close')
  assert.ok(close !== undefined)
  // 关闭按钮的最右端正好落在右上角区里：这一点必须是按钮的，不能被手柄抢走
  const x = close.x + close.size - 2
  const y = close.y + 2
  assert.equal(panelEdgeZone(x, y, W, H), 'resize-topright')
  assert.equal(panelHit(x, y, IDLE, W), 'close')
  assert.equal(panelHitZone(x, y, IDLE, W, H), 'client')
  // 按钮上方那一条仍然是上边手柄（上边整条都能拉）
  assert.equal(panelHitZone(x, 3, IDLE, W, H), 'resize-topright')
})

test('页脚「停止」压过下边的缩放手柄', () => {
  const stop = { x: W - 46, y: H - 30, width: 36, height: 26 }
  const state = { source: '原文', context: '', stopBox: stop }
  const x = stop.x + 10
  const y = H - 4
  assert.equal(panelEdgeZone(x, y, W, H), 'resize-bottom')
  assert.equal(panelHit(x, y, state, W), 'stop')
  assert.equal(panelHitZone(x, y, state, W, H), 'client')
  // 同一条边上、按钮左边一点仍然是缩放手柄
  assert.equal(panelHitZone(x - 60, y, state, W, H), 'resize-bottom')
})

test('手柄跟着窗口的实际尺寸走，不是设计尺寸', () => {
  const W2 = 700
  const H2 = 600
  // 400×480 的右边，在拖大之后的窗口里是正文
  assert.equal(panelEdgeZone(W - 2, H / 2, W, H), 'resize-right')
  assert.equal(panelEdgeZone(W - 2, H / 2, W2, H2), null)
  assert.equal(panelEdgeZone(W2 - 2, H2 / 2, W2, H2), 'resize-right')
  assert.equal(panelHitZone(W2 - 2, H2 - 2, IDLE, W2, H2), 'resize-bottomright')
})

test('角区比边宽：圆角处的透明像素也要抓得住', () => {
  // 分层窗口的透明像素不接收鼠标，窗口圆角（16 DIP）正好在角上——角区窄了角就废了
  assert.ok(PANEL_RESIZE.corner > PANEL_RESIZE.edge)
  assert.ok(PANEL_RESIZE.corner >= MODES.panel.radius)
})

test('边缘外一点点也算命中（原生缩放时坐标可能微负数）', () => {
  assert.equal(panelEdgeZone(-1, H / 2, W, H), 'resize-left')
  assert.equal(panelEdgeZone(W + 1, H / 2, W, H), 'resize-right')
  assert.equal(panelEdgeZone(W / 2, H + 1, W, H), 'resize-bottom')
})
