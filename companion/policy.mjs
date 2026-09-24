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
 * - 手势落在桌面/任务栏这类不含可选文本的系统外壳上 → **不弹**。普通元素带 TextPattern
 *   却报不出选区时不能直接下结论：WPS 可能只命中功能区控件，交给剪贴板确认；拖窗口、
 *   拖滑块、拖桌面、双击图标最终仍因复制不到文字而不弹；
 * - **按下时读到的就是这一段、松开时还是它** → **不弹**（`unchanged-selection`）：这次手势
 *   压根没改动选区，也就没"选出"任何东西。办公套件里最典型：WPS/Office 的 PPT 里选中一个
 *   形状/文本框再拖动它、Excel 里拖一个已选中的单元格/图表，UIA 一路都报着"这个对象被选中"
 *   ——拖之前是它、拖之后还是它；菜单要是只看松开那一刻读到的选区，就会在用户**移动元素**
 *   时冒出来（用户报的就是这条）。判据是按下那一刻拍的那张快照（`pressProbe`，见
 *   companion/main.mjs 的 startPressProbe）；
 * - 读到选区、**这次手势碰到了它**（按下点或松开点落在选区矩形里，容差按行高算）→ 弹：
 *   这次手势选的就是它；
 * - 双击读到选区、但没有确认命中该选区 → **不弹**：不能拿附近或旧的选区当成本次选词；
 * - 拖选读到选区、手势没碰到，**但这段文字跟上一次菜单绑的那段不是同一段** → 弹：用户确实
 *   重新选了一段。几何判定会被 DPI、字符边界吸附、行距这些噪声带偏，所以文字不同就认；
 * - 读到选区、手势没碰到、文字也和上次菜单那段一模一样 → **不弹**：那是上一次划词留在
 *   应用里的旧选区，菜单已经为它弹过、也已经收起。少了这条，用户在菜单收起后随便一拖，
 *   探针照样读到那段旧文字，菜单就"再也甩不掉"。
 *
 * 只有"什么都没读到"（应用不暴露 UIA 文本、读超时），或者普通 UIA 文本控件没有选区，
 * 才算**判不了**，这种情况一律返回 `open: null`，由调用方核实（见 companion/main.mjs
 * 的 confirmByClipboard）：
 *
 * - **办公套件（WPS/Office 的 Qt 版）就是这一类**：整个窗口树里没有文档的 TextPattern
 *   （实测 WPS PPT 的 UIA 树 376 个节点里只有两个功能区长条是文本控件），UIA 对"选没选中
 *   文字"完全无话可说。核实办法是**剪贴板**：注入一次 Ctrl+C——真的选中文字就会复制出文字，
 *   拖动一个形状/窗口则什么文字都没有（这一路带着 selection.mjs 里那几条安全规则）；
 * - 核不出结论（终端窗口、用户此刻正按着 Ctrl+C、注入拿不到文字）时退回
 *   {@link unknownFallback}：拖选照弹（老的兼容行为）、双击不弹；
 * - 拿不到任何结论又不想碰剪贴板，用 `DSH_SELECTION_CONFIRM=0` 关掉核实，等价于退回老行为。
 *
 * @param probe - UIA 探针结果（见 companion/native/uia.mjs 的 probe()）：
 *   `null` = 读不到；`{ selection, source, atGesture }`，source 是 'point'（点上的元素）、
 *   'focused' 或 'shell'；atGesture 是"这次手势碰没碰到这段选区"（null = 拿不到矩形）。
 * @param previous - **上一次菜单收起时绑的那段文字**（没有就传空串）：用来识别"手势没碰到、
 *   文字也没变"的旧选区。
 * @param options.kind - 这一次是哪种手势（'drag' / 'double'）。只在"判不了"时才用得上
 *   （见 {@link unknownFallback}）；缺省按拖选算。
 * @param options.pressProbe - **按下那一刻**读到的选区（见 companion/main.mjs 的
 *   startPressProbe）：用来识别"这次手势没有选出新东西"。拿不到（没拍到 / 拍得太慢）就传
 *   null——那只是少一条判据，别的分支一点不受影响。
 * @param options.reason - 探针**读不到**时（probe 为 null）要报的理由，缺省 'unknown'；
 *   等满两级预算也没等到结论的那一档传 'timeout'（/status 靠它区分"探针慢"和"探针不可读"）。
 * @returns `{ open, reason }`；open 是 true（弹）/ false（不弹）/**null（UIA 判不了，去核实）**。
 *   reason 只用于诊断（/status 里能看到为什么没弹）：
 *   selection（这次手势选出来的）/ unchanged-selection（这次手势没改动选区，多半在拖动一个
 *   已选中的元素）/ stale-selection（上次留下的旧选区）/ double-not-at-gesture（双击，读到的
 *   选区不在这次手势上）/ shell（落在桌面/任务栏这类系统外壳上）/
 *   unknown 或 timeout（UIA 判不了，open=null，交给剪贴板核实）/ clipboard（剪贴板核实到
 *   "真复制出了文字"）/ unconfirmed（核实过，没复制出文字 → 不弹）/
 *   double-unverified（双击且核不出结论，不弹）。
 */
export function menuDecision(probe, previous, options = {}) {
  if (probe === null || probe === undefined) {
    // UIA 说不出话来：**不表态**。调用方会用剪贴板核实一次（open 为 null 就是"待核实"）。
    return { open: null, reason: options.reason ?? 'unknown' }
  }
  const selected = fold(probe.selection)
  if (selected === '') {
    // 手势落在桌面/任务栏这类系统外壳上：外壳不含可选文本，也是"确实没在选文字"。
    if (probe.source === 'shell') return { open: false, reason: 'shell' }
    // 普通元素带 TextPattern 却报不出选区：**不能**就此认定"没在选文字"——WPS/Office
    // 的探针可能只命中一个跟文档无关的文本控件（比如功能区），那里本来就没有选区。
    // 这一档同样**不表态**，交给剪贴板核实去区分"真选中了文字"和"在拖对象/窗口"。
    return { open: null, reason: 'unknown' }
  }
  // 0) 按下时就是这一段、松开时还是它：这次手势没改动选区——用户多半在**拖动一个已经
  //    选中的元素**（WPS/Office 的 PPT 形状、文本框，Excel 的单元格/图表），而不是在选
  //    文字。这一条必须排在"手势碰到选区"前面：移动元素时按下点与松开点当然都落在元素里。
  const before = fold(options.pressProbe?.selection)
  if (before !== '' && before === selected) return { open: false, reason: 'unchanged-selection' }
  // 1) 手势碰到了这段选区（按下点或松开点就在它附近）：这次手势选的就是它。
  if (probe.atGesture === true) return { open: true, reason: 'selection' }
  // 双击没有拖选的字符边界吸附问题：读到文字但没有命中选区，不足以证明这次选了词。
  // 必须在文字差异兜底之前拒绝，否则旧选区与上次菜单文本不同就会在空白处误弹。
  if (options.kind === 'double') return { open: false, reason: 'double-not-at-gesture' }
  // 2) 拖选没碰到，但文字跟上次菜单那段不一样：保留拖选的几何容差兜底。
  const last = fold(previous)
  if (last === '' || selected !== last) return { open: true, reason: 'selection' }
  // 3) 同一段文字、手势也没碰到它：上一次划词留下的旧选区，菜单已经为它弹过一次了。
  return { open: false, reason: 'stale-selection' }
}

/**
 * UIA 判不了（`open: null`）、剪贴板也核不出结论时的兜底——即**改动前**的老行为：
 * 拖选照弹（UIA 读不到文字的窗口里拖拽照样能选出文字，不能因为读不到就吞掉这次划词），
 * 双击不弹（读不到任何文本元素的双击，多半是在双击图标/列表项/画布）。
 *
 * 只在"核实跑不起来"时用：终端窗口（Ctrl+C 在那里是中断）、用户此刻正按着 Ctrl+C、
 * 或者显式关掉了核实（`DSH_SELECTION_CONFIRM=0`）。
 *
 * @param kind - 手势种类（'drag' / 'double'）。
 * @returns `{ open, reason }`。
 */
export function unknownFallback(kind) {
  return kind === 'double' ? { open: false, reason: 'double-unverified' } : { open: true, reason: 'unknown' }
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
