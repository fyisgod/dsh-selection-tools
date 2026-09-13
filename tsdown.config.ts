/**
 * tsdown 配置（对齐 dsh 官方 client 预设的用法）：
 *
 * - Node half：src/index.ts → lib/index.js（ESM；不 import 任何 @deepseek-ai/*，
 *   全部能力经 ctx.get / ctx.xxx 服务获取，因此没有外部依赖需要声明）。
 * - Browser half：src/client/index.tsx → lib/client.js，惰性 CJS 工厂，
 *   经 window.__ModuleLoader__.load({ id, factory }) 注册。
 *
 * 平台模块（react / primitives）由 shell 的模块表回答，构建时保持 external；
 * 其余依赖全部内联进 bundle。
 */
import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsdown'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}
const ID = manifest.name

/** shell 模块表（PLATFORM_MODULES）能回答的请求——构建时保持 external。 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

export default defineConfig([
  {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    sourcemap: false,
    clean: true,
  },
  {
    name: ID + '/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
