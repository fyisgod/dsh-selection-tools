/**
 * 划词策略单测：菜单该不该弹、这一次用哪段文字。
 *
 * 这两条判断是「菜单呼不出来」和「回答的不是我选的那段」两个老问题的分水岭，
 * 所以每条分支都钉住——反证过：把 \`menuDecision\` 的 no-selection 分支改成一律弹，
 * 「拖窗口也弹菜单」的用例立刻红。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { menuDecision, pickSelection } from '../companion/policy.mjs'

test('读不到 UIA 文本时照弹：不知道用户选没选，点菜单项还有剪贴板兜底', () => {
  assert.deepEqual(menuDecision(null), { open: true, reason: 'unknown' })
  assert.deepEqual(menuDecision(undefined), { open: true, reason: 'unknown' })
})

test('读到了选中文字：弹', () => {
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point' }), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision({ selection: '  hi ', source: 'focused' }), { open: true, reason: 'selection' })
})

test('点上元素带 TextPattern 却没有选区：这是「没在选文字」，不弹（拖窗口/拖滑块/双击图标都不该弹）', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'point' }), { open: false, reason: 'no-selection' })
  assert.deepEqual(menuDecision({ selection: '   ', source: 'point' }), { open: false, reason: 'no-selection' })
})

test('只有焦点元素读得到、它也没有选区：证据太弱，照弹（别吞掉真正的划词）', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'focused' }), { open: true, reason: 'weak' })
})

test('选区字段缺失/不是字符串时按「没有选区」算，不抛错', () => {
  assert.deepEqual(menuDecision({ source: 'point' }), { open: false, reason: 'no-selection' })
  assert.deepEqual(menuDecision({ selection: null, source: 'point' }), { open: false, reason: 'no-selection' })
  assert.deepEqual(menuDecision({}), { open: true, reason: 'weak' })
})

test('挑文字：按优先级取第一个非空来源（UIA 预读 → UIA 补读 → 剪贴板兜底）', () => {
  assert.deepEqual(
    pickSelection([
      { source: 'uia-prefetch', text: '' },
      { source: 'uia-fresh', text: '选中的文字' },
      { source: 'clipboard', text: '剪贴板里的' },
    ]),
    { text: '选中的文字', source: 'uia-fresh' },
  )
})

test('挑文字：正文原样返回，不做 trim（选区里的换行与缩进是用户的原文）', () => {
  assert.deepEqual(pickSelection([{ source: 'uia', text: '  a\n  b  ' }]), { text: '  a\n  b  ', source: 'uia' })
})

test('挑文字：一个可用来源都没有时返回 null（调用方据此显示「未能读取选中的文字」）', () => {
  assert.equal(pickSelection([]), null)
  assert.equal(pickSelection(undefined), null)
  assert.equal(pickSelection([{ source: 'uia', text: '   ' }, { source: 'clipboard', text: null }]), null)
})

test('挑文字：来源名缺失时兜成 unknown，不抛错', () => {
  assert.deepEqual(pickSelection([{ text: 'x' }]), { text: 'x', source: 'unknown' })
})
