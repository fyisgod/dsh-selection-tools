#!/usr/bin/env node
/**
 * 门禁：screenshots.json 必须可解析、1–8 张、且每张图都能在自己仓库里找到。
 *
 * 为什么有这个清单：插件市场（dsh-market 详情页）按 screenshots.json 展示截图。
 * 相对路径在自己仓库里改名会立刻被这里拦住；写死绝对 URL 只会静默烂掉，
 * 所以绝对 URL 只接受 GitHub 托管的 https 地址。
 * 约定来源：awesome-dsh-plugin 的 contributing.md（screenshots 一节）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(root, 'screenshots.json')

/** 允许的 GitHub 图床（与上游清单一致；第三方图床因用户隐私被拒） */
const GITHUB_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'objects.githubusercontent.com',
])

const errors = []

if (!existsSync(manifestPath)) {
  console.error('✗ 找不到 screenshots.json（约定：放在 package.json 旁边）')
  process.exit(1)
}

let raw
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`✗ screenshots.json 不是合法 JSON：${err.message}`)
  process.exit(1)
}

// 支持 ["a.png"] 与 { "screenshots": ["a.png"] } 两种写法
const list = Array.isArray(raw) ? raw : raw?.screenshots

if (!Array.isArray(list)) {
  console.error('✗ screenshots.json 必须是数组，或形如 { "screenshots": [...] }')
  process.exit(1)
}

if (list.length < 1 || list.length > 8) {
  errors.push(`图片数量必须是 1–8 张，当前 ${list.length} 张`)
}

list.forEach((entry, index) => {
  const at = `第 ${index + 1} 项`
  if (typeof entry !== 'string' || entry.trim() === '') {
    errors.push(`${at} 不是非空字符串：${JSON.stringify(entry)}`)
    return
  }

  const value = entry.trim()

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url
    try {
      url = new URL(value)
    } catch {
      errors.push(`${at} 不是合法 URL：${value}`)
      return
    }
    if (url.protocol !== 'https:') {
      errors.push(`${at} 绝对 URL 必须是 https：${value}`)
    }
    if (!GITHUB_HOSTS.has(url.hostname)) {
      errors.push(`${at} 只接受 GitHub 托管的图片地址，收到 ${url.hostname}：${value}`)
    }
    return
  }

  if (value.startsWith('/') || value.split('/').includes('..')) {
    errors.push(`${at} 相对路径不能跳出仓库（不能以 / 开头、不能含 ..）：${value}`)
    return
  }

  const absolute = resolve(root, value)
  if (!absolute.startsWith(root + sep)) {
    errors.push(`${at} 相对路径越出仓库根目录：${value}`)
    return
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    errors.push(`${at} 仓库里没有这个文件（是不是改名/删除了？）：${value}`)
    return
  }
  if (extname(absolute) === '') {
    errors.push(`${at} 没有扩展名，市场无法判断图片格式：${value}`)
  }
})

if (errors.length > 0) {
  console.error('✗ screenshots.json 校验失败：')
  for (const message of errors) console.error(`  - ${message}`)
  process.exit(1)
}

const local = list.filter((entry) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)).length
console.log(`✓ screenshots.json 通过：${list.length} 张（本地 ${local} / 远程 ${list.length - local}）`)
