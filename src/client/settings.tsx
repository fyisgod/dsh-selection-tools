/**
 * 设置页里的「划词工具」一页（settings.section）。
 *
 * 数据流：宿主半边持有设置文件（dsh-selection-tools.json）与 HTTP 路由，
 * 这里只用同源 fetch 读写——不依赖官方 settings 服务，插件在任何 profile 下都能用。
 *
 * 模型下拉的候选来自官方 \`ctx.modelDirectories\`（与输入框的模型座位同一份目录），
 * 目录读不到时退化成手填 provider / model。
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  API_PREFIX,
  AUTO_LANGUAGE_ID,
  DEFAULT_EXPLAIN_RULES,
  DEFAULT_TRANSLATE_RULES,
  LANGUAGES,
  normalizeSettings,
  type ModelSeat,
  type SelectionToolsSettings,
  type SettingsResponse,
} from '../shared/protocol.js'
import { detectLocale } from './api'

/** 客户端上下文里本组件用到的面。 */
interface ClientContext {
  get?: (name: string) => any
}

/** 模型目录里一个模型。 */
interface CatalogModel {
  id: string
  name?: string
  reasoning?: { defaultEffort?: string; efforts?: { id: string; name?: string }[] }
}

/** 模型目录里一个 provider 分组。 */
interface CatalogGroup {
  id: string
  name?: string
  label?: string
  models?: CatalogModel[]
}

/** 文案。 */
const COPY = {
  zh: {
    title: '划词工具',
    hint: '在任意应用里选中文字 → 菜单里点解释/翻译。这里的设置对所有划词生效，改完立即保存。',
    targetLabel: '默认翻译至',
    targetHint: '选「跟随原文自动」时保持老行为：中文译成英文，其它语言译成中文。',
    fallbackLabel: '反向目标语言',
    fallbackHint: '当选中文字已经是「默认翻译至」的语言时，改译成这个语言（选「自动」则取镜像：原文是中文就译英文，否则译中文）。',
    explainRulesLabel: '解释规则（交给模型的要求）',
    explainRulesHint: '这段文字会原样作为「要求」写进解释的提示词，一行一条。',
    translateRulesLabel: '翻译规则（交给模型的要求）',
    translateRulesHint: '这段文字会原样作为「要求」写进翻译的提示词，一行一条。',
    restore: '恢复默认',
    translateModelLabel: '翻译使用的模型',
    explainModelLabel: '解释使用的模型',
    modelHint: '「跟随当前会话」= 用你当前对话正在用的模型。',
    effortLabel: '推理等级',
    effortDefault: '适配器默认',
    followSession: '跟随当前会话',
    auto: '跟随原文自动（中 ↔ 英）',
    autoMirror: '自动（镜像）',
    manualHint: '暂时读不到模型目录，可直接填写 provider / model。',
    provider: 'provider',
    model: 'model',
    saved: '已保存',
    saving: '保存中…',
    failed: '保存失败',
    loading: '读取设置中…',
    loadFailed: '读取设置失败',
    retry: '重试',
  },
  en: {
    title: 'Selection tools',
    hint: 'Select text in any app, then pick Explain / Translate from the menu. Settings apply to every selection and save immediately.',
    targetLabel: 'Translate into',
    targetHint: '"Follow the source" keeps the original behaviour: Chinese → English, anything else → Chinese.',
    fallbackLabel: 'Fallback target',
    fallbackHint: 'Used when the selection is already in the primary target language.',
    explainRulesLabel: 'Explain rules (given to the model)',
    explainRulesHint: 'Sent verbatim as the "Requirements" block of the explain prompt, one rule per line.',
    translateRulesLabel: 'Translate rules (given to the model)',
    translateRulesHint: 'Sent verbatim as the "Requirements" block of the translate prompt, one rule per line.',
    restore: 'Restore default',
    translateModelLabel: 'Model for translation',
    explainModelLabel: 'Model for explanation',
    modelHint: '"Follow the current session" uses whatever model your conversation uses.',
    effortLabel: 'Reasoning effort',
    effortDefault: 'Adapter default',
    followSession: 'Follow current session',
    auto: 'Follow the source (zh ↔ en)',
    autoMirror: 'Automatic (mirror)',
    manualHint: 'The model catalog is not available yet — type provider / model directly.',
    provider: 'provider',
    model: 'model',
    saved: 'Saved',
    saving: 'Saving…',
    failed: 'Save failed',
    loading: 'Loading…',
    loadFailed: 'Could not load settings',
    retry: 'Retry',
  },
} as const

/** 文案类型（两种语言共用一套字段，值放宽成 string）。 */
type Copy = Record<keyof typeof COPY.zh, string>

/** 语言下拉的选项（含"自动"）。 */
function languageOptions(autoLabel: string): { id: string; label: string }[] {
  return [
    { id: AUTO_LANGUAGE_ID, label: autoLabel },
    ...LANGUAGES.map((item) => ({ id: item.id, label: item.label + ' (' + item.prompt + ')' })),
  ]
}

/**
 * 读模型目录。
 *
 * 两个来源，按优先级用：
 * 1. 当前会话的模型座位目录（`modelDirectories.directoryFor(sessionId)`）——与输入框同一份，
 *    但**只有存在当前会话时才有**；
 * 2. 全局模型目录（`modelDirectories.catalog`）——设置页常常在"还没开会话"时被打开，
 *    这时只能用它（它是一次 host RPC，不依赖会话）。
 */
function useModelCatalog(ctx: ClientContext): { groups: CatalogGroup[]; ready: boolean } {
  const [groups, setGroups] = useState<CatalogGroup[]>([])
  useEffect(() => {
    const directories = ctx.get?.('modelDirectories')
    if (directories === undefined || directories === null) return undefined
    let directory: any
    try {
      const sessionId = ctx.get?.('sessions')?.list?.getSnapshot?.()?.current
      directory = sessionId === undefined ? undefined : directories.directoryFor?.(sessionId)
    } catch {
      directory = undefined
    }
    const catalog = directories.catalog
    const read = () => {
      const fromDirectory = directory?.store?.getSnapshot?.()
      const fromCatalog = catalog?.store?.getSnapshot?.()
      const directoryGroups = Array.isArray(fromDirectory?.groups) ? fromDirectory.groups : []
      const catalogGroups = Array.isArray(fromCatalog?.value?.groups) ? fromCatalog.value.groups : []
      setGroups(directoryGroups.length > 0 ? directoryGroups : catalogGroups)
    }
    const stops: (() => void)[] = []
    for (const store of [directory?.store, catalog?.store]) {
      if (typeof store?.subscribe !== 'function') continue
      const stop = store.subscribe(read)
      if (typeof stop === 'function') stops.push(stop)
    }
    try {
      void catalog?.load?.().catch?.(() => undefined)
    } catch {
      /* 目录加载失败就用手填 */
    }
    read()
    return () => {
      for (const stop of stops) stop()
    }
  }, [ctx])
  return { groups, ready: groups.length > 0 }
}

/** 一个模型座位选择器（模型 + 推理等级）。 */
function ModelSeatField(props: {
  label: string
  hint: string
  copy: Copy
  seat: ModelSeat | null
  groups: CatalogGroup[]
  catalogsReady: boolean
  onChange: (seat: ModelSeat | null) => void
}): ReactNode {
  const { label, hint, copy, seat, groups, catalogsReady, onChange } = props
  const flat = useMemo(
    () =>
      groups.flatMap((group) =>
        (group.models ?? []).map((model) => ({
          key: group.id + '/' + model.id,
          provider: group.id,
          providerLabel: group.name ?? group.label ?? group.id,
          model,
        })),
      ),
    [groups],
  )
  const current = seat === null ? '' : seat.provider + '/' + seat.model
  const efforts = useMemo(() => {
    if (seat === null) return []
    const found = flat.find((item) => item.provider === seat.provider && item.model.id === seat.model)
    return found?.model.reasoning?.efforts ?? []
  }, [flat, seat])

  const pickModel = (value: string): void => {
    if (value === '') {
      onChange(null)
      return
    }
    const found = flat.find((item) => item.key === value)
    if (found === undefined) return
    const defaultEffort = found.model.reasoning?.defaultEffort
    onChange({
      provider: found.provider,
      model: found.model.id,
      ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
    })
  }

  const rows: ReactNode[] = []
  rows.push(
    createElement('span', { className: 'dst-set-label' }, label),
    catalogsReady
      ? createElement(
          'select',
          { className: 'dst-set-input', value: current, onChange: (event: any) => pickModel(String(event.target.value)) },
          [
            createElement('option', { key: '', value: '' }, copy.followSession),
            ...flat.map((item) =>
              createElement(
                'option',
                { key: item.key, value: item.key },
                item.providerLabel + ' · ' + (item.model.name ?? item.model.id),
              ),
            ),
          ],
        )
      : createElement(
          'div',
          { className: 'dst-set-row' },
          createElement('input', {
            className: 'dst-set-input',
            placeholder: copy.provider,
            value: seat?.provider ?? '',
            onChange: (event: any) =>
              onChange({ provider: String(event.target.value), model: seat?.model ?? '' }),
          }),
          createElement('input', {
            className: 'dst-set-input',
            placeholder: copy.model,
            value: seat?.model ?? '',
            onChange: (event: any) => onChange({ provider: seat?.provider ?? '', model: String(event.target.value) }),
          }),
        ),
  )
  if (catalogsReady && seat !== null && efforts.length > 0) {
    rows.push(
      createElement(
        'div',
        { className: 'dst-set-row' },
        createElement('span', { className: 'dst-set-sub' }, copy.effortLabel),
        createElement(
          'select',
          {
            className: 'dst-set-input',
            value: seat.reasoningEffort ?? '',
            onChange: (event: any) => {
              const effort = String(event.target.value)
              onChange({
                provider: seat.provider,
                model: seat.model,
                ...(effort === '' ? {} : { reasoningEffort: effort }),
              })
            },
          },
          [
            createElement('option', { key: '', value: '' }, copy.effortDefault),
            ...efforts.map((effort) => createElement('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id)),
          ],
        ),
      ),
    )
  }
  rows.push(createElement('span', { className: 'dst-set-hint' }, catalogsReady ? hint : copy.manualHint))
  return createElement('div', { className: 'dst-set-field' }, rows)
}

/**
 * 「划词工具」设置页。
 * @param props.ctx - 客户端 Cordis 上下文。
 */
export function SettingsSection(props: { ctx: ClientContext }): ReactNode {
  const { ctx } = props
  const locale = detectLocale()
  const copy: Copy = COPY[locale]
  const [settings, setSettings] = useState<SelectionToolsSettings | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'saved' | 'error'>('loading')
  const [error, setError] = useState('')
  const timer = useRef<number | null>(null)
  const { groups, ready: catalogsReady } = useModelCatalog(ctx)

  const load = useCallback(() => {
    setStatus('loading')
    void fetch(API_PREFIX + '/settings')
      .then((response) => (response.ok ? (response.json() as Promise<SettingsResponse>) : Promise.reject(new Error('HTTP ' + response.status))))
      .then((payload) => {
        setSettings(normalizeSettings(payload.settings))
        setStatus('ready')
        setError('')
      })
      .catch((cause: unknown) => {
        setStatus('error')
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [])

  useEffect(() => {
    load()
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [load])

  /** 改一项 → 立刻本地生效 + 防抖落盘。 */
  const update = useCallback((patch: Partial<SelectionToolsSettings>) => {
    setSettings((current) => {
      if (current === null) return current
      const next = normalizeSettings({ ...current, ...patch })
      setStatus('saving')
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        timer.current = null
        void fetch(API_PREFIX + '/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        })
          .then((response) => (response.ok ? (response.json() as Promise<SettingsResponse>) : Promise.reject(new Error('HTTP ' + response.status))))
          .then((payload) => {
            setSettings(normalizeSettings(payload.settings))
            setStatus('saved')
            setError('')
          })
          .catch((cause: unknown) => {
            setStatus('error')
            setError(cause instanceof Error ? cause.message : String(cause))
          })
      }, 220)
      return next
    })
  }, [])

  if (settings === null) {
    return createElement(
      'div',
      { className: 'dst-set-section' },
      createElement('h2', { className: 'dst-set-title' }, copy.title),
      createElement(
        'div',
        { className: 'dst-set-status' },
        createElement('span', { className: status === 'error' ? 'dst-set-error' : '' }, status === 'error' ? copy.loadFailed + '：' + error : copy.loading),
        status === 'error' ? createElement('button', { type: 'button', className: 'dst-set-link', onClick: load }, copy.retry) : null,
      ),
    )
  }

  const statusText =
    status === 'saving' ? copy.saving : status === 'saved' ? copy.saved : status === 'error' ? copy.failed + '：' + error : ''

  const languageField = (
    label: string,
    hint: string,
    value: string,
    autoLabel: string,
    key: 'targetLanguage' | 'fallbackLanguage',
  ): ReactNode =>
    createElement(
      'div',
      { className: 'dst-set-field', key },
      createElement('span', { className: 'dst-set-label' }, label),
      createElement(
        'select',
        { className: 'dst-set-input', value, onChange: (event: any) => update({ [key]: String(event.target.value) } as Partial<SelectionToolsSettings>) },
        languageOptions(autoLabel).map((option) => createElement('option', { key: option.id, value: option.id }, option.label)),
      ),
      createElement('span', { className: 'dst-set-hint' }, hint),
    )

  const rulesField = (
    key: 'explainRules' | 'translateRules',
    label: string,
    hint: string,
    value: string,
    fallback: string,
  ): ReactNode =>
    createElement(
      'div',
      { className: 'dst-set-field', key },
      createElement(
        'div',
        { className: 'dst-set-labelrow' },
        createElement('span', { className: 'dst-set-label' }, label),
        createElement('button', { type: 'button', className: 'dst-set-link', onClick: () => update({ [key]: fallback } as Partial<SelectionToolsSettings>) }, copy.restore),
      ),
      createElement('textarea', {
        className: 'dst-set-textarea',
        rows: 6,
        spellCheck: false,
        value,
        onChange: (event: any) => update({ [key]: String(event.target.value) } as Partial<SelectionToolsSettings>),
      }),
      createElement('span', { className: 'dst-set-hint' }, hint),
    )

  return createElement(
    'div',
    { className: 'dst-set-section' },
    createElement('h2', { className: 'dst-set-title' }, copy.title),
    createElement('p', { className: 'dst-set-hint dst-set-intro' }, copy.hint),
    languageField(copy.targetLabel, copy.targetHint, settings.targetLanguage, copy.auto, 'targetLanguage'),
    languageField(copy.fallbackLabel, copy.fallbackHint, settings.fallbackLanguage, copy.autoMirror, 'fallbackLanguage'),
    createElement(ModelSeatField, {
      key: 'translate-model',
      label: copy.translateModelLabel,
      hint: copy.modelHint,
      copy,
      seat: settings.translateModel,
      groups,
      catalogsReady,
      onChange: (seat: ModelSeat | null) => update({ translateModel: seat }),
    }),
    createElement(ModelSeatField, {
      key: 'explain-model',
      label: copy.explainModelLabel,
      hint: copy.modelHint,
      copy,
      seat: settings.explainModel,
      groups,
      catalogsReady,
      onChange: (seat: ModelSeat | null) => update({ explainModel: seat }),
    }),
    rulesField('explainRules', copy.explainRulesLabel, copy.explainRulesHint, settings.explainRules, DEFAULT_EXPLAIN_RULES),
    rulesField('translateRules', copy.translateRulesLabel, copy.translateRulesHint, settings.translateRules, DEFAULT_TRANSLATE_RULES),
    createElement('div', { className: 'dst-set-status' }, createElement('span', { className: status === 'error' ? 'dst-set-error' : '' }, statusText)),
  )
}
