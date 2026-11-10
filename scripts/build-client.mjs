/**
 * 把 src/client.js（ES module，供浏览器与自检直接 import）
 * 转成 lib/client.js（DSH 运行时要的经典 script 形态）。
 *
 * 为什么必须转：DSH 的客户端 bundle 是**经典 script**，用
 * `<script src=… async>` 注入、**不带 `type="module"`**，
 * 所以顶层出现 `export` 就是 SyntaxError。
 *
 * 运行时真正要的形状是：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 *
 * 这里做的就是把 `export function apply` 变成 `function apply`，
 * 再在 factory 末尾统一把名字挂到 `exports` 上——源码仍是唯一真相。
 *
 *   node scripts/build-client.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SRC = join(root, 'src', 'client.js')
const OUT = join(root, 'lib', 'client.js')

/** 包名，同时也是 ModuleLoader 的行 id。 */
const ID = 'dsh-fuse'

const RE_FN = /^export\s+(async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/
const RE_DECL = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/
const RE_LIST = /^export\s*\{([^}]*)\}/
const RE_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*'(\.\.?\/[\w./-]+)'\s*$/

function declaredNames(raw) {
  const names = new Set()
  for (const l of raw.split('\n')) {
    const d = RE_DECL.exec(l) || RE_FN.exec(l)
    if (d) names.add(d[2])
  }
  return names
}

async function readSource(path) {
  const raw = await readFile(path, 'utf8')
  return raw.replace(/\*\/(?=(?:export|import)\s)/g, '*/\n')
}

function stripExport(line) {
  if (/^export\s*\{/.test(line)) {
    throw new Error(`摊平不支持 \`export { … }\` 写法：${line.trim()}`)
  }
  return line.replace(/^export\s+(?=(async\s+function|function|class|const|let|var)\s)/, '')
}

const defs = []
const seen = new Map()

async function inlineFile(file, dir, stack) {
  const path = join(dir, file)
  if (stack.includes(path)) throw new Error(`循环 import：${[...stack, path].join(' → ')}`)
  if (seen.has(path)) return seen.get(path)
  const raw = await readSource(path)
  if (/^export default/m.test(raw)) {
    throw new Error(`${file} 里有 \`export default\`——摊平只支持具名导出。`)
  }
  const name = `__mod${seen.size + 1}`
  seen.set(path, name)
  const out = []
  const here_ = dirname(path)
  for (const line of raw.split('\n')) {
    const m = RE_IMPORT.exec(line.trim())
    out.push(m ? await fromImport(m, here_, [...stack, path]) : stripExport(line))
  }
  defs.push(
    [`const ${name} = (() => {`, out.join('\n'), `  return { ${[...declaredNames(raw)].join(', ')} }`, `})()`].join('\n'),
  )
  return name
}

async function fromImport(m, dir, stack) {
  const pairs = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [from, to] = s.split(/\s+as\s+/).map((t) => t.trim())
      return [from, to || from]
    })
  const file = m[2]
  const declared = declaredNames(await readSource(join(dir, file)))
  for (const [from] of pairs) {
    if (!declared.has(from)) throw new Error(`${file} 里没有导出 ${from}`)
  }
  const bind = pairs.map(([from, to]) => (from === to ? from : `${from}: ${to}`)).join(', ')
  const name = await inlineFile(file, dir, stack)
  return `const { ${bind} } = ${name}`
}

async function flatten(source, dir) {
  const out = []
  for (const line of source.split('\n')) {
    const m = RE_IMPORT.exec(line.trim())
    out.push(m ? await fromImport(m, dir, []) : line)
  }
  return out.join('\n')
}

const source = await flatten(await readFile(SRC, 'utf8'), join(root, 'src'))
const lines = source.split('\n')
const exported = []
const body = []

for (const line of lines) {
  if (line.startsWith('export default')) {
    throw new Error('src/client.js 里有 `export default`——运行时的 ModuleLoader 没有 default interop，别用。')
  }

  const fn = RE_FN.exec(line)
  if (fn) {
    body.push(line.replace(/^export\s+/, ''))
    exported.push(fn[2])
    continue
  }

  const decl = RE_DECL.exec(line)
  if (decl) {
    body.push(line.replace(/^export\s+/, ''))
    exported.push(decl[2])
    continue
  }

  const list = RE_LIST.exec(line)
  if (list) {
    for (const raw of list[1].split(',')) {
      const name = raw.trim()
      if (name === '') continue
      if (name.includes(' as ')) {
        throw new Error(`src/client.js 里的 \`export { ${name} }\` 用了 as 改名，构建脚本不支持。`)
      }
      exported.push(name)
    }
    continue
  }

  body.push(line)
}

if (exported.length === 0) {
  throw new Error('src/client.js 里一个顶层导出都没找到——构建脚本会产出空壳。')
}

const assignments = exported.map((n) => `    exports.${n} = ${n}`).join('\n')

const out = `/*
 * dsh-fuse · 浏览器半边（运行时装）
 *
 * ⚠️ 这个文件是 scripts/build-client.mjs 从 src/client.js 生成的，不要手改。
 * 改 src/client.js，然后跑 \`node scripts/build-client.mjs\`。
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(ID)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

${defs.join('\n\n')}

${body.join('\n')}

${assignments}
    return module.exports
  },
})
`

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, out, 'utf8')

const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1)
console.log(`lib/client.js  ${kb} KB  摊平 ${defs.length} 个文件  导出 ${exported.length} 个：${exported.join(', ')}`)
