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
import { pointNearRects } from '../companion/native/uia.mjs'

test('手势落在桌面/任务栏这类系统外壳上：外壳不含可选文本，不弹', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'shell' }), { open: false, reason: 'shell' })
  assert.deepEqual(menuDecision({ selection: '  ', source: 'shell' }), { open: false, reason: 'shell' })
})

test('读不到 UIA 文本时照弹：不知道用户选没选，点菜单项还有剪贴板兜底（唯一照弹的未知情形）', () => {
  assert.deepEqual(menuDecision(null), { open: true, reason: 'unknown' })
  assert.deepEqual(menuDecision(undefined), { open: true, reason: 'unknown' })
})

test('这次手势碰到了这段选区（按下点/松开点在选区里）：弹——这次手势选的就是它', () => {
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: true }), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision({ selection: '  hi ', source: 'focused', atGesture: true }), { open: true, reason: 'selection' })
})

test('几何判定没命中，但文字跟上次菜单那段不一样：照弹（真划词不能被 DPI/字符吸附的噪声杀掉）', () => {
  // 实测踩过：150% 缩放下一个字 15–30px，从右往左拖时锚点吸附到字形边界，
  // 按下点会落在选区矩形外一点点——用户看到的就是"经常弹不出来"。
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: false }, '别的文字'), { open: true, reason: 'selection' })
  assert.deepEqual(menuDecision({ selection: 'Go', source: 'focused', atGesture: null }, '别的文字'), { open: true, reason: 'selection' })
  // 第一次划词（还没有"上次菜单那段"）：也认。
  assert.deepEqual(menuDecision({ selection: 'Go', source: 'focused', atGesture: false }, ''), { open: true, reason: 'selection' })
})

test('同一段文字 + 手势没碰到它：这是上次留下的旧选区，菜单已经为它弹过，不再弹', () => {
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'focused', atGesture: false }, 'Go 调度器'), { open: false, reason: 'stale-selection' })
  assert.deepEqual(menuDecision({ selection: 'Go 调度器', source: 'point', atGesture: false }, ' Go  调度器 '), { open: false, reason: 'stale-selection' })
})

test('点上元素带 TextPattern 却没有选区：这是「没在选文字」，不弹（拖窗口/拖滑块/双击图标都不该弹）', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'point' }), { open: false, reason: 'no-selection' })
  assert.deepEqual(menuDecision({ selection: '   ', source: 'point' }), { open: false, reason: 'no-selection' })
})

test('焦点元素带 TextPattern 却报不出选区：确实没在选文字，不弹（拖桌面、拖窗口都不该弹）', () => {
  assert.deepEqual(menuDecision({ selection: '', source: 'focused' }), { open: false, reason: 'no-selection' })
})

test('选区字段缺失/不是字符串时按「没有选区」算，不抛错', () => {
  assert.deepEqual(menuDecision({ source: 'point' }), { open: false, reason: 'no-selection' })
  assert.deepEqual(menuDecision({ selection: null, source: 'point' }), { open: false, reason: 'no-selection' })
  assert.deepEqual(menuDecision({}), { open: false, reason: 'no-selection' })
})

test('几何判定：点在选区矩形里就算碰到；不在里面要看余量', () => {
  const rects = [{ left: 100, top: 200, right: 400, bottom: 236 }]
  assert.equal(pointNearRects({ x: 250, y: 218 }, rects), true, '正中')
  assert.equal(pointNearRects({ x: 250, y: 250 }, rects), true, '下沿外 14px，仍在余量内')
  assert.equal(pointNearRects({ x: 250, y: 400 }, rects), false, '隔了 164px，不算碰到')
  assert.equal(pointNearRects({ x: 250, y: 218 }, []), false)
  assert.equal(pointNearRects({ x: 250, y: 218 }, null), false)
})

test('几何判定：余量按行高缩放（150% 下一个字 15–30px，写死 8px 会误杀正常划词）', () => {
  const tall = [{ left: 0, top: 0, right: 100, bottom: 60 }]
  const short = [{ left: 0, top: 0, right: 100, bottom: 12 }]
  assert.equal(pointNearRects({ x: -50, y: 30 }, tall), true, '60px 的行高给 60px 余量')
  assert.equal(pointNearRects({ x: -50, y: 6 }, short), false, '12px 的行高只给 12px 余量')
  assert.equal(pointNearRects({ x: -5, y: 6 }, short), true, '8px 兜底')
})

test('几何判定：矩形只有 left/top/right/bottom，没有 height 字段（踩过：读 height 得到 NaN，判定恒 false，菜单怎么划都不弹）', () => {
  const rect = { left: 100, top: 200, right: 400, bottom: 236 }
  assert.equal('height' in rect, false, 'UIA 矩形本来就没有 height')
  assert.equal(pointNearRects({ x: 250, y: 218 }, [rect]), true)
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
