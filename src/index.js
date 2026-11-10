/**
 * 保险丝 · 宿主半边
 * dsh-fuse
 *
 * 这一层只做三件事：
 *   1. 记账：把宿主已经记好的用量（`session/event` 的 `assistant/message`）翻成钱；
 *   2. 拦：在请求发出前（`agent/request` 瀑布）问一句「这笔还放不放」，
 *      越线就先把模型降下来，降不了就问界面，界面也不在就直接降档；
 *   3. 现眼：把状态以只读路由交给右下角那枚药丸与弹卡（`/dsh-fuse/*`）。
 *
 * 为什么不用 `llm/stream` 去拦：那条瀑布上现在挂着至少三个插件
 * （billion-context、cost-meter、我们自己），同一个请求会被多层分发，
 * 记一次账可能记成三次。`agent/request` 是「一个请求」的边界，天然不重复。
 *
 * @module dsh-fuse
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, resolve } from 'node:path'

import { createFuse, normalizeConfig } from './fuse.js'
import { createLedger, DEFAULT_PRICES, FALLBACK_PRICE, priceFor } from './ledger.js'

export const name = 'dsh-fuse'
export const inject = ['webServer', 'agents']

/** 路由前缀。浏览器半边用的相对路径必须跟它一致（见 src/client.js）。 */
const ROUTE = '/dsh-fuse'

/** 请求体上限：设置面板最大的那次提交也就几 KB。 */
const MAX_BODY_BYTES = 64 * 1024

/** 每个端点只认自己的方法：拿错方法时回 405，比回「没有这个端点」更好排查。 */
const METHODS = {
  '/state': ['GET'],
  '/decide': ['POST'],
  '/config': ['GET', 'POST'],
  '/audit': ['GET'],
  '/reveal': ['POST'],
}

/**
 * 读配置文件的内容。
 *
 * 顺序是：去 BOM → 空就按默认 → 直接 parse → 去掉尾逗号再 parse → 还不行才回默认。
 * 以前一 parse 失败就整份回落默认，用户改坏一个逗号，下次点保存就把其余设置全冲掉了。
 *
 * @param {string} text
 * @param {(message:string, error?:unknown) => void} [warn]
 * @returns {object} 归一后的配置
 */
export function parseConfigText(text, warn = () => {}) {
  const body = String(text ?? '').replace(/^\uFEFF/, '').trim()
  if (body === '') return normalizeConfig({})
  try {
    return normalizeConfig(JSON.parse(body))
  } catch {
    // 手改配置最常犯的错就是尾逗号（JSON 不认）。只修这一种，别自作聪明去删注释：
    // Windows 路径里的 `D://` 很可能会被当成注释删掉。
    const repaired = body.replace(/,(\s*[}\]])/g, '$1')
    try {
      return normalizeConfig(JSON.parse(repaired))
    } catch (error) {
      warn(`配置文件读不了，先按默认值跑（${String(error?.message ?? error)}）`, error)
      return normalizeConfig({})
    }
  }
}

/** DSH 主目录：跟宿主自己的约定一致，环境变量优先。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 保险丝自己的数据目录（配置 + 流水 + 审计）。 */
function resolveDir() {
  return join(resolveDshHome(), 'dsh-fuse')
}

/**
 * 把设置里的 `dataDir` 变成绝对路径。
 * 空 = 跟默认目录一样（`<DSH_HOME>/dsh-fuse`）；相对路径按 `<DSH_HOME>` 解析。
 */
export function resolveDataDir(raw, home = resolveDshHome()) {
  const text = String(raw ?? '').trim()
  if (text === '') return join(home, 'dsh-fuse')
  return isAbsolute(text) ? normalize(text) : resolve(home, text)
}

/**
 * 挑一个真正能用的数据目录：建不出来就 warn 一声、回落到默认目录。
 * 绝不抛错 —— 用户把路径写错（比如填了个不存在的盘），不该把宿主带死。
 */
export async function chooseDataDir(raw, { home = resolveDshHome(), warn = () => {} } = {}) {
  const fallback = join(home, 'dsh-fuse')
  const wanted = resolveDataDir(raw, home)
  if (wanted === fallback) {
    await mkdir(fallback, { recursive: true }).catch(() => {})
    return fallback
  }
  try {
    await mkdir(wanted, { recursive: true })
    const info = await stat(wanted)
    if (!info.isDirectory()) throw new Error('这个路径不是目录')
    return wanted
  } catch (error) {
    warn(`数据目录用不了（${wanted}），先放回默认目录 ${fallback}`, error)
    return fallback
  }
}

/**
 * 生效价目表里的型号（去掉 `'*'` 兜底键），去重排序，给面板做下拉用。
 * 供应商自己标的价也并进来：面板上得能选到只在某条线路上便宜的型号。
 */
function priceModels(prices, providers = {}, observed = []) {
  const table = { ...DEFAULT_PRICES, ...(prices && typeof prices === 'object' ? prices : {}) }
  const keys = Object.keys(table)
  for (const entry of Object.values(providers && typeof providers === 'object' ? providers : {})) {
    if (entry && typeof entry === 'object' && entry.prices && typeof entry.prices === 'object') {
      keys.push(...Object.keys(entry.prices))
    }
  }
  // 你已经真跑过的型号排前面：价目表里没有的（第三方通道）也能直接选到。
  const seen = Array.isArray(observed) ? observed.filter((key) => typeof key === 'string' && key !== '') : []
  return [...new Set([...seen, ...keys])].filter((key) => key !== '*')
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 只认本机回环。这条路由不是对外接口。 */
function isLoopback(req) {
  const remote = String(req.socket?.remoteAddress ?? '')
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** 本机回环的几个写法（Origin 里 IPv6 会带方括号）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * 回环还不够：浏览器里任何一个网页都能往 127.0.0.1 发请求，
 * 它带的 Origin 会指向那个站点。跨站的写操作（改配置、点决定）必须挡掉。
 * 没有 Origin 的放行：命令行、同源 GET、非浏览器客户端都不带它。
 */
function isSameSite(req) {
  const raw = String(req.headers?.origin ?? '').trim()
  if (raw === '') return true
  try {
    const origin = new URL(raw)
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return true
    return LOOPBACK_HOSTS.has(origin.hostname)
  } catch {
    return false
  }
}

/** 钱显示成两位小数，别在界面上抖。 */
export function money(value, currency = '¥') {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${currency}0.00`
  if (n >= 1000) return `${currency}${Math.round(n)}`
  return `${currency}${n.toFixed(2)}`
}

/** token 数带千分位（日志、弹卡、错误信息里都别让用户数零）。 */
export function formatTokens(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  return Math.round(n).toLocaleString('en-US')
}

/** 一道闸的「用量 / 上限」：token 闸就显示 token 数，别硬套货币符号。 */
function tripUsage(trip) {
  if (trip?.unit === 'tokens') return `${formatTokens(trip.spent)} / ${formatTokens(trip.cap)} token`
  return `${money(trip?.spent, trip?.currency)} / ${money(trip?.cap, trip?.currency)}`
}

/** 一句能直接给人看的话：越线了多少、上限多少。 */
function tripSentence(trip) {
  if (trip?.unit === 'tokens') {
    return `已用 ${formatTokens(trip.spent)} token，超过上限 ${formatTokens(trip.cap)} token`
  }
  return `已花 ${money(trip?.spent, trip?.currency)}，超过上限 ${money(trip?.cap, trip?.currency)}`
}

/**
 * 装进宿主。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** 配置永远放在这里：用户把数据目录改到 D 盘，也不能让配置找不着。 */
  const configDir = resolveDir()
  const configFile = join(configDir, 'config.json')
  /** 流水与审计实际生效的目录（跟着设置里的 dataDir 走）。 */
  let dataDir = configDir
  const warn = (message, error) => {
    const suffix = error === undefined ? '' : `：${String(error?.message ?? error)}`
    ctx.logger?.warn?.(`dsh-fuse: ${message}${suffix}`)
  }

  /** 当前设置。先按默认值跑，文件读上来再覆盖（读文件不等它）。 */
  let settings = normalizeConfig({})

  const ledger = createLedger({
    dir: dataDir,
    // 价目表 + 供应商表一起给：账本按 provider 挑价 / 乘倍率。
    getPrices: () => ({ prices: settings.prices, providers: settings.providers }),
    warn: (message) => warn(message),
  })

  const fuse = createFuse({
    ledger,
    getConfig: () => settings,
    warn: (message) => warn(message),
  })

  /** 这一轮用户刚发的话还没落库时，先记在这里；被拦下来要还回去。 */
  const claimed = new Map()
  /** 备份的条数上限：正常一轮一条，64 条足够，同时不至于异常时无限存。 */
  const MAX_CLAIMED = 64

  function rememberClaim(sid, messages) {
    claimed.delete(sid)
    claimed.set(sid, messages)
    if (claimed.size <= MAX_CLAIMED) return
    const oldest = claimed.keys().next().value
    if (oldest !== undefined && oldest !== sid) claimed.delete(oldest)
  }

  /**
   * 按设置切换数据目录：立刻建目录、换账本、读回新目录里今天的流水。
   * 路径不可用时 `chooseDataDir` 会自己回落到默认目录，这里只管接着跑。
   */
  async function applyDataDir(raw) {
    const picked = await chooseDataDir(raw, { warn: (message, error) => warn(message, error) })
    // 以账本真正接受的目录为准：它探测完写权限后可能已经回滚到旧目录了，
    // 这时 /state、/audit、/reveal 都得跟着旧目录走，不能只报「想切的」那个。
    dataDir = await ledger.relocate(picked)
    return dataDir
  }

  /** 读配置。读不动就用默认值，绝不让宿主起不来。 */
  const ready = (async () => {
    try {
      settings = parseConfigText(await readFile(configFile, 'utf8'), (message, error) => warn(message, error))
    } catch {
      // 第一次装：文件还没写出来，默认值先跑，下一次保存会把它写好。
    }
    try {
      await applyDataDir(settings.dataDir)
    } catch (error) {
      // 连换目录都失败了（极少见）：退回默认目录，账照样记。
      warn('初始化数据目录失败，先用默认目录', error)
      dataDir = configDir
      await ledger.relocate(configDir).catch(() => {})
    }
  })()

  /** 保存配置（写临时文件再换名，半截文件不会把下次启动卡住）。 */
  async function saveSettings(patch) {
    await ready.catch(() => {})
    // 面板只改一个字段时，别把同组的其它字段冲掉（{caps:{day:80}} 不该重置 turn/hour）。
    const next = { ...settings, ...(patch ?? {}) }
    for (const key of ['caps', 'capsTokens', 'degradeTo', 'prices']) {
      const part = patch?.[key]
      if (part && typeof part === 'object' && !Array.isArray(part)) {
        next[key] = { ...(settings?.[key] ?? {}), ...part }
      }
    }
    // 供应商是二级结构（供应商 → { multiplier, prices }），要合两层：
    // 只改一家的倍率时，别把这家的价目表、或别家整个冲掉。
    const providerPatch = patch?.providers
    if (providerPatch && typeof providerPatch === 'object' && !Array.isArray(providerPatch)) {
      const merged = { ...(settings?.providers ?? {}) }
      for (const [id, entry] of Object.entries(providerPatch)) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
        const prev = merged[id] && typeof merged[id] === 'object' ? merged[id] : {}
        const prices =
          entry.prices && typeof entry.prices === 'object' && !Array.isArray(entry.prices)
            ? { ...(prev.prices ?? {}), ...entry.prices }
            : prev.prices ?? {}
        merged[id] = { ...prev, ...entry, prices }
      }
      next.providers = merged
    }
    settings = normalizeConfig(next)
    // 刚关掉熔断：把还挂着等人的卡放掉，别让请求停在「等一个不会来的回答」上。
    if (settings.enabled === false) fuse.release('release', 'disabled')
    // 配置文件永远写回默认目录，跟数据目录无关。
    let persisted = true
    try {
      await mkdir(configDir, { recursive: true })
      const tmp = `${configFile}.tmp`
      await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8')
      await rename(tmp, configFile)
    } catch (error) {
      // 只读盘 / 满盘：这次修改在内存里已经生效了，不该让面板报错，
      // 但也别装作存好了 —— 告诉调用方，重启之后它会丢。
      persisted = false
      warn('保存配置失败（这次改动只在内存里生效）', error)
    }
    // 数据目录可能刚被改过：立刻生效（建目录、换账本、读回今天的流水）。
    try {
      await applyDataDir(settings.dataDir)
    } catch (error) {
      warn('切换数据目录失败，继续用原目录', error)
    }
    return { settings, persisted }
  }

  /**
   * 把用户刚发、但还没落库的消息送回下一次输入框。
   *
   * `outcome.expect` 是这一发请求被拦时手上那份备份：只有当前备份还是它才归还。
   * 否则（这一轮已经结束、新一轮又备份了新输入）就会把新一轮的消息再发一遍，
   * 用户看到的是同一句话出现两次。
   */
  function restoreInput(sessionId, why, outcome = {}) {
    const messages = claimed.get(sessionId)
    if (!messages || messages.length === 0) return false
    if (outcome.strict === true && messages !== outcome.expect) return false
    // 先摘掉再发：宁可少发一次，也不能因为中途抛错重发（重复＝用户看到两条）。
    claimed.delete(sessionId)
    try {
      const agent = ctx.agents?.get?.(sessionId)
      if (agent && typeof agent.send === 'function') {
        for (const message of messages) agent.send(message, 'next-turn', false)
        ctx.logger?.info?.(`dsh-fuse: 把 ${messages.length} 条输入还给了会话（${why}）`)
      }
    } catch (error) {
      warn(`归还输入失败（${why}）`, error)
    }
    return true
  }

  /* ------------------------------------------------------------------ *
   * 模型切换：只走公开的 agent.model.select()
   *
   * 宿主在「提示词组装之前」就把这一步的路由钉死了，`agent/request` 里改
   * provider / model / reasoningEffort 会被**整步拒绝**（用户看到红色报错）。
   * 公开 API 的语义是「记一笔选择，从下一步开始生效，包括同一轮的工具续跑」，
   * 所以降档要越早越好：新的一轮刚开始就降，这一轮第一步就是便宜模型；
   * 一轮跑了一半才降，就只能影响后面的工具续跑。
   * ------------------------------------------------------------------ */

  /** 被我们换过模型的会话：{ sid: { applied, from } }。回滚要回到「第一次换之前」那个选择。 */
  const switched = new Map()
  /** 上限：正常同时开着的会话几十个，64 足够，也防止长跑一夜涨成泄漏。 */
  const MAX_SWITCHED = 64

  function rememberSwitch(sid, applied, from) {
    const known = switched.get(sid)
    if (known === undefined) {
      switched.set(sid, { applied, from })
      if (switched.size > MAX_SWITCHED) {
        const oldest = switched.keys().next().value
        if (oldest !== undefined && oldest !== sid) switched.delete(oldest)
      }
      return
    }
    // 同一轮里又换了一次（turn/start 之后又 after-usage）：回滚目标仍是最初那个。
    known.applied = applied
  }

  /** 取会话的 agent；拿不到就回 null（绝不抛）。 */
  function agentFor(sid) {
    try {
      const agent = ctx.agents?.get?.(sid)
      return agent && typeof agent === 'object' ? agent : null
    } catch (error) {
      warn(`取会话 agent 失败（${sid}）`, error)
      return null
    }
  }

  /** agent.model.current()：同步读；没有、或返回 Promise，都当「不知道」。 */
  function selectionOf(agent) {
    try {
      const value = agent?.model?.current?.()
      if (!value || typeof value !== 'object' || typeof value.then === 'function') return null
      return value
    } catch (error) {
      warn('读当前模型失败', error)
      return null
    }
  }

  /** 把一份选择交给宿主；返回是否真的发出去了。 */
  function applySelection(agent, selection) {
    try {
      if (!agent || !agent.model || typeof agent.model.select !== 'function') {
        warn('宿主没有 agent.model.select，这次没换成模型')
        return false
      }
      const payload = { model: String(selection?.model ?? '') }
      if (payload.model === '') return false
      // provider 留空 = 沿用当前 selection 的 provider，不要塞一个空串进去。
      if (typeof selection?.provider === 'string' && selection.provider !== '') payload.provider = selection.provider
      if (typeof selection?.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
        payload.reasoningEffort = selection.reasoningEffort
      }
      const out = agent.model.select(payload)
      // 正常返回 undefined；万一宿主给的是 Promise，别让它变成未捕获拒绝把宿主带崩。
      if (out && typeof out.then === 'function') out.catch((error) => warn('切换模型失败（继续用原模型）', error))
      return true
    } catch (error) {
      warn('切换模型失败（继续用原模型）', error)
      return false
    }
  }

  /* ------------------------------------------------------------------ *
   * 降档目标能不能用：以宿主的模型目录为准
   *
   * 真机教训：把目标写成当前线路并没有提供的型号（比如在 opencode-go 上
   * 写 `deepseek-chat`），换过去之后下一个请求直接失败、整轮任务跟着崩掉。
   * 保险丝的底线是「绝不把任务弄死」，所以换之前必须确认这条线路上真有它。
   *
   * 目录只能异步拿，而 `session/event` 是同步派发的、换模型又必须赶在下一步
   * 组装提示词之前，所以判定只读缓存，缓存交给定时器预热。
   * ------------------------------------------------------------------ */

  const catalog = new Map() // provider → string[] | null（null = 拿不到）
  const warnedTargets = new Set()
  // 最近一次真正跑起来的线路：面板的降档下拉以它的目录为准。
  let lastProvider = ''

  async function refreshCatalog() {
    try {
      const llm = ctx.get('llm')
      if (!llm || typeof llm.listModels !== 'function') return
      const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      for (const entry of Array.isArray(providers) ? providers : []) {
        const id = String(entry?.id ?? '')
        if (id === '') continue
        try {
          const list = await llm.listModels(id)
          const ids = (Array.isArray(list) ? list : []).map((m) => String(m?.id ?? m)).filter(Boolean)
          // 空列表通常意味着「这条线路没配密钥」而不是「一个模型都没有」，
          // 按「拿不到」处理，宁可保守地不降档。
          catalog.set(id, ids.length > 0 ? ids : null)
        } catch {
          catalog.set(id, null)
        }
      }
    } catch (error) {
      warn('读取模型目录失败（降档会保守地不执行）', error)
    }
  }

  /**
   * 这一步该换成哪个模型。
   *
   * @returns {{target: {provider: string, model: string} | null, why: string}}
   *   why = ''                    → 可以换
   *       = 'no-target'           → 没得降（没配置也挑不出更便宜的，或已经在目标上）
   *       = 'target-unavailable'  → 这条线路上没有这个型号
   *       = 'target-unverified'   → 目录没拿到，不敢赌
   */
  function resolveTarget(sid, current) {
    const target = fuse.degradeTarget(sid, current)
    if (target === null) return { target: null, why: 'no-target' }
    const provider = String(target.provider || current?.provider || '')
    if (provider === '') return { target: null, why: 'target-unverified' }
    const model = String(target.model)
    const list = catalog.get(provider)
    if (Array.isArray(list)) {
      if (!list.includes(model)) return { target: null, why: 'target-unavailable' }
      return { target: { provider, model }, why: '' }
    }
    // 目录读不到：第三方网关（pi-ai 之类）通常不上报型号清单。这时退一步，
    // 用「这条线路上真跑通过这个型号」当证据——流水里有行，网关就认它。
    if (typeof ledger.modelsOn === 'function' && ledger.modelsOn(provider).includes(model)) {
      return { target: { provider, model }, why: '' }
    }
    return { target: null, why: 'target-unverified' }
  }

  /** 同一个目标只提醒一次，别把宿主日志刷满。 */
  function warnTargetOnce(why, target, current) {
    const provider = String(target?.provider || current?.provider || '')
    const model = String(target?.model ?? '')
    const key = `${why}|${provider}|${model}`
    if (warnedTargets.has(key)) return
    warnedTargets.add(key)
    if (warnedTargets.size > 50) warnedTargets.clear()
    if (why === 'target-unavailable') {
      warn(`降档目标 ${provider}/${model} 不在当前线路上，已改为放行（换过去会让这一步失败）`)
      return
    }
    warn(`没拿到 ${provider || '当前线路'} 的模型目录，这次不降档（保守放行）`)
  }

  /**
   * 有没有「降得下去」的可能：显式配了目标，或者手里有不止一个见过的型号
   * （没配目标时 fuse 会自动挑一个更便宜的）。用来区分「没得降」和
   * 「已经在目标模型上」这两种 null。
   */
  function hasDegradeTarget() {
    const model = settings?.degradeTo?.model
    if (typeof model === 'string' && model.trim() !== '') return true
    const seen = ledger.models?.()
    return Array.isArray(seen) && seen.length > 1
  }

  /** 用户有没有明确指定降档目标（没指定时「挑不出更便宜的」= 没得降，要放行并留痕）。 */
  function hasExplicitTarget() {
    const model = settings?.degradeTo?.model
    return typeof model === 'string' && model.trim() !== ''
  }

  /** 审计一行降档：「配额到了，我把下一步的模型换了」。 */
  function auditDegrade(sid, mode, trip, from, to) {
    void ledger.audit({
      kind: 'fuse',
      action: 'degrade',
      mode,
      sid,
      scope: trip?.scope,
      unit: trip?.unit,
      spent: trip?.spent === undefined ? undefined : round(trip.spent),
      cap: trip?.cap,
      from: typeof from?.model === 'string' ? from.model : '',
      to: typeof to?.model === 'string' ? to.model : '',
      fromProvider: typeof from?.provider === 'string' ? from.provider : '',
      toProvider: typeof to?.provider === 'string' ? to.provider : '',
    })
  }

  /**
   * 到了该降档的时候：`select()` 一次 + 审计 + 记下回滚点。
   *
   * 注意**不改**任何请求参数：这一步已经钉死在旧路由上了，改了会被宿主拒绝。
   *
   * @returns {boolean} 是否真的换了
   */
  function switchDown(sid, target, mode, trip, agent = null, current = null) {
    const model = String(target?.model ?? '')
    if (model === '') return false
    const provider = String(target?.provider ?? '')
    // 以宿主记录的当前选择为准；拿不到才退回调用方手上的那份 config。
    const now = selectionOf(agent) ?? current
    const already =
      now !== null && String(now.model ?? '') === model && (provider === '' || String(now.provider ?? '') === provider)
    if (already) {
      // 已经是便宜模型了：宿主那边也会 no-op，但本轮别再弹卡问一遍。
      fuse.markDegraded(sid)
      return false
    }
    const owner = agent ?? agentFor(sid)
    if (!applySelection(owner, { provider, model })) {
      // 换不成也要让这一步跑下去：放行原配置，不是抛错。
      return false
    }
    rememberSwitch(sid, { provider, model }, {
      provider: typeof now?.provider === 'string' ? now.provider : '',
      model: typeof now?.model === 'string' ? now.model : '',
      reasoningEffort: typeof now?.reasoningEffort === 'string' ? now.reasoningEffort : '',
    })
    fuse.markDegraded(sid)
    auditDegrade(sid, mode, trip, now ?? {}, { provider, model })
    const reason = trip ? `${trip.scope} ${tripUsage(trip)}` : '额度已超'
    ctx.logger?.info?.(
      `dsh-fuse: ${reason}，从下一步起换成 ${provider !== '' ? `${provider}/` : ''}${model}（${mode}）`,
    )
    return true
  }

  /** 本轮结束：如果我们换过、而且用户没手动改成别的，就换回原来的模型。 */
  function restoreModel(sid) {
    const entry = switched.get(sid)
    if (entry === undefined) return
    // 先摘标记：无论换不换回，这一轮已经结束。
    switched.delete(sid)
    const agent = agentFor(sid)
    const now = selectionOf(agent)
    if (now === null) return
    const applied = entry.applied ?? {}
    const stillOurs =
      String(now.model ?? '') === String(applied.model ?? '') &&
      (String(applied.provider ?? '') === '' || String(now.provider ?? '') === String(applied.provider ?? ''))
    // 用户已经手动换了模型（current 不是我们设的那个）：不要抢他的选择。
    if (!stillOurs) return
    const from = entry.from ?? {}
    if (String(from.model ?? '') === '') return
    if (!applySelection(agent, { provider: from.provider ?? '', model: from.model, reasoningEffort: from.reasoningEffort ?? '' })) {
      return
    }
    void ledger.audit({
      kind: 'fuse',
      action: 'restore',
      mode: 'turn-end',
      sid,
      from: applied.model ?? '',
      to: from.model,
      fromProvider: applied.provider ?? '',
      toProvider: from.provider ?? '',
    })
    ctx.logger?.info?.(`dsh-fuse: 这一轮结束，模型换回 ${from.provider !== '' ? `${from.provider}/` : ''}${from.model}`)
  }

  /** 这一轮放弃降档：留痕 + 本轮不再重复算（理由写明是「没配目标」还是「目标不可用」）。 */
  function passNoTarget(sid, mode, trip, config, reason = 'no-degrade-target') {
    fuse.markBypass(sid)
    void ledger.audit({
      kind: 'fuse',
      action: 'pass-turn',
      reason,
      mode,
      sid,
      scope: trip?.scope,
      unit: trip?.unit,
      spent: trip?.spent === undefined ? undefined : round(trip.spent),
      cap: trip?.cap,
      model: config?.model ?? '',
    })
  }

  /**
   * `turn/start`：这一刻 hour/day 已经超线，就先把下一步的模型换了 ——
   * 这是唯一能让「本轮第一步」就用便宜模型的机会。
   */
  function degradeAtTurnStart(sid) {
    if (settings.autoDegrade !== true) return
    const trip = fuse.check(sid)
    if (trip === null) return
    // 用户刚说过「这道闸别再问」：静默期里就该原样放行，不要偷偷降档。
    if (fuse.plan(sid, trip) === 'silent-pass') return
    if (!hasDegradeTarget()) {
      passNoTarget(sid, 'turn-start', trip, null)
      return
    }
    const agent = agentFor(sid)
    const current = selectionOf(agent)
    const { target, why } = resolveTarget(sid, current)
    if (target === null) {
      if (why === 'no-target') {
        // 已经就在目标模型上：没有可降的，安静收场。
        if (hasExplicitTarget()) return
        passNoTarget(sid, 'turn-start', trip, null)
        return
      }
      warnTargetOnce(why, fuse.degradeTarget(sid, current), current)
      passNoTarget(sid, 'turn-start', trip, null, why)
      return
    }
    switchDown(sid, target, 'turn-start', trip, agent, current)
  }

  /** `assistant/message` 记完账：单轮越线就降档，影响同一轮后面的工具续跑。 */
  function degradeAfterUsage(sid) {
    if (settings.autoDegrade !== true) return
    const trip = fuse.check(sid)
    if (trip === null || trip.scope !== 'turn') return
    if (fuse.plan(sid, trip) === 'silent-pass') return
    if (!hasDegradeTarget()) {
      passNoTarget(sid, 'after-usage', trip, null)
      return
    }
    const agent = agentFor(sid)
    const current = selectionOf(agent)
    const { target, why } = resolveTarget(sid, current)
    if (target === null) {
      if (why === 'no-target') {
        if (hasExplicitTarget()) return
        passNoTarget(sid, 'after-usage', trip, null)
        return
      }
      warnTargetOnce(why, fuse.degradeTarget(sid, current), current)
      passNoTarget(sid, 'after-usage', trip, null, why)
      return
    }
    switchDown(sid, target, 'after-usage', trip, agent, current)
  }

  /**
   * 请求已经组装好、这一步的路由已经钉死：这里只能「记一笔下一步的选择」，
   * 绝不能改 `next()` 给的 config（改了整步会被宿主拒绝）。
   */
  function degradeInRequest(sid, trip, config, mode) {
    if (!hasDegradeTarget()) {
      passNoTarget(sid, mode, trip, config)
      return config
    }
    const { target, why } = resolveTarget(sid, config)
    if (target === null) {
      if (why === 'no-target') {
        // 没指定目标、又挑不出更便宜的：这就是「没得降」，照实放行并留痕，
        // 别假装降过档（否则审计和真实发生的事对不上）。
        if (!hasExplicitTarget()) {
          passNoTarget(sid, mode, trip, config)
          return config
        }
        // 已经在用户指定的目标上（比如 turn/start 刚换过）：什么都不用做，本轮也别再问。
        fuse.markDegraded(sid)
        return config
      }
      // 目标这条线路上没有、或目录没拿到：换过去会让整步失败，宁可放行。
      warnTargetOnce(why, fuse.degradeTarget(sid, config), config)
      passNoTarget(sid, mode, trip, config, why)
      return config
    }
    const agent = agentFor(sid)
    switchDown(sid, target, mode, trip, agent, config)
    return config
  }

  /* ------------------------------------------------------------------ *
   * 记账：宿主已经把用量记在会话事件里了，我们只负责翻成钱
   * ------------------------------------------------------------------ */

  // 模型目录预热：`session/event` 是同步派发、换模型必须赶在下一步之前，
  // 所以这里异步把目录拉进缓存，判定时只读缓存。
  ctx.effect(() => {
    void refreshCatalog()
    const timer = setInterval(() => {
      void refreshCatalog()
    }, 5 * 60 * 1000)
    // 定时器不该拖着进程不让退出。
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'dsh-fuse.catalog')

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        const sid = String(session?.id ?? event?.data?.sessionId ?? '')
        if (sid === '') return
        const type = event?.type ?? event?.kind

        if (type === 'request/header') {
          const config = event?.data?.header?.config
          if (config) {
            fuse.noteModel(sid, config.provider, config.model)
            lastProvider = String(config.provider ?? lastProvider)
          }
          return
        }

        if (type === 'turn/start') {
          fuse.noteTurnStart(sid)
          // 只对「下一步」生效，所以要赶在这一轮第一次组装提示词之前换。
          degradeAtTurnStart(sid)
          return
        }

        if (type === 'user/message') {
          // 输入已经落库了，手上那份备份就不该再还回去（否则会重复两条）。
          claimed.delete(sid)
          return
        }

        if (type === 'turn/end') {
          // 兜底：如果这一轮被我们拦掉了、消息又没落库，收尾时还回去。
          restoreInput(sid, 'turn/end')
          // 如果这一轮是我们换的模型、且用户没手动改过，就换回原来的。
          restoreModel(sid)
          return
        }

        if (type === 'assistant/message') {
          const usage = event?.data?.usage
          if (!usage) return
          // provider 一起带上：同名的模型在不同网关价格差好几倍。
          ledger.record({
            sessionId: sid,
            model: fuse.modelOf(sid),
            provider: fuse.providerOf(sid),
            usage,
          })
          // 单轮越线就现在降：同一轮后面的工具续跑也会用便宜模型。
          degradeAfterUsage(sid)
        }
      } catch (error) {
        warn('记账出错', error)
      }
    })
    return () => off?.()
  }, 'dsh-fuse.ledger')

  /* ------------------------------------------------------------------ *
   * 记账要用的两件小事：输入备份、模型名
   * ------------------------------------------------------------------ */

  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', (payload, next) => {
      try {
        const sid = String(payload?.agent?.id ?? '')
        if (sid !== '') rememberClaim(sid, Array.isArray(payload?.messages) ? payload.messages : [])
      } catch (error) {
        // 备份输入是「保险」用的：备份失败也不能拦住这一步。
        warn('备份输入失败（这轮被停止时可能少还一条）', error)
      }
      return next()
    })
    return () => off?.()
  }, 'dsh-fuse.claimed-input')

  /* ------------------------------------------------------------------ *
   * 闸门：请求发出前那一下
   * ------------------------------------------------------------------ */

  ctx.effect(() => {
    const off = ctx.on(
      'agent/request',
      async (payload, next) => {
        const sid = String(payload?.agent?.id ?? '')
        // 先记下「这一发对应的是哪一份输入备份」：等卡的时候可能已经转到了下一轮，
        // 那一轮会备份新的输入，停止时只能还这一发自己的那份。
        const claim = sid === '' ? undefined : claimed.get(sid)
        // 先让宿主把配置算出来（模型选择、provider 解析都在 next 里面）。
        const config = await next()
        if (!config || typeof config !== 'object') return config

        if (sid === '') return config

        try {
          fuse.noteModel(sid, config.provider, config.model)
          const trip = fuse.check(sid)
          if (trip === null) return config

          const plan = fuse.plan(sid, trip)
          if (plan === 'silent-pass') {
            // 同一道闸刚问过（静默期内）：这次不弹卡、不降档，原样放行。
            fuse.markBypass(sid)
            void ledger.audit({
              kind: 'fuse',
              action: 'pass-silent',
              reason: 'scope-quiet',
              sid,
              scope: trip.scope,
              unit: trip.unit,
              spent: round(trip.spent),
              cap: trip.cap,
              model: config.model,
            })
            return config
          }
          if (plan === 'silent-degrade') {
            // 静默降档：不是改这一发，而是记一笔「下一步用便宜的」，这一发原样放行。
            return degradeInRequest(sid, trip, config, 'request')
          }

          // 有人看着界面：挂一张卡，等 30 秒（到点按「降档」处理，不是停止）。
          const action = await fuse.ask({ sessionId: sid, trip, current: config })

          if (action === 'degrade') {
            // 「降档」的语义变了：不是把这一发请求改成便宜模型（宿主会拒绝），
            // 而是记一笔选择，从下一步开始生效；这一发原样放行。
            return degradeInRequest(sid, trip, config, 'card')
          }

          // 卡被外部放掉了（配置刚被关掉 / 插件卸载）：原配置放行，不是降档也不是停止。
          if (action === 'release') return config

          if (action === 'pass') {
            fuse.markBypass(sid)
            void ledger.audit({
              kind: 'fuse',
              action: 'pass-once',
              sid,
              scope: trip.scope,
              unit: trip.unit,
              spent: round(trip.spent),
              cap: trip.cap,
              model: config.model,
            })
            return config
          }

          // stop：把用户刚发的那句话还回去，然后让这一轮带着清楚的理由结束。
          fuse.silence(sid)
          restoreInput(sid, 'fuse-stop', { strict: true, expect: claim })
          void ledger.audit({
            kind: 'fuse',
            action: 'stop',
            sid,
            scope: trip.scope,
            unit: trip.unit,
            spent: round(trip.spent),
            cap: trip.cap,
            model: config.model,
          })
          throw new FuseStopError(trip)
        } catch (error) {
          if (error instanceof FuseStopError) throw error
          // 保险丝自己出错时一律放行：拦不住事故是小事，把宿主搞瘫是大事。
          warn('闸门出错，本次放行', error)
          return config
        }
      },
      { prepend: true },
    )
    return () => off?.()
  }, 'dsh-fuse.gate')

  /* ------------------------------------------------------------------ *
   * 给界面用的小路由
   * ------------------------------------------------------------------ */

  /**
   * 打开数据目录这个能力故意不实现：插件起子进程会让市场预检多一条「需要复核」的能力项。
   * 这里只回路径，界面把它放进剪贴板，用户自己粘到资源管理器地址栏。
   */

  const route = {
    kind: 'prefix',
    path: ROUTE,
    async handler(req, res) {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, why: '只接受本机回环来源' })
        return
      }
      if (!isSameSite(req)) {
        sendJson(res, 403, { ok: false, why: '只接受本机页面发起的请求' })
        return
      }
      // 界面每来一次都算「有人看着」——决定越线时是弹卡还是静默降档。
      fuse.touchClient()
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) || '/' : url.pathname
      const allowed = METHODS[path]
      if (allowed !== undefined && !allowed.includes(req.method)) {
        sendJson(res, 405, { ok: false, why: `${path} 只接受 ${allowed.join(' / ')}` })
        return
      }

      try {
        if (path === '/state' && req.method === 'GET') {
          await ready
          const sid = url.searchParams.get('sid') ?? ''
          const snapshot = fuse.snapshot(sid)
          sendJson(res, 200, {
            ok: true,
            ...snapshot,
            // 面板要的：数据实际放在哪、价目表里有哪些型号可选。
            dataDir,
            models: priceModels(settings.prices, settings.providers, ledger.models()),
            // 当前线路上真实存在的型号：降档下拉以它为准，避免选到这条线路没有的型号。
            catalog: { provider: lastProvider, models: Array.isArray(catalog.get(lastProvider)) ? catalog.get(lastProvider) : [] },
            config: settings,
            prices: { ...DEFAULT_PRICES, ...settings.prices },
            fallbackPrice: FALLBACK_PRICE,
          })
          return
        }

        if (path === '/decide' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
          const ok = fuse.decide(body?.id, body?.action)
          sendJson(res, ok ? 200 : 409, { ok, action: body?.action ?? '' })
          return
        }

        if (path === '/config' && req.method === 'GET') {
          await ready
          sendJson(res, 200, { ok: true, config: settings, prices: { ...DEFAULT_PRICES, ...settings.prices } })
          return
        }

        if (path === '/config' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req, MAX_BODY_BYTES)) || '{}')
          const saved = await saveSettings(body?.config ?? body ?? {})
          // 回实际生效的配置：面板拿它覆盖本地，别让用户以为填了什么就存了什么。
          sendJson(res, 200, { ok: true, persisted: saved.persisted, config: saved.settings })
          return
        }

        if (path === '/audit' && req.method === 'GET') {
          await ready
          const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 20) || 20))
          const now = new Date()
          const file = join(
            dataDir,
            `audit-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`,
          )
          let rows = []
          try {
            const text = await readFile(file, 'utf8')
            rows = text
              .split('\n')
              .filter((line) => line.trim() !== '')
              .slice(-limit)
              .map((line) => {
                try {
                  return JSON.parse(line)
                } catch {
                  return null
                }
              })
              .filter(Boolean)
          } catch {
            rows = []
          }
          sendJson(res, 200, { ok: true, rows })
          return
        }

        if (path === '/reveal' && req.method === 'POST') {
          // 只回路径，不打开任何东西：请求体里给什么路径都不看。
          await ready
          sendJson(res, 200, { ok: true, dir: dataDir })
          return
        }

        sendJson(res, 404, { ok: false, why: `没有这个端点：${path}` })
      } catch (error) {
        sendJson(res, 400, { ok: false, why: String(error?.message ?? error) })
      }
    },
  }

  ctx.effect(() => {
    const off = ctx.webServer.register(route)
    return () => {
      try {
        off?.()
      } catch {
        // 宿主换代时返回值可能不是函数，忽略。
      }
    }
  }, 'dsh-fuse.route')

  /* ------------------------------------------------------------------ *
   * 命令行兜底：没有界面（纯 CLI）时也能看账
   * ------------------------------------------------------------------ */

  try {
    ctx.effect(() => {
      const off = ctx.commands?.register?.({
        name: 'fuse',
        description: '保险丝：看今天的账与状态（/fuse config 看设置）',
        input: { hint: '[status|config|audit]' },
        handler: async (input) => {
          await ready
          const arg = String(input ?? '').trim()
          if (arg === 'config') return JSON.stringify(settings, null, 2)
          if (arg === 'audit') {
            const rows = fuse.pendingList()
            return rows.length === 0 ? '现在没有挂起的熔断。' : JSON.stringify(rows, null, 2)
          }
          const snapshot = fuse.snapshot('')
          const lines = [
            `今日 ${money(snapshot.spend.day, settings.currency)} / ${money(settings.caps.day, settings.currency)}`,
            `近一小时 ${money(snapshot.spend.hour, settings.currency)} / ${money(settings.caps.hour, settings.currency)}`,
            `当前会话本轮 ${money(snapshot.spend.turn, settings.currency)} / ${money(settings.caps.turn, settings.currency)}`,
          ]
          // token 闸开了才多打一行：没开的人不该看见一堆 0。
          const tokenCaps = settings.capsTokens ?? {}
          if (['turn', 'hour', 'day'].some((scope) => Number(tokenCaps[scope]) > 0)) {
            const used = snapshot.spend.tokens ?? {}
            lines.push(
              `token（本轮/小时/今日）${formatTokens(used.turn)}/${formatTokens(tokenCaps.turn)} · ` +
                `${formatTokens(used.hour)}/${formatTokens(tokenCaps.hour)} · ` +
                `${formatTokens(used.day)}/${formatTokens(tokenCaps.day)}`,
            )
          }
          lines.push(`状态 ${settings.enabled ? '开着' : '关着'}；挂起 ${snapshot.pending.length} 张`)
          return lines.join('\n')
        },
      })
      return () => off?.()
    }, 'dsh-fuse.command')
  } catch (error) {
    warn('注册 /fuse 命令失败（不影响熔断）', error)
  }

  ctx.effect(() => () => {
    fuse.dispose()
    void ledger.flush()
  }, 'dsh-fuse.dispose')

  void ready
}

/** 金额取两位小数写进审计，人看得顺眼。 */
function round(value) {
  return Math.round(Number(value) * 10000) / 10000
}

/** 被保险丝停下来时抛的错：带一个稳定的 code，宿主与日志都能认出来。 */
export class FuseStopError extends Error {
  constructor(trip) {
    const scope = trip?.scope === 'turn' ? '本轮' : trip?.scope === 'hour' ? '近一小时' : '今天'
    super(`保险丝：${scope}${tripSentence(trip)}。这一轮已停下，你发的那句话还留在输入框里。`)
    this.name = 'FuseStopError'
    this.code = 'FUSE_STOP'
    this.trip = trip
  }
}

/** 暴露给自检用（不在宿主路径上）。 */
export const __internal = {
  resolveDir,
  resolveDshHome,
  resolveDataDir,
  chooseDataDir,
  priceModels,
  priceFor,
  parseConfigText,
}
