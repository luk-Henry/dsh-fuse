/**
 * 闸门：判断「这一笔请求该不该放」，以及越线之后怎么收场。
 *
 * 这里不碰宿主 API，只做三件事：
 *   1. 拿账本算出三个窗口的钱，跟阈值比；
 *   2. 维护每个会话的「本轮已降档 / 本轮已放行 / 静默到几点」；
 *   3. 需要问人时，把一张「待决定」的卡挂在这里，等界面来回答（或等超时）。
 *
 * 真去改写请求、真去抛错的地方在 `src/index.js` 的 agent/request 钩子里。
 *
 * @module dsh-fuse/fuse
 */

import { dayKey, priceFor, sanitizePrices } from './ledger.js'

/**
 * 默认设置。
 *
 * 阈值刻意给得比「正常的贵」松一档：保险丝的任务是拦事故（死循环、反复重试、
 * 挂机跑一夜），不是拦一次认真思考。正常用户一整天碰不到它才是对的。
 *
 * @type {object}
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  currency: '¥',
  caps: {
    /** 单轮：一次「用户发一句话 → 跑完」最多烧这么多。 */
    turn: 5,
    /** 滚动一小时。 */
    hour: 15,
    /** 自然日（本地时区零点换日）。 */
    day: 50,
  },
  /**
   * 按 token 卡的第二道闸（不知道单价、或者走的是包月/中转线路时用）。
   * 单位是 token，0 = 这道关掉；三道窗口跟 `caps` 一一对应。
   * 同一个窗口先比金额、再比 token，哪个先超就报哪个。
   */
  capsTokens: {
    turn: 0,
    hour: 0,
    day: 0,
  },
  /** 外观：'auto' 跟随系统，'dark' / 'light' 强制。界面只认这三个值。 */
  appearance: 'auto',
  /** 花到阈值的这个比例时，面板上的数字变黄（只是提示，不拦）。 */
  warnRatio: 0.6,
  /** 越线时的默认动作：先降档，降不下来再问人。 */
  autoDegrade: true,
  /**
   * 越线后是否弹卡问人。**默认 false**：越线就换便宜模型继续跑，绝不挂起请求
   * ——挂起的请求会让一整轮任务停在原地，用户以为卡死了。
   * 打开之后才走「弹卡 → 等你点」的流程。
   */
  askOnTrip: false,
  /** 降到哪个模型。provider 留空 = 只在同一 provider 内换模型名；model 留空 = 自动挑一个更便宜的。 */
  degradeTo: { provider: '', model: '' },
  /**
   * 供应商价目：{ 供应商 id: { multiplier, prices } }。
   * `multiplier` 乘在全局价目表的解析结果上（缺省 1），`prices` 是这家自己的价（优先、不再乘倍率）。
   * 第三方网关 / 中转站的价格差好几倍，靠它把同一模型名按线路分开算。
   */
  providers: {},
  /** 弹卡的等待秒数；到点按「降档继续」处理（不是停止）。 */
  decisionTimeoutSec: 30,
  /** 界面多久没来问过，就当没开界面：直接静默降档，不再挂起请求。 */
  clientSilenceSec: 45,
  /** 用户选了「停止本轮」之后，这个会话静默降档多久，避免每句话都弹卡。 */
  silentMinutes: 60,
  /**
   * 同一道闸（近一小时 / 今天）问过人之后，多少分钟内不再问第二遍。
   * 0 = 关掉这个行为（每轮越线都照常弹卡）。
   */
  scopeQuietMinutes: 60,
  /**
   * 流水与审计放哪个目录（绝对路径；相对路径按 <DSH_HOME> 解析）。
   * 空 = 跟默认目录一样（<DSH_HOME>/dsh-fuse）。
   * 注意：config.json 永远留在默认目录，不受这个字段影响。
   */
  dataDir: '',
  /** 右下角那枚小药丸（今日花费）。关掉就只剩弹卡。 */
  pill: true,
  /** 价目表覆盖：{ '模型名': { input, cacheRead, output } }，单位 = 元/百万 token。 */
  prices: {},
}

/** token 闸的上限：0 = 关掉；超过一万亿就当一万亿（够用，也不会把界面撑破）。 */
const MAX_TOKEN_CAP = 1e12

/** 外观只认这三个值；缺失、大写、乱字符一律回 'auto'（跟随系统）。 */
const APPEARANCES = ['auto', 'dark', 'light']

/**
 * 只认「数字」或「纯数字字符串」。
 *
 * 不能直接用 Number()：`Number(true)` 是 1、`Number([])` 是 0，
 * 手改配置时写错一个类型就会变成「上限 ¥1」这种把人挡在外面的值。
 */
function numberish(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return Number.NaN
}

/**
 * 布尔字段：JSON 里写成字符串的 `"false"` 也要认。
 * 不认的话用户明明关了熔断，闸门还在拦 —— 这比配置写错更让人困惑。
 */
function boolish(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : fallback
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (['false', '0', 'no', 'off'].includes(text)) return false
    if (['true', '1', 'yes', 'on'].includes(text)) return true
  }
  return fallback
}

/** 只接受「普通对象」：数组会被 spread 出 "0" / "1" 这种键，绝不能当配置用。 */
function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/** token 阈值：0..MAX_TOKEN_CAP 的整数，坏值回默认。 */
function tokenCap(value, fallback) {
  const n = numberish(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.min(Math.floor(n), MAX_TOKEN_CAP)
}

/**
 * 供应商表归一：只留 `{ multiplier, prices }`。
 * 倍率缺省 1（非法值也按 1），价目表走 sanitizePrices（坏价目宁可丢掉也不能变成 0 元），
 * 其它字段丢掉，免得脏数据又被写回配置文件。
 */
export function normalizeProviders(raw) {
  const out = {}
  const table = plainObject(raw)
  if (table === null) return out
  for (const [id, entry] of Object.entries(table)) {
    const key = String(id ?? '').trim()
    if (key === '') continue
    const value = plainObject(entry)
    if (value === null) continue
    const multiplier = numberish(value.multiplier)
    out[key] = {
      multiplier: Number.isFinite(multiplier) && multiplier > 0 ? Math.min(multiplier, 1000) : 1,
      prices: sanitizePrices(value.prices),
    }
  }
  return out
}

/** 深合并默认值：缺字段补、多字段留，坏字段一律归一回默认。 */
export function normalizeConfig(raw) {
  const base = structuredClone(DEFAULT_CONFIG)
  // 数组 / 字符串 / null 都当「没填」：数组会被 spread 出 "0"、"1" 这种键，
  // 一旦写回配置文件，下次读起来就是一串来路不明的设置。
  const value = plainObject(raw) ?? {}
  const out = { ...base, ...value }
  out.caps = { ...base.caps, ...(plainObject(value.caps) ?? {}) }
  out.capsTokens = { ...base.capsTokens, ...(plainObject(value.capsTokens) ?? {}) }
  out.degradeTo = { ...base.degradeTo, ...(plainObject(value.degradeTo) ?? {}) }
  // 价目表必须过一遍 sanitizePrices：`{input: NaN}` 落盘会变成 null，
  // 读回来再算就是 0 元 —— 那条线路从此免费，闸门再也拦不住。
  out.prices = sanitizePrices(value.prices ?? base.prices)
  // 供应商是「二级」结构：供应商 → { multiplier, prices }，这里一并归一。
  out.providers = normalizeProviders(value.providers)
  for (const key of ['turn', 'hour', 'day']) {
    const n = numberish(out.caps[key])
    out.caps[key] = Number.isFinite(n) && n >= 0 ? n : base.caps[key]
    out.capsTokens[key] = tokenCap(out.capsTokens[key], base.capsTokens[key])
  }
  const ratio = numberish(out.warnRatio)
  out.warnRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : base.warnRatio
  const timeout = numberish(out.decisionTimeoutSec)
  out.decisionTimeoutSec = Number.isFinite(timeout) && timeout >= 0 ? Math.min(timeout, 600) : base.decisionTimeoutSec
  const silence = numberish(out.clientSilenceSec)
  out.clientSilenceSec = Number.isFinite(silence) && silence >= 0 ? Math.min(silence, 3600) : base.clientSilenceSec
  const silentMin = numberish(out.silentMinutes)
  out.silentMinutes = Number.isFinite(silentMin) && silentMin >= 0 ? Math.min(silentMin, 24 * 60) : base.silentMinutes
  // 静默期：0 到 1440 分钟（一天）。填负数 / 乱字符就当没填，回默认的一小时。
  const quietMin = numberish(out.scopeQuietMinutes)
  out.scopeQuietMinutes =
    Number.isFinite(quietMin) && quietMin >= 0 ? Math.min(quietMin, 24 * 60) : base.scopeQuietMinutes
  // 数据目录：只认字符串，两边空格去掉；别的类型一律当没填（跟默认目录）。
  out.dataDir = typeof out.dataDir === 'string' ? out.dataDir.trim() : base.dataDir
  out.currency = typeof out.currency === 'string' && out.currency !== '' ? out.currency : base.currency
  out.degradeTo.model = typeof out.degradeTo.model === 'string' ? out.degradeTo.model : base.degradeTo.model
  out.degradeTo.provider = typeof out.degradeTo.provider === 'string' ? out.degradeTo.provider : ''
  // 开关类：手改配置写成 "false" 的也要真的关掉，不能因为字符串是真值就继续拦人。
  out.enabled = boolish(out.enabled, base.enabled)
  out.autoDegrade = boolish(out.autoDegrade, base.autoDegrade)
  out.askOnTrip = boolish(out.askOnTrip, base.askOnTrip)
  out.pill = boolish(out.pill, base.pill)
  // 外观是标量：直接覆盖，但只认三个值。
  out.appearance = APPEARANCES.includes(out.appearance) ? out.appearance : base.appearance
  return out
}

/**
 * 一座闸门。
 *
 * @param {object} options
 * @param {ReturnType<import('./ledger.js').createLedger>} options.ledger
 * @param {() => object} options.getConfig  实时读设置（面板改完立刻生效）
 * @param {() => number} [options.now]
 * @param {(message:string, error?:unknown) => void} [options.warn]
 */
export function createFuse({ ledger, getConfig, now = () => Date.now(), warn = () => {} }) {
  /** 每个会话的状态：本轮是否已降档、本轮是否已放行、静默到几点。 */
  const sessions = new Map()
  /** 会话状态上限：正常用几十个，留 500 足够，同时不至于长跑一夜就涨成泄漏。 */
  const MAX_SESSIONS = 500
  /** 界面最后一次来问的时间；用来判断「有没有人看着」。 */
  let lastClientAt = 0
  /** 正在等回答的卡，按 id 索引。 */
  const pending = new Map()
  let nextId = 1

  function stateOf(sessionId) {
    const key = String(sessionId ?? '')
    const known = sessions.get(key)
    if (known !== undefined) {
      // 碰一下就挪到末尾：淘汰时先丢最久没动静的那个会话。
      sessions.delete(key)
      sessions.set(key, known)
      return known
    }
    const state = {
      degradeUntilTurnEnd: false,
      bypassTurn: false,
      silentUntil: 0,
      model: '',
      provider: '',
      /** 上一次 check() 命中的是哪道闸（plan 没拿到 trip 时靠它）。 */
      lastScope: '',
      /** 上一次命中的是金额还是 token（审计与界面都用得上）。 */
      lastUnit: '',
      /** 每道闸上次「问过人」的时间戳：{ hour: 0, day: 0 }。turn 闸不参与。 */
      askedAt: {},
    }
    sessions.set(key, state)
    // 子代理、临时会话会一茬茬开新的；不设上限，这张表会跟着长一整晚。
    if (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined && oldest !== key) sessions.delete(oldest)
    }
    return state
  }

  /** 最近一个真正发过请求的会话：界面不知道该看哪个会话时，就看它。 */
  let lastSid = ''

  /** 记下这个会话最近一次请求实际用的模型（用量事件本身不带模型）。 */
  function noteModel(sessionId, provider, model) {
    const state = stateOf(sessionId)
    lastSid = String(sessionId ?? '')
    if (typeof provider === 'string' && provider !== '') state.provider = provider
    if (typeof model === 'string' && model !== '') state.model = model
  }

  /** 这个会话最近一次实际用的模型名（记账时按它查价）。 */
  function modelOf(sessionId) {
    return stateOf(sessionId).model
  }

  /** 这个会话最近一次实际走的供应商（记账时按它挑供应商价 / 倍率）。 */
  function providerOf(sessionId) {
    return stateOf(sessionId).provider
  }

  /** 新的一轮：单轮额度清零，逐轮的两个开关复位。 */
  function noteTurnStart(sessionId) {
    ledger.startTurn(sessionId)
    const state = stateOf(sessionId)
    state.degradeUntilTurnEnd = false
    state.bypassTurn = false
    // 静默期跨轮保留：用户刚点过「停止」，下一句不该立刻再弹一张卡。
  }

  /** 会话被关掉：把它那份状态扔掉，别让 Map 长成泄漏。 */
  function forget(sessionId) {
    sessions.delete(String(sessionId ?? ''))
  }

  /** 界面来说话了（每次轮询都记一下）。 */
  function touchClient() {
    lastClientAt = now()
  }

  /** 界面上次说话有多久了。 */
  function clientIdleMs() {
    if (lastClientAt === 0) return Number.POSITIVE_INFINITY
    return now() - lastClientAt
  }

  /**
   * 这一刻该不该拦。
   *
   * 同一个窗口先比金额、再比 token（哪个先超就报哪个），窗口顺序仍是 turn → hour → day。
   *
   * @param {string} sessionId
   * @returns {null | {scope:'turn'|'hour'|'day', unit:'money'|'tokens', spent:number, cap:number, currency:string}}
   */
  function check(sessionId) {
    const config = getConfig()
    if (config.enabled === false) return null
    const state = stateOf(sessionId)
    if (state.bypassTurn) return null
    const spend = ledger.spend(sessionId) ?? {}
    const tokens = spend.tokens ?? {}
    const currency = config.currency
    for (const scope of ['turn', 'hour', 'day']) {
      const cap = Number(config.caps?.[scope])
      if (Number.isFinite(cap) && cap > 0) {
        const spent = Number(spend[scope] ?? 0)
        if (spent > cap) {
          state.lastScope = scope
          state.lastUnit = 'money'
          return { scope, unit: 'money', spent, cap, currency }
        }
      }
      // token 闸：不知道单价也能用；同一个窗口金额没超，才轮到它。
      // 配置里写的是「万 token」，账上记的是 token，这里换算成同一个单位再比，
      // 报出去也统一用 token（界面按万显示），否则会出现「77.6万 / 1」这种自相矛盾的行。
      const capWan = Number(config.capsTokens?.[scope])
      if (Number.isFinite(capWan) && capWan > 0) {
        const cap = capWan * 10000
        const used = Number(tokens[scope] ?? 0)
        if (used > cap) {
          state.lastScope = scope
          state.lastUnit = 'tokens'
          return { scope, unit: 'tokens', spent: used, cap, currency }
        }
      }
    }
    state.lastScope = ''
    state.lastUnit = ''
    return null
  }

  /**
   * 这道闸离「可以再问一次」还有多少毫秒。
   * 只有 hour / day 参与：turn 闸每轮重置，问过一次也留不住。
   *
   * @returns {number} >0 表示还在静默期里，<=0 表示可以再问
   */
  function quietLeftMs(state, scope, config) {
    if (scope !== 'hour' && scope !== 'day') return 0
    const minutes = Number(config.scopeQuietMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return 0
    const at = Number(state.askedAt?.[scope] ?? 0)
    if (!Number.isFinite(at) || at <= 0) return 0
    return at + minutes * 60000 - now()
  }

  /**
   * 越线之后的动作：'silent-pass' | 'silent-degrade' | 'card'（交给钩子去挂起）。
   *
   * @param {string} sessionId
   * @param {{scope:string}} [trip]  check() 的返回值；不传就用上一次 check() 命中的那道闸
   */
  function plan(sessionId, trip) {
    const state = stateOf(sessionId)
    const config = getConfig()
    // 关掉了就不该有任何动作：宁可多放一次，也不能在用户已经关掉熔断之后还拦人。
    if (config.enabled === false) return 'silent-pass'
    if (state.degradeUntilTurnEnd) return 'silent-degrade'
    if (state.silentUntil > now()) return 'silent-degrade'
    // 同一道闸刚问过人：这次别问了，原样放行（下一轮还在静默期就继续放行）。
    const scope = String(trip?.scope ?? state.lastScope ?? '')
    if (quietLeftMs(state, scope, config) > 0) return 'silent-pass'
    // 默认不问人：越线就换便宜模型接着跑。挂起请求会把一整轮任务钉在原地，
    // 用户只会觉得「插件把我的任务停了」——这是这个插件最不能犯的错。
    // 只有用户主动打开「越线先问我一嘴」，或者关掉了自动降档，才走弹卡。
    const ask = config.askOnTrip === true || config.autoDegrade === false
    if (ask !== true) return 'silent-degrade'
    // 没人看着界面的时候，挂起请求只会白等 30 秒：直接静默降档。
    if (clientIdleMs() > Number(config.clientSilenceSec) * 1000) return 'silent-degrade'
    return 'card'
  }

  /**
   * 降档目标（跟当前模型相同就没意义，返回 null 让钩子什么都不做）。
   *
   * 返回的是一份**模型选择**，不是一份改好的请求配置：宿主在提示词组装之前
   * 就把这一步的路由钉死了，请求里改 provider/model 会被整步拒绝。调用方
   * 拿它去走 `agent.model.select()`，由宿主自己记一笔「下一步用这个」。
   *
   * @param {string} sessionId
   * @param {{provider?:string, model?:string}|undefined|null} current
   * @returns {{provider:string, model:string}|null}
   */
  function degradeTarget(sessionId, current) {
    const config = getConfig()
    const to = config.degradeTo ?? {}
    const model = typeof to.model === 'string' ? to.model.trim() : ''
    const here = typeof current?.provider === 'string' ? current.provider : ''
    if (model !== '') {
      if (model === current?.model) return null
      // provider 留空 = 沿用当前选择的那条线路，不要凭猜写回一个供应商。
      const provider = typeof to.provider === 'string' && to.provider !== '' ? to.provider : here
      return { provider: typeof provider === 'string' ? provider : '', model }
    }
    // 没指定目标：从「见过的型号」里自动挑一个输入、输出都比现在便宜的，
    // 让默认路径也能降得下来（否则只剩弹卡，又会把请求挂住）。
    if (typeof ledger?.models !== 'function') return null
    const prices = config.prices ?? {}
    const providers = config.providers ?? {}
    // 「这条线路上真跑过」的型号排在前面：第三方网关往往说不上来自己有哪些模型，
    // 流水才是硬证据。目录拿得到时，最终能不能换由 index.js 再判一次。
    const onLine = typeof ledger.modelsOn === 'function' ? ledger.modelsOn(here) : []
    const seen = Array.isArray(ledger.models()) ? ledger.models() : []
    const models = [...new Set([...(Array.isArray(onLine) ? onLine : []), ...seen])]
    if (models.length === 0) return null
    const nowPrice = priceFor(current?.model ?? '', prices, { provider: here, providers })
    let best = null
    for (const candidate of models) {
      if (typeof candidate !== 'string' || candidate === '' || candidate === current?.model) continue
      const price = priceFor(candidate, prices, { provider: here, providers })
      if (!(price.input < nowPrice.input && price.output < nowPrice.output)) continue
      const sum = price.input + price.output
      if (best === null || sum < best.sum) best = { model: candidate, sum }
    }
    if (best === null) return null
    return { provider: here, model: best.model }
  }

  /**
   * 挂一张卡，等界面回答。
   *
   * @param {object} options
   * @param {string} options.sessionId
   * @param {{scope:string, unit?:'money'|'tokens', spent:number, cap:number, currency:string}} options.trip
   * @param {{provider:string, model:string}} options.current
   * @returns {Promise<'pass'|'degrade'|'stop'>}
   */
  function ask({ sessionId, trip, current }) {
    const config = getConfig()
    const sid = String(sessionId ?? '')
    // 同一个会话已经有卡挂着：把这一发也挂到同一张卡上，等同一个回答。
    // 以前是「新建一张再把旧的那张顶掉」，人工选完只剩一发拿到结果，
    // 另一发早就按超时降档走了 —— 用户看到的和实际发生的不是一回事。
    for (const open of pending.values()) {
      if (open.sessionId !== sid) continue
      return new Promise((resolve) => {
        open.waiters.push(resolve)
      })
    }
    // 「问过人」从挂卡这一刻算起：哪怕这张卡到点超时，
    // 这道闸在一小时内也不会再问第二遍（这就是「同一件事别问两遍」的落点）。
    const state = stateOf(sid)
    const scope = String(trip?.scope ?? '')
    if (scope === 'hour' || scope === 'day') state.askedAt[scope] = now()
    const id = String(nextId++)
    const timeoutMs = Number(config.decisionTimeoutSec) * 1000
    return new Promise((resolve) => {
      const entry = {
        id,
        sessionId: sid,
        scope: trip.scope,
        unit: trip.unit === 'tokens' ? 'tokens' : 'money',
        spent: trip.spent,
        cap: trip.cap,
        currency: trip.currency,
        model: current?.model ?? '',
        provider: current?.provider ?? '',
        // 界面上要知道「降档能不能真的发生」：目标为空或等于当前模型时，中间那颗按钮
        // 的语义是「这一轮继续」，别在卡上画一个不会发生的降档。
        degradeTo: degradeTarget(sid, current)?.model ?? '',
        createdAt: now(),
        deadline: now() + timeoutMs,
        /** 等这张卡的人（可能不止一发请求）。 */
        waiters: [resolve],
        settle(action, reason) {
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(entry.timer)
          if (reason !== undefined) entry.reason = reason
          const waiting = entry.waiters
          entry.waiters = []
          for (const waiter of waiting) waiter(action)
        },
      }
      entry.timer = setTimeout(() => {
        entry.settle('degrade', 'timeout')
      }, timeoutMs)
      // 这个定时器**不能** unref：它是「挂起的请求最终一定会被放行」的唯一保证。
      // unref 掉之后，一旦宿主那边恰好没有别的句柄，Node 会直接退出，
      // 而那个 await 着的请求就永远停在那里了（自检里踩过一次）。
      pending.set(id, entry)
    })
  }

  /** 界面点了某个按钮。 */
  function decide(id, action) {
    const entry = pending.get(String(id))
    if (entry === undefined) return false
    if (action !== 'pass' && action !== 'degrade' && action !== 'stop') return false
    entry.settle(action, 'user')
    return true
  }

  /** 给界面看的待决定列表（一次只显示最早的一张）。 */
  function pendingList() {
    return [...pending.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => ({
        id: entry.id,
        sessionId: entry.sessionId,
        scope: entry.scope,
        unit: entry.unit,
        spent: entry.spent,
        cap: entry.cap,
        currency: entry.currency,
        model: entry.model,
        degradeTo: entry.degradeTo,
        deadline: entry.deadline,
        remainingMs: Math.max(0, entry.deadline - now()),
      }))
  }

  /** 有人回答了「停止」之后，让这个会话安静一会儿。 */
  function silence(sessionId) {
    const config = getConfig()
    stateOf(sessionId).silentUntil = now() + Number(config.silentMinutes) * 60000
  }

  /** 有人选了「降档」：这一轮后面都别再问。 */
  function markDegraded(sessionId) {
    stateOf(sessionId).degradeUntilTurnEnd = true
  }

  /** 有人选了「放行一次」：这一轮不再拦。 */
  function markBypass(sessionId) {
    stateOf(sessionId).bypassTurn = true
  }

  /**
   * 给界面看的「这道闸刚问过、还要静默多久」：{ hour: 秒, day: 秒 }。
   * 没有静默中的闸就是空对象（界面用 Object.keys 判空即可）。
   */
  function quietOf(sessionId) {
    const config = getConfig()
    const key = String(sessionId ?? '') || lastSid
    const state = sessions.get(key)
    if (state === undefined) return {}
    const out = {}
    for (const scope of ['hour', 'day']) {
      const left = quietLeftMs(state, scope, config)
      if (left > 0) out[scope] = Math.ceil(left / 1000)
    }
    return out
  }

  /** 给界面的一屏状态。 */
  function snapshot(sessionId) {
    const config = getConfig()
    const sid = String(sessionId ?? '') || lastSid
    const money = ledger.spend(sid)
    return {
      enabled: config.enabled !== false,
      currency: config.currency,
      caps: config.caps,
      capsTokens: config.capsTokens,
      // 外观与供应商表是前端要用的：一个决定深/浅色，一个给「按供应商计价」做面板。
      appearance: config.appearance,
      providers: config.providers,
      warnRatio: config.warnRatio,
      pill: config.pill !== false,
      spend: money,
      day: dayKey(now()),
      clientSilenceSec: config.clientSilenceSec,
      scopeQuietMinutes: config.scopeQuietMinutes,
      quiet: quietOf(sid),
      pending: pendingList(),
    }
  }

  /**
   * 放掉挂着的卡（配置被关掉、插件卸载时用）。
   *
   * 这不是「替用户做决定」：'release' 只让请求拿着原配置继续走，
   * 不降档、不停止、也不写审计 —— 熔断已经关了，就不该还有人在等一张卡。
   */
  function release(action = 'release', reason = 'release') {
    for (const entry of [...pending.values()]) entry.settle(action, reason)
  }

  /** 只放掉某个会话的卡（别的会话还在等人回答，不能一起动）。 */
  function releaseSession(sessionId, action = 'release', reason = 'release') {
    const sid = String(sessionId ?? '')
    for (const entry of [...pending.values()]) {
      if (entry.sessionId === sid) entry.settle(action, reason)
    }
  }

  /** 卸载：把所有挂着的卡按降档放掉，别让请求永远停在那里。 */
  function dispose() {
    release('degrade', 'dispose')
    pending.clear()
  }

  return {
    noteModel,
    modelOf,
    providerOf,
    noteTurnStart,
    forget,
    touchClient,
    clientIdleMs,
    check,
    plan,
    degradeTarget,
    ask,
    decide,
    pendingList,
    silence,
    markDegraded,
    markBypass,
    quietOf,
    release,
    releaseSession,
    snapshot,
    dispose,
    /** 自检用：看一眼两张表有没有长到失控。 */
    stats: () => ({ sessions: sessions.size, pending: pending.size }),
  }
}
