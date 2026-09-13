/**
 * 全局"划词手势"状态机（纯函数式，不碰任何系统 API，便于单测）。
 *
 * 输入是一串鼠标采样（左键按下与否 + 光标位置 + 时间），输出是两种手势：
 * - \`drag\`：按下后移动超过阈值再松开（拖选）；
 * - \`double\`：两次间隔很短、位置几乎相同的点击（双击选词）。
 *
 * 采样由调用方（companion/main.mjs）以固定频率喂进来，因此这里完全不依赖
 * 钩子/回调，测试可以直接喂一串假采样。
 */

/** 默认阈值。 */
export const GESTURE_DEFAULTS = {
  /** 拖选判定：按下到松开之间的最大位移（像素）。 */
  dragMinDistance: 5,
  /** 双击判定：两次点击的最大间隔（毫秒）。 */
  doubleClickMs: 420,
  /** 双击判定：两次点击的最大位移（像素）。 */
  doubleClickSlop: 6,
}

/**
 * 创建手势检测器。
 * @param options - 阈值覆盖 + \`onGesture\` 回调。
 * @returns \`{ push }\`。
 */
export function createGestureDetector(options = {}) {
  const config = { ...GESTURE_DEFAULTS, ...options }
  const onGesture = options.onGesture ?? (() => {})

  let pressed = false
  let downX = 0
  let downY = 0
  let moved = 0
  let lastUpX = 0
  let lastUpY = 0
  let lastUpTime = Number.NEGATIVE_INFINITY
  let awaitingSecondClick = false

  /**
   * 喂一个采样。
   * @param sample - \`{ down, x, y, time }\`（time 为毫秒时间戳）。
   */
  function push(sample) {
    const { down, x, y, time } = sample
    if (down) {
      if (!pressed) {
        pressed = true
        downX = x
        downY = y
        moved = 0
        awaitingSecondClick =
          time - lastUpTime <= config.doubleClickMs &&
          Math.hypot(x - lastUpX, y - lastUpY) <= config.doubleClickSlop
      } else {
        moved = Math.max(moved, Math.hypot(x - downX, y - downY))
      }
      return
    }
    if (!pressed) return
    pressed = false
    const distance = Math.max(moved, Math.hypot(x - downX, y - downY))
    const at = { x, y, time }
    if (distance >= config.dragMinDistance) {
      awaitingSecondClick = false
      onGesture({ kind: 'drag', distance, ...at })
    } else if (awaitingSecondClick) {
      awaitingSecondClick = false
      onGesture({ kind: 'double', distance, ...at })
    }
    lastUpX = x
    lastUpY = y
    lastUpTime = time
  }

  return { push }
}

/** 点是否落在矩形内（用于忽略落在浮层自己身上的点击）。 */
export function pointInRect(point, rect) {
  if (rect === null || rect === undefined) return false
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}
