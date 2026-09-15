/**
 * 划词的两条纯策略：**菜单该不该弹**、**这次到底用哪段文字**。
 *
 * 为什么单独拎出来：这两条判断决定了用户能不能呼出菜单、以及回答的是不是他选的那段，
 * 全是踩坑最多的地方——把它们从 main.mjs 的时序代码里拆成纯函数，才能用假数据钉住。
 * 这里不碰任何系统 API。
 */

/**
 * 菜单该不该弹。
 *
 * 背景：菜单必须在手势落下时**立刻**弹出来（老实现要先注入 Ctrl+C 读剪贴板，读不到就
 * 什么都不弹——DSH 桌面端那类窗口里注入不进去，菜单就永远呼不出来）。可一旦不再依赖
 * 剪贴板，就得自己回答老实现靠剪贴板回答的问题：**这一次拖拽/双击到底是不是在选文字**。
 * 用 UIA 的文本模式回答：
 *
 * - 读到选区里有文字 → 弹；
 * - 这一点上的元素带 TextPattern 却没有任何选区 → 确实没在选文字（拖窗口、拖滑块、
 *   双击图标…），**不弹**，否则「选中文字才弹菜单」就退化成「随便一拖都弹」；
 * - 什么都没读到（应用不暴露 UIA 文本、读超时）→ **不知道**，照弹：点菜单项时还有
 *   剪贴板兜底，跟老行为一致，不能因为读不到就吞掉用户这次划词。
 *
 * @param probe - UIA 探针结果（见 companion/native/uia.mjs 的 probe()）：
 *   `null` = 读不到；`{ selection, source }`，source 是 'point'（点上的元素）或 'focused'。
 * @returns `{ open, reason }`；reason 只用于诊断（/status 里能看到为什么没弹）。
 */
export function menuDecision(probe) {
  if (probe === null || probe === undefined) return { open: true, reason: 'unknown' }
  const selected = typeof probe.selection === 'string' ? probe.selection.trim() : ''
  if (selected !== '') return { open: true, reason: 'selection' }
  if (probe.source === 'point') return { open: false, reason: 'no-selection' }
  // 只有焦点元素读得到、而它也没有选区：证据太弱（也可能只是点在了外壳上），
  // 宁可弹出来让用户自己判断，也不要吞掉他真正想要的那次划词。
  return { open: true, reason: 'weak' }
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
