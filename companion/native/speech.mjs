/**
 * 朗读（Windows SAPI，进程内 COM，不起额外进程）。
 *
 * 用 ISpVoice：\`Speak(text, SPF_ASYNC|SPF_PURGEBEFORESPEAK)\` 异步朗读，
 * \`WaitUntilDone(0)\` 轮询是否还在读（S_OK=读完了，S_FALSE=还在读），
 * 再次点击时就 \`Speak('', SPF_PURGEBEFORESPEAK)\` 打断。
 *
 * vtable 槽位按 sapi.idl 的继承顺序数：IUnknown 0-2 → ISpNotifySource 3-9 →
 * ISpEventSource 10-12 → ISpVoice 从 13 起（Speak=20、SetRate=28、SetVolume=30、
 * WaitUntilDone=32）。槽位错一位就会崩进程，改之前先对 IDL。
 */
const CLSCTX_ALL = 0x17
const COINIT_APARTMENTTHREADED = 2

const CLSID_SpVoice = [0x96749377, 0x3391, 0x11d2, [0x9e, 0xe3, 0x00, 0xc0, 0x4f, 0x79, 0x73, 0x96]]
const IID_ISpVoice = [0x6c44df74, 0x72b9, 0x4992, [0xa1, 0xec, 0xef, 0x99, 0x6e, 0x04, 0x22, 0xd4]]

/** ISpVoice vtable 槽位。 */
const SLOT = {
  release: 2,
  speak: 20,
  setRate: 28,
  setVolume: 30,
  waitUntilDone: 32,
}

/** SPF_ASYNC | SPF_PURGEBEFORESPEAK */
const SPEAK_ASYNC = 0x1
const SPEAK_PURGE = 0x2

/** koffi 类型是全局的：只建一次。 */
let cached = null

function bindings(koffi) {
  if (cached !== null) return cached
  const GUID = koffi.struct('DST_SP_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8 [8]' })
  const ole32 = koffi.load('ole32.dll')
  cached = {
    koffi,
    GUID,
    ole32,
    proto: {
      speak: koffi.proto('int __stdcall DstSpSpeak(void *self, const char16_t *text, uint32_t flags, _Out_ uint32_t *stream)'),
      setRate: koffi.proto('int __stdcall DstSpSetRate(void *self, int rate)'),
      setVolume: koffi.proto('int __stdcall DstSpSetVolume(void *self, uint16_t volume)'),
      waitUntilDone: koffi.proto('int __stdcall DstSpWaitUntilDone(void *self, uint32_t ms)'),
      release: koffi.proto('uint32 __stdcall DstSpRelease(void *self)'),
    },
  }
  cached.coInitializeEx = ole32.func('int __stdcall CoInitializeEx(void *reserved, uint32_t coinit)')
  cached.coCreateInstance = ole32.func('int __stdcall CoCreateInstance(DST_SP_GUID *clsid, void *outer, uint32_t ctx, DST_SP_GUID *iid, _Out_ void **out)')
  return cached
}

/** GUID 数组 → koffi 结构体。 */
function guidOf(parts) {
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

/**
 * 建立朗读器（懒建 COM 对象：不用就不初始化）。
 * @param koffi - 已解析到的 koffi 模块。
 * @returns \`{ speak, stop, isSpeaking, available, dispose }\`；COM 不可用时 available=false。
 */
export function createSpeaker(koffi) {
  const b = bindings(koffi)
  const created = b.coInitializeEx(null, COINIT_APARTMENTTHREADED)
  if (created !== 0 && created !== 1 && created !== -2147417850) return null
  let voice = null
  let failed = false

  /** 懒建 ISpVoice。 */
  const ensure = () => {
    if (voice !== null || failed) return voice
    const out = [null]
    const hr = b.coCreateInstance(guidOf(CLSID_SpVoice), null, CLSCTX_ALL, guidOf(IID_ISpVoice), out)
    if (hr !== 0 || out[0] === null) {
      failed = true
      return null
    }
    voice = out[0]
    return voice
  }

  return {
    /** 朗读一段文本（会打断上一次）。 */
    speak(text) {
      const voice = ensure()
      if (voice === null) return false
      const content = String(text ?? '').trim()
      if (content === '') return false
      const stream = [0]
      // 先清空当前队列再说话（连点两次 = 重新读）
      const hr = invoke(b, voice, SLOT.speak, b.proto.speak, content, SPEAK_ASYNC | SPEAK_PURGE, stream)
      return hr === 0
    },
    /** 立刻停下。 */
    stop() {
      const voice = ensure()
      if (voice === null) return
      const stream = [0]
      invoke(b, voice, SLOT.speak, b.proto.speak, '', SPEAK_PURGE, stream)
    },
    /** 是否还在读（S_FALSE=1 表示还在读）。 */
    isSpeaking() {
      if (voice === null) return false
      try {
        return invoke(b, voice, SLOT.waitUntilDone, b.proto.waitUntilDone, 0) === 1
      } catch {
        return false
      }
    },
    /** 语速（-10..10，0 为默认）。 */
    setRate(rate) {
      const voice = ensure()
      if (voice === null) return false
      return invoke(b, voice, SLOT.setRate, b.proto.setRate, Math.max(-10, Math.min(10, Math.round(rate)))) === 0
    },
    /** 音量（0..100）。 */
    setVolume(volume) {
      const voice = ensure()
      if (voice === null) return false
      return invoke(b, voice, SLOT.setVolume, b.proto.setVolume, Math.max(0, Math.min(100, Math.round(volume)))) === 0
    },
    available: () => ensure() !== null,
    dispose() {
      if (voice === null) return
      const dying = voice
      voice = null
      try {
        invoke(b, dying, SLOT.release, b.proto.release)
      } catch {
        /* 释放失败忽略 */
      }
    },
  }
}
