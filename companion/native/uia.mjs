/**
 * 用 UI Automation 读取"选区所在的段落"，作为解释/翻译的上下文。
 *
 * 为什么是 UIA：Windows 上要通用地拿到"选区周围那段话"，UIA 的 TextPattern 是
 * 唯一既不改动用户选区、也不注入任何按键的途径——它直接给出选区所在的文本范围，
 * 并且可以就地扩到"段落"。
 *
 * 这里全部是裸 COM：koffi 3.x 支持 koffi.call(函数指针, 原型, ...)，所以不需要
 * 任何需要编译的依赖，也不需要额外进程。
 *
 * 注意：下面所有 vtable 槽位序号来自 Windows SDK 的 UIAutomationClient.idl。
 * 槽位错一位就会把调用打到另一个函数上（通常直接崩进程），改之前先对 IDL。
 */
/** COM 初始化：UIA 客户端建议用 MTA（不需要消息泵，避免和本进程的 PeekMessage 抢占）。 */
const COINIT_MULTITHREADED = 0
/** CLSCTX_INPROC_SERVER */
const CLSCTX_INPROC_SERVER = 1

const UIA_TextPatternId = 10014
const UIA_ControlTypePropertyId = 30003
const UIA_ClassNamePropertyId = 30012

/** TextUnit 枚举：Paragraph 才是"知乎式"的上下文档位。 */
const TextUnit_Line = 3
const TextUnit_Paragraph = 4

/** 段落文本的上限：再长对模型也没用，反而挤压选区本身。 */
const MAX_CONTEXT_CHARS = 1500

const CLSID_CUIAutomation = [0xff48dba4, 0x60ef, 0x4201, [0xaa, 0x87, 0x54, 0x10, 0x3e, 0xef, 0x59, 0x4e]]
const IID_IUIAutomation = [0x30cbe57d, 0xd9d0, 0x452a, [0xab, 0x13, 0x7a, 0xc5, 0xac, 0x48, 0x25, 0xee]]
const IID_IUIAutomationTextPattern = [0x32eba289, 0x3583, 0x42c9, [0x9c, 0x59, 0x3b, 0x6d, 0x9a, 0x1e, 0x9b, 0x6a]]

/** vtable 槽位（IUnknown 占 0/1/2，所以业务方法从 3 开始）。 */
const SLOT = {
  release: 2,
  // IUIAutomation
  elementFromPoint: 7,
  focusedElement: 8,
  // IUIAutomationElement
  getCurrentPatternAs: 14,
  // IUIAutomation（控制视图遍历器：拿父元素）
  controlViewWalker: 14,
  // IUIAutomationTreeWalker
  parentElement: 3,
  getCurrentPropertyValue: 10,
  // IUIAutomationTextPattern
  getSelection: 5,
  // IUIAutomationTextRangeArray
  rangeArrayLength: 3,
  rangeArrayGetElement: 4,
  // IUIAutomationTextRange
  clone: 3,
  expandToEnclosingUnit: 6,
  getText: 12,
}

/** koffi 类型是全局的：重复定义同名类型会抛 Duplicate type name，所以只建一次。 */
let cached = null

function bindings(koffi) {
  if (cached !== null) return cached
  const GUID = koffi.struct('DST_UIA_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8 [8]' })
  const POINT = koffi.struct('DST_UIA_POINT', { x: 'int32', y: 'int32' })
  // VARIANT 在 x64 上固定 24 字节：vt + 3 个保留字 + 16 字节数据。这里当裸字节读，避免
  // 和 koffi 的 VARIANT 语义纠缠（我们只需要 BSTR 与 I4 两种）。
  const VARIANT = koffi.struct('DST_UIA_VARIANT', { raw: 'uint8 [24]' })
  cached = {
    koffi,
    GUID,
    POINT,
    VARIANT,
    ole32: koffi.load('ole32.dll'),
    oleaut32: koffi.load('oleaut32.dll'),
    proto: {
      elementFromPoint: koffi.proto('int __stdcall DstUiaElementFromPoint(void *self, DST_UIA_POINT pt, _Out_ void **element)'),
      focusedElement: koffi.proto('int __stdcall DstUiaFocusedElement(void *self, _Out_ void **element)'),
      getCurrentPatternAs: koffi.proto('int __stdcall DstUiaGetPatternAs(void *self, int patternId, DST_UIA_GUID *iid, _Out_ void **pattern)'),
      getCurrentPropertyValue: koffi.proto('int __stdcall DstUiaGetPropertyValue(void *self, int propertyId, _Out_ DST_UIA_VARIANT *value)'),
      getSelection: koffi.proto('int __stdcall DstUiaGetSelection(void *self, _Out_ void **ranges)'),
      rangeArrayLength: koffi.proto('int __stdcall DstUiaRangeArrayLength(void *self, _Out_ int *length)'),
      rangeArrayGetElement: koffi.proto('int __stdcall DstUiaRangeArrayGetElement(void *self, int index, _Out_ void **range)'),
      clone: koffi.proto('int __stdcall DstUiaRangeClone(void *self, _Out_ void **range)'),
      expand: koffi.proto('int __stdcall DstUiaRangeExpand(void *self, int unit)'),
      getText: koffi.proto('int __stdcall DstUiaRangeGetText(void *self, int maxLength, _Out_ void **text)'),
      release: koffi.proto('uint32 __stdcall DstUiaRelease(void *self)'),
      parentElement: koffi.proto('int __stdcall DstUiaWalkerParent(void *self, void *element, _Out_ void **parent)'),
      getControlViewWalker: koffi.proto('int __stdcall DstUiaGetWalker(void *self, _Out_ void **walker)'),
    },
  }
  cached.coInitializeEx = cached.ole32.func('int __stdcall CoInitializeEx(void *reserved, uint32_t coinit)')
  cached.coCreateInstance = cached.ole32.func('int __stdcall CoCreateInstance(DST_UIA_GUID *clsid, void *outer, uint32_t ctx, DST_UIA_GUID *iid, _Out_ void **out)')
  cached.sysFreeString = cached.oleaut32.func('void __stdcall SysFreeString(void *bstr)')
  return cached
}

/** 把一个 8 位数组拼成小端整数（读 VARIANT 时用）。 */
function leNumber(bytes, offset, length) {
  let value = 0
  for (let i = length - 1; i >= 0; i--) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

/** GUID 数组 → koffi 结构体。 */
function guidOf(b, parts) {
  return { Data1: parts[0], Data2: parts[1], Data3: parts[2], Data4: parts[3] }
}

/** 取接口的 vtable 槽位函数指针。 */
function slot(b, iface, index) {
  const vtable = b.koffi.decode(iface, 'void *')
  return b.koffi.decode(vtable, index * 8, 'void *')
}

/** 调一个 COM 方法（自动补 self）。 */
function invoke(b, iface, index, proto, ...args) {
  return b.koffi.call(slot(b, iface, index), proto, iface, ...args)
}

/** 归一化：折叠空白 + 去掉零宽字符，用于比对 UIA 选区与剪贴板选区是否同一段。 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** UIA 的选区文本和剪贴板文本是否指向同一处（UIA 会丢空格/换行，故用包含关系兜底）。 */
function sameSelection(a, b) {
  const left = normalizeText(a)
  const right = normalizeText(b)
  if (left === '' || right === '') return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= 2 && longer.includes(shorter)
}

/**
 * 建立 UIA 读取器。
 * @param koffi - 已解析到的 koffi 模块。
 * @returns reader（读取失败返回 null 的那套语义见 read()）。
 */
export function createUiaReader(koffi) {
  const b = bindings(koffi)
  const created = b.coInitializeEx(null, COINIT_MULTITHREADED)
  // S_OK(0) / S_FALSE(1) 都算成功；RPC_E_CHANGED_MODE(0x80010106) 说明线程已在别的套间里，照样可用。
  const comOk = created === 0 || created === 1 || created === -2147417850
  if (!comOk) throw new Error('CoInitializeEx failed: 0x' + (created >>> 0).toString(16))

  const automation = [null]
  const hr = b.coCreateInstance(guidOf(b, CLSID_CUIAutomation), null, CLSCTX_INPROC_SERVER, guidOf(b, IID_IUIAutomation), automation)
  if (hr !== 0 || automation[0] === null) throw new Error('CoCreateInstance(CUIAutomation) failed: 0x' + (hr >>> 0).toString(16))
  const root = automation[0]

  /** 释放接口指针（失败不影响结果）。 */
  const release = (iface) => {
    if (iface === null || iface === undefined) return
    try {
      b.koffi.call(slot(b, iface, SLOT.release), b.proto.release, iface)
    } catch {
      /* 释放失败忽略 */
    }
  }

  /**
   * 读 BSTR。
   *
   * 不走 `koffi.decode(ptr, 'const char16_t *')`：koffi 3.2 上这条路径会直接把进程
   * 打成 ACCESS_VIOLATION（踩过，实测崩溃）。稳定做法是先读 BSTR 头部的 4 字节字节
   * 长度（指针前 4 字节），再按 `char16_t` 数组解出来。
   */
  const readBstr = (pointer) => {
    if (pointer === null || pointer === undefined) return ''
    const base = BigInt(pointer)
    const bytes = b.koffi.decode(base - 4n, 'int32')
    const count = Math.max(0, Math.min(Math.floor((Number(bytes) || 0) / 2), 1 << 20))
    if (count === 0) return ''
    return Array.from(b.koffi.decode(base, 'char16_t', count)).join('')
  }

  /** 读 BSTR 出参并释放（读不到返回 ''）。 */
  const takeBstr = (out) => {
    const pointer = out[0]
    if (pointer === null || pointer === undefined) return ''
    try {
      return readBstr(pointer)
    } finally {
      b.sysFreeString(BigInt(pointer))
      out[0] = null
    }
  }

  /** 元素属性（字符串属性返回 ''，枚举属性返回数字）。 */
  const property = (element, propertyId) => {
    const out = [null]
    try {
      if (invoke(b, element, SLOT.getCurrentPropertyValue, b.proto.getCurrentPropertyValue, propertyId, out) !== 0) return ''
      const variant = out[0]
      if (variant === null || variant === undefined) return ''
      const bytes = variant.raw ?? []
      const vt = leNumber(bytes, 0, 2)
      if (vt === 8) {
        // VT_BSTR：数据区前 8 字节是指针
        let pointer = 0n
        for (let i = 7; i >= 0; i--) pointer = pointer * 256n + BigInt(bytes[8 + i] ?? 0)
        if (pointer === 0n) return ''
        const text = readBstr(pointer)
        b.sysFreeString(pointer)
        return text
      }
      if (vt === 3) return leNumber(bytes, 8, 4)
      if (vt === 11) return leNumber(bytes, 8, 2) !== 0
      return ''
    } catch {
      return ''
    }
  }

  /** 取某个元素上的 TextPattern（不支持返回 null）。 */
  const textPattern = (element) => {
    if (element === null || element === undefined) return null
    const out = [null]
    const iid = guidOf(b, IID_IUIAutomationTextPattern)
    if (invoke(b, element, SLOT.getCurrentPatternAs, b.proto.getCurrentPatternAs, UIA_TextPatternId, iid, out) !== 0) return null
    return out[0]
  }

  /** 控制视图遍历器（懒建；拿不到返回 null）。 */
  let walkerCache = null
  const controlWalker = () => {
    if (walkerCache !== null) return walkerCache
    const out = [null]
    if (invoke(b, root, SLOT.controlViewWalker, b.proto.getControlViewWalker, out) !== 0) return null
    walkerCache = out[0]
    return walkerCache
  }

  /** 父元素（拿不到返回 null）。 */
  const parentOf = (element) => {
    const walker = controlWalker()
    if (walker === null) return null
    const out = [null]
    if (invoke(b, walker, SLOT.parentElement, b.proto.parentElement, element, out) !== 0) return null
    return out[0]
  }

  /** 焦点元素（拿不到返回 null）。 */
  const focusedElement = () => {
    const out = [null]
    if (invoke(b, root, SLOT.focusedElement, b.proto.focusedElement, out) !== 0) return null
    return out[0]
  }

  /** 点上的元素（只做 ElementFromPoint，不要兜底：兜底由 candidates 统一处理）。 */
  const elementAt = (point) => {
    const out = [null]
    const pt = { x: Math.round(point.x), y: Math.round(point.y) }
    if (invoke(b, root, SLOT.elementFromPoint, b.proto.elementFromPoint, pt, out) === 0 && out[0] !== null) return out[0]
    return null
  }

  /**
   * 候选元素列表：点上的元素 → 逐级祖先 → 焦点元素 → 逐级祖先。
   *
   * 为什么不能只看"点上的元素"：浏览器里点上拿到的常常是外壳（Chrome_WidgetWin_1），
   * TextPattern 挂在文档/文本控件上；反过来也有（点上是很细的文本叶子）。
   * 逐级向上找是成本最低、覆盖最广的做法。
   * @returns 都是**新引用**，调用方负责 release。
   */
  const candidates = (point) => {
    const list = []
    const push = (start) => {
      let node = start
      for (let level = 0; node !== null && level < 5; level++) {
        list.push(node)
        node = parentOf(node)
      }
    }
    const at = elementAt(point)
    if (at !== null) push(at)
    const focused = focusedElement()
    if (focused !== null) push(focused)
    return list
  }

  /** 元素可读文本（选区 + 段落）。 */
  const rangesFor = (pattern) => {
    const out = [null]
    if (invoke(b, pattern, SLOT.getSelection, b.proto.getSelection, out) !== 0) return null
    const array = out[0]
    if (array === null || array === undefined) return null
    const length = [0]
    let count = 0
    if (invoke(b, array, SLOT.rangeArrayLength, b.proto.rangeArrayLength, length) === 0) count = length[0]
    const ranges = []
    for (let i = 0; i < count; i++) {
      const element = [null]
      if (invoke(b, array, SLOT.rangeArrayGetElement, b.proto.rangeArrayGetElement, i, element) === 0 && element[0] !== null) ranges.push(element[0])
    }
    release(array)
    return { ranges, count }
  }

  /** 范围文本。 */
  const rangeText = (range) => {
    const out = [null]
    if (invoke(b, range, SLOT.getText, b.proto.getText, -1, out) !== 0) return ''
    return takeBstr(out)
  }

  /**
   * 从"某个元素上的选区范围"得到上下文段落。
   * @returns \`{ unit, text, selection, className }\` 或 null（这个元素不适合）。
   */
  const contextFrom = (element, current, selected, cleanup) => {
    // Clone 之后就地扩到段落：Clone 是为了不破坏原始选区范围对象（UIA 的范围是可变对象）
    for (const unit of [TextUnit_Paragraph, TextUnit_Line]) {
      const out = [null]
      if (invoke(b, current, SLOT.clone, b.proto.clone, out) !== 0 || out[0] === null) continue
      const expanded = out[0]
      cleanup.push(expanded)
      if (invoke(b, expanded, SLOT.expandToEnclosingUnit, b.proto.expand, unit) !== 0) continue
      const text = rangeText(expanded)
      if (text === '') continue
      const trimmed = text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS) : text
      // 段落就是选区本身（没有额外上下文）时，退到行；行也一样就放弃这个元素
      if (normalizeText(trimmed) === normalizeText(selected)) continue
      return {
        unit: unit === TextUnit_Paragraph ? 'paragraph' : 'line',
        text: trimmed,
        selection: selected,
        className: String(property(element, UIA_ClassNamePropertyId) || ''),
      }
    }
    return null
  }

  /**
   * 读取选区所在的上下文段落。
   * @param point - 屏幕坐标（取词手势落点，物理像素）。
   * @param expected - 剪贴板里拿到的选中文本（用于校验 UIA 的选区没串台）。
   * @returns \`{ unit, text, selection, className }\`；读不到或校验不过返回 null。
   */
  const read = (point, expected) => {
    const cleanup = []
    try {
      let seen = 0
      for (const element of candidates(point)) {
        seen += 1
        cleanup.push(element)
        const pattern = textPattern(element)
        if (pattern === null) continue
        cleanup.push(pattern)
        const selection = rangesFor(pattern)
        if (selection === null || selection.ranges.length === 0) continue
        cleanup.push(...selection.ranges)
        const current = selection.ranges[0]
        const selected = rangeText(current)
        if (expected !== undefined && expected !== null && !sameSelection(selected, expected)) continue
        const found = contextFrom(element, current, selected, cleanup)
        if (found !== null) return { ...found, candidates: seen }
      }
      return null
    } finally {
      for (const iface of cleanup.reverse()) release(iface)
    }
  }

  return {
    read,
    /** 诊断：这个点上能不能读文本、读到什么（验收脚本用）。 */
    diagnose(point) {
      const report = { point, className: '', controlType: null, textPattern: false, selection: '', paragraph: '', error: '', candidates: 0, tried: 0 }
      let element = null
      let pattern = null
      const cleanup = []
      try {
        const list = candidates(point)
        report.candidates = list.length
        // 沿候选链找第一个带 TextPattern 的元素（浏览器等应用的点上元素往往只是外壳）
        for (const candidate of list) {
          report.tried += 1
          cleanup.push(candidate)
          const found = textPattern(candidate)
          if (found === null) continue
          element = candidate
          pattern = found
          break
        }
        if (element === null) {
          report.error = 'no element with text pattern'
          return report
        }
        report.className = String(property(element, UIA_ClassNamePropertyId) || '')
        report.controlType = property(element, UIA_ControlTypePropertyId)
        cleanup.push(pattern)
        report.textPattern = true
        const selection = rangesFor(pattern)
        if (selection === null || selection.ranges.length === 0) {
          report.error = 'no selection range'
          return report
        }
        cleanup.push(...selection.ranges)
        report.selection = rangeText(selection.ranges[0])
        const out = [null]
        if (invoke(b, selection.ranges[0], SLOT.clone, b.proto.clone, out) === 0 && out[0] !== null) {
          cleanup.push(out[0])
          if (invoke(b, out[0], SLOT.expandToEnclosingUnit, b.proto.expand, TextUnit_Paragraph) === 0) {
            report.paragraph = rangeText(out[0])
          }
        }
        return report
      } catch (error) {
        report.error = error instanceof Error ? error.message : String(error)
        return report
      } finally {
        for (const iface of cleanup.reverse()) release(iface)
      }
    },
    release: () => release(root),
  }
}