/**
 * 记账本：把宿主已经记下的用量翻成钱，同时守住三个时间窗口。
 *
 * 这一层刻意不碰任何宿主对象（不读 ctx、不碰 llm、不注册钩子），
 * 所以它可以被 `scripts/selftest.mjs` 直接喂假数据跑，
 * 也可以在宿主里当纯函数用。谁调用它、什么时候调用，都写在 `src/index.js` 里。
 *
 * 钱的单位跟着 `prices` 走：默认按「元 / 百万 token」，界面显示 ¥。
 * 换币种不用改代码 —— 改 `config.currency` 与价目表即可，这里只做乘法。
 *
 * @module dsh-fuse/ledger
 */

import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 内置参考价（元 / 百万 token）。
 *
 * 两个来源：
 *   · DeepSeek 官方 V3.2 线的公开价（缓存未命中输入 ¥2、命中 ¥0.2、输出 ¥3）；
 *   · 本机实测校准（2026-11-08）：opencode-go 的 `deepseek-v4.1-flash` 报价是
 *     $0.15 / $0.003 / $0.6 每百万，按 cost-meter 记录的汇率 6.6713 折成
 *     ¥1 / ¥0.02 / ¥4 —— 用这组价把当天 296 万输入、4692 万命中、46 万输出
 *     算出来是 ¥5.74，与 cost-meter 自己算的 ¥5.7488 对齐到分。
 *
 * **这是参考价，不是账单**：第三方网关、企业版、限时折扣都对不上，
 * 所以在面板里可以逐个模型改，也可以在 config.prices 里覆盖。
 */
export const DEFAULT_PRICES = {
  'deepseek-v4.1-flash': { input: 1, cacheRead: 0.02, output: 4 },
  'deepseek-chat': { input: 2, cacheRead: 0.2, output: 3 },
  'deepseek-reasoner': { input: 4, cacheRead: 1, output: 16 },
}

/** 一个都匹配不上时用它，宁可粗一点，也别把账记成 0。 */
export const FALLBACK_PRICE = { input: 1, cacheRead: 0.02, output: 4 }

/**
 * 单个价目字段：没给就是 undefined（交给上层兜底），给了就必须是 0 或正数。
 * 返回 null = 这个值是坏的。坏价目不能当成 0 元：那会把这条线路的花费
 * 永远记成免费，闸门也就再也拦不住它了。
 */
function priceNumber(value) {
  if (value === undefined || value === null) return undefined
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * 一条价目归一成 `{input, output, cacheRead}`；有坏字段就整条作废（返回 null）。
 * 缺的字段按 0 算（用户可能只给输出价），缺 cacheRead 按输入价的 1/10 估。
 *
 * @param {unknown} price
 * @returns {{input:number, output:number, cacheRead:number}|null}
 */
export function sanitizePrice(price) {
  if (price === null || typeof price !== 'object' || Array.isArray(price)) return null
  const input = priceNumber(price.input)
  const output = priceNumber(price.output)
  const cacheRead = priceNumber(price.cacheRead)
  if (input === null || output === null || cacheRead === null) return null
  const netInput = input ?? 0
  return { input: netInput, output: output ?? 0, cacheRead: cacheRead ?? netInput / 10 }
}

/**
 * 价目表归一：只留算得出来的条目。
 * 写配置前也走它 —— `{input: NaN}` 之类的东西不能落进 config.json。
 *
 * @param {unknown} raw
 * @returns {Record<string, {input:number, output:number, cacheRead:number}>}
 */
export function sanitizePrices(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, entry] of Object.entries(raw)) {
    const name = String(key ?? '').trim()
    if (name === '') continue
    const clean = sanitizePrice(entry)
    if (clean !== null) out[name] = clean
  }
  return out
}

/** 拿单个字段，非数字一律当 0（宿主不同版本的 usage 形状会变）。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 把宿主给的 usage 归一成四个桶。**五个桶不能重复加总**：
 * `input` 只放「没命中缓存」的那部分，命中与写入各自成桶。
 *
 * 认两套字段名：
 *   · 宿主归一化过的（dsh 0.2.x 的 `assistant/message`）：inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
 *   · 各家原始形状（OpenAI 的 prompt_tokens / completion_tokens / prompt_cache_hit_tokens 等）
 *
 * @param {object|undefined} usage
 * @returns {{input:number, output:number, cacheRead:number, cacheWrite:number}}
 */
export function normalizeUsage(usage) {
  const u = usage ?? {}
  const out = num(u.outputTokens ?? u.output_tokens ?? u.completion_tokens)
  const cacheRead = num(
    u.cacheReadTokens ||
      u.cache_read_input_tokens ||
      u.prompt_cache_hit_tokens ||
      u.prompt_tokens_details?.cached_tokens ||
      u.input_tokens_details?.cached_tokens,
  )
  const cacheWrite = num(u.cacheWriteTokens ?? u.cache_creation_input_tokens)
  // 归一化字段是「未命中缓存」的净输入；原始字段则是「含缓存」的总输入，要减掉命中部分。
  const declared = u.inputTokens ?? u.input_tokens
  const input =
    declared === undefined
      ? Math.max(0, num(u.prompt_tokens) - cacheRead - cacheWrite)
      : num(declared)
  return { input, output: out, cacheRead, cacheWrite }
}

/**
 * 供应商倍率：缺省 1；0、负数、NaN、乱字符一律按 1（宁可原价，也别算成免费）。
 *
 * @param {Record<string, {multiplier?:number}>} providers
 * @param {string} provider
 */
export function multiplierOf(providers, provider) {
  const id = String(provider ?? '')
  if (id === '') return 1
  const entry = providers?.[id]
  const value = Number(entry?.multiplier)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** 一张价目表按「精确 → 前缀 → 通配 *」找价；坏条目跳过、继续往下找。 */
function resolveIn(table, name) {
  if (table === null || typeof table !== 'object') return undefined
  const exact = sanitizePrice(table[name])
  if (exact !== null) return exact
  for (const key of Object.keys(table)) {
    if (key === '*' || !name.startsWith(key)) continue
    const found = sanitizePrice(table[key])
    if (found !== null) return found
  }
  return sanitizePrice(table['*']) ?? undefined
}

/**
 * 找这个模型的价。先精确、再前缀（`deepseek-chat-0915` 认 `deepseek-chat`）、
 * 再通配 `*`、最后落到内置参考价。
 *
 * 供应商（第三方网关 / 中转站）参与时，顺序是「从具体到兜底」：
 *   1. `providers[provider].prices` 里自己标的价（同样精确 → 前缀 → `*`）；
 *      命中就是最终价，不再乘倍率 —— 标了价就说明这是这家的真实价。
 *   2. 全局价目表（含内置参考价）按同样的规则解析，再乘
 *      `providers[provider].multiplier`（缺省 1）。`*` 与 `FALLBACK_PRICE`
 *      也走这一步，所以「认不出的型号」同样享受倍率。
 *
 * 老调用 `priceFor(model, prices)` 行为完全不变（provider 为空 → 倍率 1）。
 *
 * @param {string} model
 * @param {Record<string, {input:number, cacheRead?:number, output:number}>} prices
 * @param {{provider?:string, providers?:Record<string, {multiplier?:number, prices?:object}>}} [opts]
 */
export function priceFor(model, prices = {}, opts = {}) {
  const name = String(model ?? '')
  const provider = String(opts?.provider ?? '')
  const providers = opts?.providers && typeof opts.providers === 'object' ? opts.providers : {}
  const entry =
    provider !== '' && providers[provider] && typeof providers[provider] === 'object' ? providers[provider] : null

  // ① 供应商自己标的价：命中即最终价。
  if (entry !== null) {
    const own = resolveIn(entry.prices, name)
    if (own !== undefined) return own
  }

  // ② 全局价目表（含内置参考价）③ 全局兜底（`*` / FALLBACK），统一乘倍率。
  const table = { ...DEFAULT_PRICES, ...(prices && typeof prices === 'object' ? prices : {}) }
  const base = resolveIn(table, name) ?? sanitizePrice(FALLBACK_PRICE) ?? { input: 0, output: 0, cacheRead: 0 }
  const multiplier = multiplierOf(providers, provider)
  if (multiplier === 1) return base
  return {
    input: base.input * multiplier,
    cacheRead: base.cacheRead * multiplier,
    output: base.output * multiplier,
  }
}

/**
 * 四个桶 → 一笔钱。
 *
 * @param {{input:number, output:number, cacheRead:number, cacheWrite:number}} usage
 * @param {{input:number, output:number, cacheRead:number}} price 元 / 百万 token
 * @returns {number}
 */
export function costOf(usage, price) {
  return (
    (usage.input / 1e6) * price.input +
    (usage.cacheRead / 1e6) * price.cacheRead +
    (usage.cacheWrite / 1e6) * price.input +
    (usage.output / 1e6) * price.output
  )
}

/**
 * 一笔用量一共多少 token：四个桶相加（`i + o + r + w`）。
 * 闸门按 token 卡的时候用的就是它，所以流水行只要四个桶还在就能复算。
 *
 * @param {{input:number, output:number, cacheRead:number, cacheWrite:number}} usage
 * @returns {number}
 */
export function tokensOf(usage) {
  return num(usage?.input) + num(usage?.output) + num(usage?.cacheRead) + num(usage?.cacheWrite)
}

/** 一行流水是多少 token（旧行没有独立字段，四个桶加起来就行）。 */
function rowTokens(row) {
  return num(row?.i) + num(row?.o) + num(row?.r) + num(row?.w)
}

/** 本地时区的 YYYY-MM-DD（不是 UTC：用户说的「今天」是墙上的今天）。 */
export function dayKey(at) {
  const d = new Date(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const HOUR_MS = 60 * 60 * 1000

/**
 * 开一本账。
 *
 * `getPrices`（或新的 `getPricing`）可以返回两种形状，都认：
 *   · 老用法：直接返回价目表 `{ '模型名': {input, cacheRead, output} }`
 *   · 新用法：`{ prices, providers }`，providers 是 `{ 供应商: { multiplier, prices } }`
 *
 * @param {object} options
 * @param {string} options.dir      数据目录（默认 `<DSH_HOME>/dsh-fuse`，可用 relocate 换）
 * @param {() => object} options.getPrices  实时读价目表（设置面板改了立刻生效）
 * @param {() => object} [options.getPricing] 新名字；给了就优先用它
 * @param {() => number} [options.now]
 * @param {(message:string, error?:unknown) => void} [options.warn]
 */
export function createLedger({ dir, getPrices, getPricing, now = () => Date.now(), warn = () => {} }) {
  /** 当前数据目录。`relocate` 会换掉它，之后所有读写都跟着走。 */
  let currentDir = String(dir ?? '')
  /** 今天的流水（内存里只留最近一小时，长跑的会话不该把内存吃穿）。 */
  let entries = []
  /** 今日累计（内存里单独记一个数：entries 只留一小时，不能拿它算当天）。 */
  let dayTotal = 0
  /** 今日 token 累计（同上：超过一小时也不能让它缩水）。 */
  let dayTokens = 0
  /** 每笔写盘都排在前一笔后面，避免两条 append 交错。 */
  let writing = Promise.resolve()
  /** 上一次提醒「写盘失败」的时间：盘坏了会每笔都失败，一分钟只喊一次。 */
  let writeWarnAt = 0
  /** 一次 load() 只读一次盘；并发调用共享同一个 promise（否则会读两遍、记两次）。 */
  let loading = null
  let loaded = false
  let day = dayKey(now())
  /** 见过的最大时间戳：用来识别系统时间回拨（回拨时不能把当天的账清零）。 */
  let highWater = now()

  /** 每轮的花费 / token（按会话），`turn/start` 各清一次。 */
  const turnSpend = new Map()
  const turnTokens = new Map()

  /** 读一次价目表，并把两种返回形状归一。 */
  function readPricing() {
    let value
    try {
      if (typeof getPricing === 'function') value = getPricing()
      else if (typeof getPrices === 'function') value = getPrices()
    } catch (error) {
      warn('读价目表失败，本次按内置参考价记账', error)
      return { prices: {}, providers: {} }
    }
    if (value && typeof value === 'object') {
      const keys = Object.keys(value)
      const wrapped =
        keys.length > 0 &&
        keys.every((key) => key === 'prices' || key === 'providers') &&
        (value.prices !== undefined || value.providers !== undefined)
      if (wrapped) {
        return {
          prices: value.prices && typeof value.prices === 'object' ? value.prices : {},
          providers: value.providers && typeof value.providers === 'object' ? value.providers : {},
        }
      }
      // 老用法：整张表就是价目表本身。
      return { prices: value, providers: {} }
    }
    return { prices: {}, providers: {} }
  }

  /** 把一行 JSON 追加到文件；失败只记一次日志，绝不抛给调用方。 */
  function appendLine(file, line, folder = currentDir) {
    writing = writing
      .then(async () => {
        await mkdir(folder, { recursive: true })
        await appendFile(file, line + '\n', 'utf8')
      })
      .catch((error) => {
        // 盘满了 / 只读盘上每一笔都会失败：一分钟提醒一次就够，
        // 每笔都喊会把宿主的日志刷满，真正要看的错误反而被埋掉。
        const at = now()
        if (at - writeWarnAt < 60_000) return
        writeWarnAt = at
        warn(`写流水失败（账还在内存里，只是这条没落盘）：${String(error)}`)
      })
    return writing
  }

  /** 记下每个见过的型号与最近一次出现的时间（给「降档目标」下拉用）。 */
  const seenModels = new Map()
  // 「这条线路上跑通过这个型号」——目录读不到时的唯一硬证据。
  const seenOn = new Map()
  function noteModelSeen(model, at, provider) {
    const key = String(model ?? '')
    if (key === '') return
    if ((seenModels.get(key) ?? 0) < at) seenModels.set(key, at)
    const line = String(provider ?? '')
    if (line !== '') {
      const pair = `${line}\u0000${key}`
      if ((seenOn.get(pair) ?? 0) < at) seenOn.set(pair, at)
      if (seenOn.size > 200) {
        const oldest = [...seenOn.entries()].sort((a, b) => a[1] - b[1])[0]
        if (oldest) seenOn.delete(oldest[0])
      }
    }
    // 只留最近 50 个，别让长跑会话把这张表撑大。
    if (seenModels.size > 50) {
      const oldest = [...seenModels.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest) seenModels.delete(oldest[0])
    }
  }

  /** 这条线路上真跑通过哪些型号（按最近使用排序）。 */
  function modelsOn(provider) {
    const line = String(provider ?? '')
    if (line === '') return []
    const prefix = `${line}\u0000`
    return [...seenOn.entries()]
      .filter(([pair]) => pair.startsWith(prefix))
      .sort((a, b) => b[1] - a[1])
      .map(([pair]) => pair.slice(prefix.length))
  }

  /**
   * 启动时把今天的流水读回来，这样「每日上限」在重启之后仍然算数。
   * 读不动就当今天从零开始——记账不该拦住宿主启动。
   */
  async function readToday() {
    rollDay()
    const file = join(currentDir, `ledger-${day}.jsonl`)
    let text = ''
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return
    }
    const cutoff = now() - HOUR_MS
    let kept = 0
    let bad = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        // 半行（写到一半被杀）、手改坏的行：跳过并计数，不能整份放弃 ——
        // 整份放弃等于让今日额度凭空回血，日闸就废了。
        bad += 1
        continue
      }
      // 负金额同样跳过：负累计会把 dayTotal 拽回 0 附近，日闸再也拦不住。
      if (!row || typeof row !== 'object' || !Number.isFinite(row.t) || !Number.isFinite(row.cost) || row.cost < 0) {
        bad += 1
        continue
      }
      // 整天的账都要接回来：日闸看的是「今天一共花了多少」，
      // 只接回最近一小时会让重启后的日额度凭空回血（这个洞踩过一次）。
      dayTotal += row.cost
      // token 的日累计跟 money 一样处理：旧流水行没有 p / token 字段也算得出来。
      dayTokens += rowTokens(row)
      noteModelSeen(row.model, row.t, row.p)
      if (row.t < cutoff) continue
      entries.push(row)
      kept += 1
    }
    if (bad > 0) warn(`流水里有 ${bad} 行读不了，已跳过（${file}）`)
    if (dayTotal > 0) {
      warn(`从 ${file} 接回今天的流水 ${kept} 条（今日累计 ¥${dayTotal.toFixed(2)}）`)
    }
  }

  function load() {
    // 并发调用要共享同一次读盘：各自读一遍会把同一天的流水记两遍，
    // 而「先 loaded=true 再 await」又会让后来者读到 0。
    if (loading !== null) return loading
    if (loaded) return Promise.resolve()
    loaded = true
    loading = readToday()
      .catch((error) => warn('读流水失败，今天先按零算', error))
      .finally(() => {
        loading = null
      })
    return loading
  }

  /** 换日：把前一天的流水腾掉，今日计数从零开始。 */
  function rollDay() {
    const key = dayKey(now())
    // 只有往前走才换账。系统时间被拨回（key < day）时若也清零，
    // 拨一下表就能白拿一份日额度 —— 回拨期间继续记在当前这一天里。
    if (key <= day) return
    day = key
    entries = []
    dayTotal = 0
    dayTokens = 0
    turnSpend.clear()
    turnTokens.clear()
  }

  /**
   * 记账：一条 usage 进账，返回这笔的金额。
   *
   * `provider` 是这条流水实际走的供应商（第三方网关 / 中转站），写进流水行的 `p`；
   * 老的流水行没有 `p`，读回来按空处理（不影响金额，也不会报错）。
   */
  function record({ sessionId, model, provider = '', usage, at = now() }) {
    rollDay()
    const normalized = normalizeUsage(usage)
    const pricing = readPricing()
    const cost = costOf(
      normalized,
      priceFor(model, pricing.prices, { provider, providers: pricing.providers }),
    )
    const tokens = tokensOf(normalized)
    const row = {
      t: at,
      sid: String(sessionId ?? ''),
      model: String(model ?? ''),
      p: String(provider ?? ''),
      i: normalized.input,
      o: normalized.output,
      r: normalized.cacheRead,
      w: normalized.cacheWrite,
      cost: cost,
    }
    entries.push(row)
    dayTotal += cost
    dayTokens += tokens
    noteModelSeen(row.model, at, row.p)
    // 一小时窗口的内存只留最近一小时。entries 不一定按 t 递增
    // （时间被拨回后新行会带着更小的 t 追加在末尾），所以按时间过滤，不能从头砍。
    if (at > highWater) highWater = at
    const cutoff = highWater - HOUR_MS
    if (entries.some((line) => line.t < cutoff)) entries = entries.filter((line) => line.t >= cutoff)
    const sid = row.sid
    turnSpend.set(sid, (turnSpend.get(sid) ?? 0) + cost)
    turnTokens.set(sid, (turnTokens.get(sid) ?? 0) + tokens)
    trimTurns(sid)
    void appendLine(join(currentDir, `ledger-${day}.jsonl`), JSON.stringify(row))
    return cost
  }

  /**
   * 三个窗口现在各花了多少钱、各用了多少 token。
   *
   * 老的三个数字 (turn / hour / day) 原样保留，token 放在 `tokens` 里 ——
   * 既有调用方一个都不用改。
   *
   * @returns {{turn:number, hour:number, day:number, tokens:{turn:number, hour:number, day:number}}}
   */
  function spend(sessionId) {
    rollDay()
    const sid = String(sessionId ?? '')
    const cutoff = now() - HOUR_MS
    let hour = 0
    let hourTokens = 0
    for (const row of entries) {
      if (row.t >= cutoff) {
        hour += row.cost
        hourTokens += rowTokens(row)
      }
    }
    return {
      turn: turnSpend.get(sid) ?? 0,
      hour,
      day: dayTotal,
      tokens: {
        turn: turnTokens.get(sid) ?? 0,
        hour: hourTokens,
        day: dayTokens,
      },
    }
  }

  /** 单轮计数是按会话存的；子代理一茬茬开新会话，不设上限这张表只会一直长。 */
  const MAX_TURN_SESSIONS = 2000
  function trimTurns(keep) {
    if (turnSpend.size <= MAX_TURN_SESSIONS) return
    for (const key of turnSpend.keys()) {
      if (turnSpend.size <= MAX_TURN_SESSIONS) break
      if (key === keep) continue
      turnSpend.delete(key)
      turnTokens.delete(key)
    }
  }

  /** 新一轮开始：单轮额度清零（钱与 token 一起）。 */
  function startTurn(sessionId) {
    const sid = String(sessionId ?? '')
    turnSpend.set(sid, 0)
    turnTokens.set(sid, 0)
    trimTurns(sid)
  }

  /** 审计：只增不改，按月一个文件。 */
  function audit(record) {
    const at = now()
    const row = { t: at, at: new Date(at).toISOString(), ...record }
    const folder = currentDir
    const file = join(folder, `audit-${new Date(at).getFullYear()}-${String(new Date(at).getMonth() + 1).padStart(2, '0')}.jsonl`)
    return appendLine(file, JSON.stringify(row), folder)
  }

  /**
   * 换一个数据目录（设置面板改了 dataDir 之后立刻生效）。
   *
   * 换完会清掉内存里的旧流水、重新读回新目录里今天的流水 —— 以新目录为准。
   * 但切之前必须先确认新目录真的写得进去：切过去才发现写不了，
   * 就只能带着「当日累计已清零」回滚，那等于白送一天的额度。
   *
   * @param {string} nextDir 绝对路径
   * @returns {Promise<string>} 实际生效的目录（失败时是旧目录）
   */
  async function relocate(nextDir) {
    const target = String(nextDir ?? '').trim()
    if (target === '') return currentDir
    if (target === currentDir) {
      // 目录没变：没读过就读一次，读过就什么都不用做。
      await load().catch(() => {})
      return currentDir
    }
    try {
      await mkdir(target, { recursive: true })
      const info = await stat(target)
      if (!info.isDirectory()) throw new Error('这个路径不是目录')
      // 建得出来不等于写得进去（只读盘 / 权限 / 满盘），写个探针再删。
      const probe = join(target, `.dsh-fuse-probe-${process.pid}-${Date.now()}`)
      await writeFile(probe, '', 'utf8')
      await rm(probe, { force: true }).catch(() => {})
    } catch (error) {
      warn(`数据目录 ${target} 写不了，继续用 ${currentDir}`, error)
      return currentDir
    }
    // 等手上那几笔写盘落定再切，免得一笔账写到一半换个地方。
    await writing.catch(() => {})
    if (loading !== null) await loading.catch(() => {})
    currentDir = target
    entries = []
    dayTotal = 0
    dayTokens = 0
    turnSpend.clear()
    turnTokens.clear()
    loaded = false
    loading = null
    await load().catch(() => {})
    return currentDir
  }

  /** 等所有写盘落定（自检与卸载时用）。 */
  function flush() {
    return writing
  }

  return {
    load,
    relocate,
    record,
    spend,
    startTurn,
    audit,
    flush,
    dir: () => currentDir,
    dayKey: () => day,
    models: () => [...seenModels.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model),
    modelsOn,
    /** 自检用：看一眼内部表有没有长到失控。 */
    stats: () => ({ sessions: turnSpend.size, entries: entries.length, day, loaded }),
  }
}
