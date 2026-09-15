/**
 * 划词的两条纯策略：**菜单该不该弹**、**这次到底用哪段文字**。
 *
 * 为什么单独拎出来：这两条判断决定了用户能不能呼出菜单、以及回答的是不是他选的那段，
 * 全是踩坑最多的地方——把它们从 main.mjs 的时序代码里拆成纯函数，才能用假数据钉住。
 * 这里不碰任何系统 API。
 */

/** 折叠空白后的文字，用来比对"是不是同一段"。 */
function fold(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 菜单该不该弹。
 *
 * 背景：菜单必须在手势落下时**立刻**弹出来（老实现要先注入 Ctrl+C 读剪贴板，读不到就
 * 什么都不弹——DSH 桌面端那类窗口里注入不进去，菜单就永远呼不出来）。可一旦不再依赖
 * 剪贴板，就得自己回答老实现靠剪贴板回答的问题：**这一次拖拽/双击到底是不是在选文字**。
 * 用 UIA 的文本模式回答：
 *
 * - 没有选区（元素带 TextPattern 却报不出任何选区——点上的元素是这样，焦点元素也是
 *   这样）、或者手势落在桌面/任务栏这类不含可选文本的系统外壳上 → **不弹**：拖窗口、
 *   拖滑块、拖桌面、双击图标都不该弹；
 * - 读到选区、**这次手势碰到了它**（按下点或松开点落在选区矩形里，容差按行高算）→ 弹：
 *   这次手势选的就是它；
 * - 读到选区、手势没碰到，**但这段文字跟上一次菜单绑的那段不是同一段** → 弹：用户确实
 *   重新选了一段。几何判定会被 DPI、字符边界吸附、行距这些噪声带偏，所以文字不同就认；
 * - 读到选区、手势没碰到、文字也和上次菜单那段一模一样 → **不弹**：那是上一次划词留在
 *   应用里的旧选区，菜单已经为它弹过、也已经收起。少了这条，用户在菜单收起后随便一拖，
 *   探针照样读到那段旧文字，菜单就"再也甩不掉"。
 *
 * 只有"什么都没读到"（应用不暴露 UIA 文本、读超时）才算**不知道**，照弹：点菜单项时还有
 * 剪贴板兜底，跟老行为一致，不能因为读不到就吞掉用户这次划词。
 *
 * @param probe - UIA 探针结果（见 companion/native/uia.mjs 的 probe()）：
 *   `null` = 读不到；`{ selection, source, atGesture }`，source 是 'point'（点上的元素）、
 *   'focused' 或 'shell'；atGesture 是"这次手势碰没碰到这段选区"（null = 拿不到矩形）。
 * @param previous - **上一次菜单收起时绑的那段文字**（没有就传空串）：用来识别"手势没碰到、
 *   文字也没变"的旧选区。
 * @returns `{ open, reason }`；reason 只用于诊断（/status 里能看到为什么没弹）：
 *   selection（这次手势选出来的）/ stale-selection（上次留下的旧选区）/
 *   no-selection（确实没在选文字）/ shell（落在桌面/任务栏这类系统外壳上）/
 *   unknown（读不到，照弹）。
 */
export function menuDecision(probe, previous) {
  if (probe === null || probe === undefined) return { open: true, reason: 'unknown' }
  const selected = fold(probe.selection)
  if (selected === '') {
    // 手势落在桌面/任务栏这类系统外壳上：外壳不含可选文本，也是"确实没在选文字"。
    if (probe.source === 'shell') return { open: false, reason: 'shell' }
    return { open: false, reason: 'no-selection' }
  }
  // 1) 手势碰到了这段选区（按下点或松开点就在它附近）：这次手势选的就是它。
  if (probe.atGesture === true) return { open: true, reason: 'selection' }
  // 2) 没碰到，但文字跟上次菜单那段不一样：用户确实重新选了一段（几何判定不可轻信，见上）。
  const last = fold(previous)
  if (last === '' || selected !== last) return { open: true, reason: 'selection' }
  // 3) 同一段文字、手势也没碰到它：上一次划词留下的旧选区，菜单已经为它弹过一次了。
  return { open: false, reason: 'stale-selection' }
}

/**
 * 从几个来源里挑出这次要用的选区文字（按调用方给的优先级）。
 *
 * 优先级由调用方排：菜单弹出时的 UIA 预读 → 点菜单项时的 UIA 补读 → 剪贴板兜底。
 * 剪贴板放最后，是因为它要注入一次 Ctrl+C 并短暂接管用户的剪贴板——只在 UIA 真的
 * 读不到时才付这个代价。
 *
 * @param sources - `{ source, text }[]`（source 只用于诊断）。
 * @returns `{ text, source }`（text 保持原样，不做 trim——选区里的换行/缩进是用户的原文）；
 *   一个都没有时返回 null。
 */
export function pickSelection(sources) {
  for (const entry of Array.isArray(sources) ? sources : []) {
    const text = typeof entry?.text === 'string' ? entry.text : ''
    if (text.trim() === '') continue
    return { text, source: typeof entry?.source === 'string' ? entry.source : 'unknown' }
  }
  return null
}
