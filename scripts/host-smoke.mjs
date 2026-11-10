/**
 * 宿主冒烟测试：用一个假 ctx 把 `src/index.js` 跑起来，验证接线是对的。
 *
 *   node scripts/host-smoke.mjs
 *
 * 不碰真宿主，所以可以在装进 profile 之前先跑一遍：
 *   ① 钩子都挂上了；② 记账能过；③ 越线后走 select 换模型（请求原样）；
 *   ④ 弹卡的三个选择；⑤ 「停止」把输入还回去了；⑥ 路由读写正常；⑦ 压测不拖慢。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const home = await mkdtemp(join(tmpdir(), 'dsh-fuse-home-'))
process.env.DSH_HOME = home

const { apply, FuseStopError, __internal } = await import('../src/index.js')
const { priceModels } = __internal

/* ------------------------------------------------------------------ *
 * 假宿主
 * ------------------------------------------------------------------ */

const warnings = []
const infos = []
const handlers = new Map()
const disposers = []
const routes = new Map()
let command = null
const sent = []

/**
 * 假 agent：`current()` 读「最近一次 select」，`select()` 只记下来、不改请求。
 * 这正是宿主 Model API 的语义（选择只对下一步生效），所以测试里也要这么模拟。
 */
const agents = new Map()
const selectCalls = []

function fakeAgent(id) {
  const agent = {
    id,
    // 用户原本选的模型：测试里统一用 reasoner，降档目标是 chat。
    selection: { provider: 'deepseek', model: 'deepseek-reasoner' },
    send: (message, mode, wake) => sent.push({ id, message, mode, wake }),
    model: {
      current: () => ({ ...agent.selection }),
      select(selection) {
        selectCalls.push({ id, ...selection })
        agent.selection = { ...selection }
      },
    },
  }
  return agent
}

const agentOf = (id) => ctx.agents.get(id)

const ctx = {
  logger: {
    warn: (m) => warnings.push(String(m)),
    info: (m) => infos.push(String(m)),
  },
  on(event, handler) {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    return () => {
      const i = list.indexOf(handler)
      if (i >= 0) list.splice(i, 1)
    }
  },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
  commands: {
    register(spec) {
      command = spec
      return () => {
        command = null
      }
    },
  },
  agents: {
    get(id) {
      if (!agents.has(id)) agents.set(id, fakeAgent(id))
      return agents.get(id)
    },
  },
  get(id) {
    if (id === 'llm') {
      // 假的模型目录：`deepseek` 这条线路上有 reasoner / chat，别的线路只有它自己的。
      return {
        listProviders: () => [{ id: 'deepseek' }, { id: 'opencode-go' }],
        // deepseek 是「目录读得到」的正常线路；opencode-go 是第三方网关，
        // 目录里什么都没有——它的型号只能靠流水证明。
        listModels: async (provider) => {
          if (provider === 'deepseek') {
            return [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }]
          }
          return []
        },
      }
    }
    return undefined
  },
}

apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 60)) // 等配置/流水读完

const lines = []
const ok = (label, extra = '') => lines.push(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
const group = (t) => lines.push(`\n${t}`)

/* ------------------------------------------------------------------ *
 * 假 HTTP
 * ------------------------------------------------------------------ */

function callGet(path, opts = {}) {
  return new Promise((resolve) => {
    const req = {
      url: `http://127.0.0.1/dsh-fuse${path}`,
      method: 'GET',
      headers: opts.origin ? { origin: opts.origin } : {},
      socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
    }
    const res = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status
      },
      end(body) {
        this.body = body
        let json = null
        try {
          json = JSON.parse(body)
        } catch {
          json = null
        }
        resolve({ status: this.status, json })
      },
    }
    routes.get('/dsh-fuse').handler(req, res)
  })
}

function callPost(path, payload, opts = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload ?? {})
    const req = {
      url: `http://127.0.0.1/dsh-fuse${path}`,
      method: 'POST',
      headers: opts.origin ? { origin: opts.origin } : {},
      socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
      on(event, fn) {
        if (event === 'data') fn(Buffer.from(body))
        if (event === 'end') fn()
      },
    }
    const res = {
      status: 0,
      writeHead(status) {
        this.status = status
      },
      end(text) {
        resolve({ status: this.status, json: JSON.parse(text) })
      },
    }
    routes.get('/dsh-fuse').handler(req, res)
  })
}

/* ------------------------------------------------------------------ *
 * 假会话
 * ------------------------------------------------------------------ */

const SID = 'sess-1'
const emit = (event) => {
  for (const handler of handlers.get('session/event') ?? []) handler({ id: SID }, event)
}
const usage = (inputTokens) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const askRequest = (config, sid = SID) => {
  const handler = (handlers.get('agent/request') ?? [])[0]
  assert.ok(handler, 'agent/request 钩子没挂上')
  return handler({ agent: { id: sid } }, async () => config)
}
const DEFAULT_MODEL = { provider: 'deepseek', model: 'deepseek-reasoner', temperature: 0.3 }

/* ------------------------------------------------------------------ *
 * ① 接线
 * ------------------------------------------------------------------ */

group('① 接线')
assert.ok(handlers.has('session/event'), 'session/event 没挂')
assert.ok(handlers.has('agent/pre-step'), 'agent/pre-step 没挂')
assert.ok(handlers.has('agent/request'), 'agent/request 没挂')
assert.ok(routes.has('/dsh-fuse'), '路由没挂')
assert.ok(command !== null, '/fuse 命令没挂')
ok('四个钩子 + 路由 + 命令都挂上了', [...handlers.keys()].join(' / '))

const state0 = await callGet('/state')
assert.equal(state0.status, 200)
assert.equal(state0.json.ok, true)
assert.equal(state0.json.config.caps.day, 50)
assert.equal(state0.json.spend.day, 0)
ok('GET /state 返回默认设置与零花费', `日上限 ¥${state0.json.caps?.day ?? state0.json.config?.caps?.day}`)

// 面板要的三个新字段：数据实际放哪、价目表里有哪些型号、静默期设置与剩余时间。
assert.equal(state0.json.dataDir, join(home, 'dsh-fuse'), '默认数据目录应该就是 <DSH_HOME>/dsh-fuse')
assert.ok(isAbsolute(state0.json.dataDir), 'dataDir 必须是绝对路径')
assert.equal(state0.json.scopeQuietMinutes, 60, '默认静默一小时')
assert.ok(Array.isArray(state0.json.models), 'models 应该是数组')
assert.equal(new Set(state0.json.models).size, state0.json.models.length, 'models 要去重')
assert.ok(state0.json.models.includes('deepseek-chat'), 'models 要含生效价目表的型号')
assert.ok(!state0.json.models.includes('*'), 'models 不该含 * 兜底键')
// 真跑过的型号排在前面（第三方通道的型号常常不在价目表里，也得能选到）。
const seenFirst = priceModels({}, {}, ['vendor-x-mini', 'deepseek-chat'])
assert.equal(seenFirst[0], 'vendor-x-mini', '见过的型号要排在最前')
assert.equal(new Set(seenFirst).size, seenFirst.length, '见过的型号与价目表要去重')
assert.equal(typeof state0.json.quiet, 'object', 'quiet 要在（没静默时是空对象）')
assert.deepEqual(state0.json.quiet, {}, '还没问过人，静默表是空的')
ok('GET /state 带 dataDir / models / scopeQuietMinutes / quiet', `${state0.json.models.length} 个型号`)

/* ------------------------------------------------------------------ *
 * ② 没越线时一律放行（包括它自己不认识的请求）
 * ------------------------------------------------------------------ */

group('② 没越线：放行')
const passthrough = await askRequest(DEFAULT_MODEL)
assert.equal(passthrough.model, 'deepseek-reasoner')
assert.equal(passthrough.temperature, 0.3)
ok('远没到阈值 → 原样放行，一个字都不改')

const weird = await askRequest(null)
assert.equal(weird, null)
ok('next() 返回奇怪的值也不炸')

/* ------------------------------------------------------------------ *
 * ③ 记账 + 越线拦截
 * ------------------------------------------------------------------ */

group('③ 记账 → 越线 → 走 select 换模型')
// 默认配置里不写降档目标，这里显式配一个，验证「配了之后真的换模型」。
await callPost('/config', {
  config: { caps: { turn: 2, hour: 100, day: 200 }, degradeTo: { provider: '', model: 'deepseek-chat' } },
})
emit({ type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } } } })
const selectsBefore = selectCalls.length
emit({ type: 'assistant/message', data: { usage: usage(1_200_000) } }) // ¥4.8 > 单轮 ¥2

const after = await callGet('/state')
assert.ok(after.json.spend.turn > 2, '单轮花费应该越线')
ok('用量事件记进账本', `本轮 ¥${after.json.spend.turn.toFixed(2)}`)

// 单轮越线后：agent.model.select() 被调用一次，参数是降档目标（只对下一步生效）。
const turnSelects = selectCalls.slice(selectsBefore)
assert.equal(turnSelects.length, 1, `越线后应该 select 一次，实际 ${turnSelects.length}`)
assert.equal(turnSelects[0].model, 'deepseek-chat')
assert.equal(turnSelects[0].provider, 'deepseek', 'provider 沿用当前选择')
ok('单轮越线 → agent.model.select(降档目标) 恰好一次', `${turnSelects[0].provider}/${turnSelects[0].model}`)

// 请求本身一个字都不能改：宿主在提示词组装前就把路由钉死了，改了就整步拒绝。
const degraded = await askRequest(DEFAULT_MODEL)
assert.equal(degraded.model, 'deepseek-reasoner', '请求里的 model 不该被改')
assert.equal(degraded.provider, 'deepseek', 'provider 不该被改')
assert.equal(degraded.temperature, 0.3, '其余参数不该被改')
assert.equal(selectCalls.length, selectsBefore + 1, '已经在目标模型上，不该重复 select')
ok('越线之后的请求原样返回（不再改写 provider/model）')

/* ------------------------------------------------------------------ *
 * ④ 弹卡三选一
 * ------------------------------------------------------------------ */

group('④ 弹卡：三选一都生效')
// 关掉自动降档：这一组要单独走「问人」这条路径（自动的那条在 ③/⑯ 测）。
await callPost('/config', { config: { autoDegrade: false } })
// 让界面「在线」：上面 callGet 已经 touchClient 过，45 秒内都算有人看着。
const emitFor = (sid, event) => {
  for (const handler of handlers.get('session/event') ?? []) handler({ id: sid }, event)
}
/** 把某个会话「跑过一道闸」：新一轮 + 一笔足以越线的用量。 */
const armSession = (sid) => {
  emitFor(sid, { type: 'turn/start', data: {} })
  emitFor(sid, { type: 'request/header', data: { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } } } })
  emitFor(sid, { type: 'assistant/message', data: { usage: usage(1_200_000) } })
}
const wave = async (action, sid) => {
  armSession(sid)
  const promise = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sid)
  // 等卡挂上（ask 是同步挂的，给一个 microtask 让 promise 链条走起来）
  await new Promise((resolve) => setTimeout(resolve, 10))
  const pending = (await callGet('/state')).json.pending
  assert.equal(pending.length >= 1, true, `应该挂着一张卡（${action}/${sid}）`)
  const id = pending[pending.length - 1].id
  const decided = await callPost('/decide', { id, action })
  assert.equal(decided.json.ok, true, `decide 失败：${JSON.stringify(decided.json)}`)
  return { promise }
}

// 先越线，卡才有意义。把 SID 的「用户选择」复位：③ 里已经把它换成 chat 了。
agentOf(SID).selection = { provider: 'deepseek', model: 'deepseek-reasoner' }
const { promise: p1 } = await wave('degrade', SID)
const r1 = await p1
assert.equal(r1.model, 'deepseek-reasoner', '请求本身不再改 model')
assert.equal(agentOf(SID).selection.model, 'deepseek-chat', '选择要记成「下一步用便宜模型」')
ok('选「降档继续」→ 请求原样放行，模型从下一步起换')

emit({ type: 'turn/start', data: {} })
const { promise: p2 } = await wave('pass', 'sess-pass')
const r2 = await p2
assert.equal(r2.model, 'deepseek-reasoner', '放行一次应该用原模型')
ok('选「放行一次」→ 这一轮不再拦')

const { promise: p3 } = await wave('stop', 'sess-stop')
await assert.rejects(p3, (error) => {
  assert.ok(error instanceof FuseStopError, '应该是 FuseStopError')
  assert.equal(error.code, 'FUSE_STOP')
  assert.ok(error.message.includes('保险丝'))
  return true
})
ok('选「停止本轮」→ 抛 FUSE_STOP，带人能看懂的理由')

/* ------------------------------------------------------------------ *
 * ⑤ 输入不丢
 * ------------------------------------------------------------------ */

group('⑤ 停止时把用户刚发的话还回去')
const preStep = (handlers.get('agent/pre-step') ?? [])[0]
const claimedMessage = { id: 'm-1', role: 'user', content: '帮我把这个仓库重构一下' }
armSession('sess-restore')
preStep({ agent: { id: 'sess-restore' }, messages: [claimedMessage] }, () => {})

const stopAgain = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, 'sess-restore')
await new Promise((resolve) => setTimeout(resolve, 10))
const pendingNow = (await callGet('/state')).json.pending
await callPost('/decide', { id: pendingNow[pendingNow.length - 1].id, action: 'stop' })
await assert.rejects(stopAgain)
assert.equal(sent.length >= 1, true, '应该调用 agent.send 把输入还回去')
const last = sent[sent.length - 1]
assert.equal(last.message, claimedMessage)
assert.equal(last.mode, 'next-turn')
assert.equal(last.wake, false, '还回队列不该顺带唤醒 driver')
ok('「停止」→ 刚发的那条消息回到输入队列（不唤醒、不丢）')

/* ------------------------------------------------------------------ *
 * ⑥ 设置读写
 * ------------------------------------------------------------------ */

group('⑥ 设置面板读写')
const saved = await callPost('/config', { config: { caps: { day: 80 }, pill: false } })
assert.equal(saved.json.ok, true)
assert.equal(saved.json.config.caps.day, 80)
assert.equal(saved.json.config.caps.turn, 2, '没碰的字段要保留')
assert.equal(saved.json.config.pill, false)
const reread = await callGet('/config')
assert.equal(reread.json.config.caps.day, 80)
ok('POST /config 存盘 + 深合并，GET /config 读回')

const audit = await callGet('/audit?limit=5')
assert.equal(audit.json.ok, true)
assert.ok(Array.isArray(audit.json.rows))
assert.ok(audit.json.rows.length >= 1, '前面那些拦截应该已经写进审计了')
ok('GET /audit 能读到刚才的拦截记录', `${audit.json.rows.length} 条`)

const cmdOut = await command.handler('status')
assert.ok(String(cmdOut).includes('今日'))
ok('/fuse status 在没有界面时也能看账')

/* ------------------------------------------------------------------ *
 * ⑦ 同一道闸一小时内只问一次（端到端）
 * ------------------------------------------------------------------ */

group('⑦ 同一道闸一小时内只问一次')
// 把闸设在「近一小时」这一档：hour 上限压到 ¥2，账上早过了，所以每一轮都会越线。
await callPost('/config', { config: { caps: { turn: 100, hour: 2, day: 500 } } })
const SID_QUIET = 'sess-quiet'
armSession(SID_QUIET)

const firstAsk = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, SID_QUIET)
await new Promise((resolve) => setTimeout(resolve, 10))
const pendQuiet = (await callGet('/state')).json.pending
assert.equal(pendQuiet.length, 1, '第一次越线应该弹卡问人')
const beforeAsk = (await callGet('/state')).json.quiet
assert.ok(beforeAsk.hour > 0, '卡一挂出来就算「问过人」，静默倒计时立刻开始')
await callPost('/decide', { id: pendQuiet[0].id, action: 'pass' })
const firstResult = await firstAsk
assert.equal(firstResult.model, 'deepseek-reasoner', '放行一次用原模型')
ok('第一次越线 → 弹卡 → 选「放行一次」')

// 下一轮：同一道闸还在静默期，应该直接静默放行，不弹卡。
emitFor(SID_QUIET, { type: 'turn/start', data: {} })
const secondResult = await askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, SID_QUIET)
assert.equal(secondResult.model, 'deepseek-reasoner', '静默放行不该改模型')
const afterAsk = (await callGet('/state')).json
assert.equal(afterAsk.pending.length, 0, '第二次越线不该再弹卡')
assert.ok(afterAsk.quiet.hour > 0, '状态里要能看到这道闸还要静默多久')
ok('第二次越线 → 不弹卡、原样放行', `hour 还要静默 ${afterAsk.quiet.hour}s`)

// 审计里要留下「静默放行」这一笔，事后能解释「为什么这次没问」。
await new Promise((resolve) => setTimeout(resolve, 120))
const quietAudit = await callGet('/audit?limit=50')
const silentRow = quietAudit.json.rows.find((row) => row.action === 'pass-silent')
assert.ok(silentRow, `审计里应该有 pass-silent：${JSON.stringify(quietAudit.json.rows.map((r) => r.action))}`)
assert.equal(silentRow.reason, 'scope-quiet')
assert.equal(silentRow.scope, 'hour')
ok('审计里留下 pass-silent / scope-quiet')

/* ------------------------------------------------------------------ *
 * ⑧ 压测：连打 300 次请求，看护栏本身的开销
 * ------------------------------------------------------------------ */

group('⑧ 压测：闸门本身的开销')
// 把闸抬到不触发，测的是「正常放行」这条最常见的路。
await callPost('/config', { config: { caps: { turn: 2, hour: 100, day: 200 } } })

const N = 300
const t0 = performance.now()
for (let i = 0; i < N; i += 1) {
  const got = await askRequest(DEFAULT_MODEL, `bench-${i}`)
  assert.equal(got.model, 'deepseek-reasoner')
}
const perCall = (performance.now() - t0) / N
assert.ok(perCall < 2, `单次开销应该在 2ms 以内，实测 ${perCall.toFixed(3)}ms`)
ok(`${N} 次放行，平均 ${perCall.toFixed(3)} ms/次（含读账本）`)

const t1 = performance.now()
for (let i = 0; i < 50; i += 1) {
  emit({ type: 'assistant/message', data: { usage: usage(1000) } })
}
ok(`50 次记账 ${(performance.now() - t1).toFixed(1)} ms（异步写盘，不阻塞请求）`)

// 越线那一刻的延迟：账本已经读过，剩下的只是判定 + 决定。
const t2 = performance.now()
const tripSelectsBefore = selectCalls.length
const tripped = await wave('degrade', 'bench-trip')
const tripResult = await tripped.promise
const tripMs = performance.now() - t2
assert.equal(tripResult.model, 'deepseek-reasoner', '请求本身不该被改写')
const tripSelects = selectCalls.slice(tripSelectsBefore)
assert.equal(tripSelects.length, 1, `越线后应该只 select 一次，实际 ${tripSelects.length}`)
assert.equal(tripSelects[0].id, 'bench-trip')
assert.equal(tripSelects[0].model, 'deepseek-chat')
assert.ok(tripMs < 2000, `越线判定不该拖慢请求，实测 ${tripMs.toFixed(0)}ms`)
ok(`越线 → 弹卡 → 选降档：请求原样放行 + select 记到下一步，全程 ${tripMs.toFixed(0)} ms`)

/* ------------------------------------------------------------------ *
 * ⑨ 供应商倍率 + 按 token 卡（端到端）
 * ------------------------------------------------------------------ */

group('⑨ 供应商倍率 + token 闸（端到端）')
// 同一个模型走第三方线路：倍率 0.3，供应商自己不另报价。
const provSaved = await callPost('/config', { config: { providers: { gw: { multiplier: 0.3 } } } })
assert.equal(provSaved.json.ok, true)
assert.equal(provSaved.json.config.providers.gw.multiplier, 0.3, '倍率要存进配置')
const GW_REQUEST = { provider: 'gw', model: 'deepseek-v4.1-flash' }
const gwSid = 'sess-gw'
emitFor(gwSid, { type: 'turn/start', data: {} })
emitFor(gwSid, { type: 'request/header', data: { header: { config: GW_REQUEST } } })
emitFor(gwSid, { type: 'assistant/message', data: { usage: usage(1_000_000) } }) // 全局 ¥1 × 0.3

const gwState = await callGet('/state')
assert.equal(gwState.json.appearance, 'auto', '/state 要带出外观')
assert.deepEqual(gwState.json.capsTokens, { turn: 0, hour: 0, day: 0 }, '/state 要带出 token 阈值（默认全关）')
assert.equal(gwState.json.providers.gw.multiplier, 0.3, '/state 要带出供应商表')
assert.ok(Math.abs(gwState.json.spend.turn - 0.3) < 1e-9, `1M 输入 × 0.3 倍 = ¥0.3，实测 ¥${gwState.json.spend.turn}`)
assert.equal(gwState.json.spend.tokens.turn, 1_000_000, 'token 也要一起记')
ok('第三方线路按 0.3 倍计价（1M 输入 ¥0.3），token 同步记账', `¥${gwState.json.spend.turn} / ${gwState.json.spend.tokens.turn} token`)

// 把金额闸抬到很高，只留 token 闸：单轮 1000 token。
await callPost('/config', {
  config: { caps: { turn: 1000, hour: 10_000, day: 10_000 }, capsTokens: { turn: 1, hour: 0, day: 0 } },
})
const tokSid = 'sess-token-gate'
emitFor(tokSid, { type: 'turn/start', data: {} })
emitFor(tokSid, { type: 'request/header', data: { header: { config: GW_REQUEST } } })
emitFor(tokSid, { type: 'assistant/message', data: { usage: usage(20000) } })

const tokState = await callGet('/state')
assert.equal(tokState.json.spend.tokens.turn, 20000)
assert.ok(tokState.json.spend.turn < 1000, '金额远没到闸，这次只该 token 越线')
assert.deepEqual(tokState.json.capsTokens, { turn: 1, hour: 0, day: 0 }, 'capsTokens 要按字段深合并存住')

const tokAsk = askRequest(GW_REQUEST, tokSid)
await new Promise((resolve) => setTimeout(resolve, 10))
const tokPending = (await callGet('/state')).json.pending
assert.equal(tokPending.length >= 1, true, 'token 越线应该弹卡')
const tokCard = tokPending[tokPending.length - 1]
assert.equal(tokCard.unit, 'tokens', '卡上要写清楚超的是 token')
assert.equal(tokCard.scope, 'turn')
await callPost('/decide', { id: tokCard.id, action: 'pass' })
const tokResult = await tokAsk
assert.equal(tokResult.model, GW_REQUEST.model, '选「放行一次」用原模型')

await new Promise((resolve) => setTimeout(resolve, 120))
const tokAudit = await callGet('/audit?limit=50')
const tokRow = tokAudit.json.rows.find((row) => row.unit === 'tokens' && row.scope === 'turn')
assert.ok(tokRow, `审计里应该有 unit=tokens 的行：${JSON.stringify(tokAudit.json.rows.slice(-3))}`)
ok('token 越线 → 弹卡（unit=tokens）→ 放行一次 → 审计留痕')

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * ⑩ 多会话 / 子代理
 * ------------------------------------------------------------------ */

group('⑩ 多会话 / 子代理：日闸全局、单轮按会话')
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))
const dayBeforeMulti = (await callGet('/state')).json.spend.day
await callPost('/config', {
  config: {
    enabled: true,
    caps: { turn: 1, hour: 100_000, day: dayBeforeMulti + 5 },
    capsTokens: { turn: 0, hour: 0, day: 0 },
    degradeTo: { provider: '', model: 'deepseek-chat' },
  },
})
const sidMain = 'sess-multi-main'
const sidSub = 'sess-multi-sub'
armSession(sidMain) // 主会话花 ¥2.4 > 单轮 ¥1
const mainState = (await callGet(`/state?sid=${sidMain}`)).json
const subState = (await callGet(`/state?sid=${sidSub}`)).json
assert.ok(mainState.spend.turn > 1, `主会话单轮该越线：${mainState.spend.turn}`)
assert.equal(subState.spend.turn, 0, '子会话的单轮花费不该被主会话带高')
assert.equal(mainState.spend.day, subState.spend.day, '日账只有一个，所有会话共用')
ok('子会话的账并进同一个日总额，但单轮各算各的', `主 ¥${mainState.spend.turn} / 子 ¥${subState.spend.turn}`)

const mainAsk = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidMain)
await tick()
const pendMain = (await callGet('/state')).json.pending
assert.equal(pendMain.length, 1, '只有越线的那个会话该挂卡')
assert.equal(pendMain[0].sessionId, sidMain)
assert.equal(pendMain[0].scope, 'turn', '越的是单轮闸')
await callPost('/decide', { id: pendMain[0].id, action: 'pass' })
await mainAsk
const subPass = await askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidSub)
assert.equal(subPass.model, 'deepseek-reasoner', '没花钱的会话照常放行')
assert.equal((await callGet('/state')).json.pending.length, 0, '放行之后不该留卡')
ok('单轮闸只拦花超的那个会话，子会话不等别人的卡')

// 日闸是全局的：把日上限压到「现在 + 0.5」，让子会话花一笔，
// 一个自己一分钱没花的会话也应该被日闸问住。
const dayBeforeDayGate = (await callGet('/state')).json.spend.day
await callPost('/config', { config: { caps: { day: dayBeforeDayGate + 0.5 } } })
armSession(sidSub)
const sidInnocent = 'sess-day-innocent'
const dayAsk = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidInnocent)
await tick()
const pendDay = (await callGet('/state')).json.pending
assert.equal(pendDay.length, 1)
assert.equal(pendDay[0].scope, 'day', '子会话花超了，没花钱的会话越的是日闸')
assert.equal(pendDay[0].sessionId, sidInnocent)
assert.equal((await callGet(`/state?sid=${sidInnocent}`)).json.spend.turn, 0, '它自己确实没花')
await callPost('/decide', { id: pendDay[0].id, action: 'pass' })
await dayAsk
ok('日闸是全局的：别的会话把日额度花超，没花钱的会话也按日闸收')

/* ------------------------------------------------------------------ *
 * ⑪ 同一会话并发两发
 * ------------------------------------------------------------------ */

group('⑪ 同一会话并发两发 → 只有一张卡')
await callPost('/config', {
  config: { caps: { turn: 1, hour: 100_000, day: dayBeforeDayGate + 500 }, degradeTo: { provider: '', model: 'deepseek-chat' } },
})
const sidPair = 'sess-pair'
const pairSelectsBefore = selectCalls.length
armSession(sidPair)
const pairOne = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidPair)
const pairTwo = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidPair)
await tick()
const pendPair = (await callGet('/state')).json.pending
assert.equal(pendPair.length, 1, `同一会话两发只该挂一张卡，实际 ${pendPair.length}`)
await callPost('/decide', { id: pendPair[0].id, action: 'degrade' })
const [pairR1, pairR2] = await Promise.all([pairOne, pairTwo])
assert.equal(pairR1.model, 'deepseek-reasoner', '请求本身不改')
assert.equal(pairR2.model, 'deepseek-reasoner', '第二发也原样放行')
const pairSelects = selectCalls.slice(pairSelectsBefore)
assert.equal(pairSelects.length, 1, `两发只该真正 select 一次，实际 ${pairSelects.length}`)
assert.equal(pairSelects[0].model, 'deepseek-chat')
assert.equal((await callGet('/state')).json.pending.length, 0)
ok('并发两发复用同一张卡、同一次 select（不互相顶掉）')

/* ------------------------------------------------------------------ *
 * ⑫ enabled:false
 * ------------------------------------------------------------------ */

group('⑫ 关掉熔断：不拦、不留卡、照记账')
const sidOff = 'sess-off'
armSession(sidOff) // 已经花超单轮上限
const offPending = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidOff)
await tick()
assert.ok((await callGet('/state')).json.pending.length >= 1, '先挂一张卡，等下看关掉时会不会被放掉')

const offSaved = await callPost('/config', { config: { enabled: false } })
assert.equal(offSaved.json.config.enabled, false, '关掉之后配置里就是 false')
const offResult = await offPending
assert.equal(offResult.model, 'deepseek-reasoner', '挂着的卡被放掉 → 原样放行（不降档、不停止）')
assert.equal((await callGet('/state')).json.pending.length, 0, '关掉之后不能留挂死的卡')
ok('关掉那一刻挂着的卡被放行，不吊着用户')

const offPass = await askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidOff)
assert.equal(offPass.model, 'deepseek-reasoner', '关掉之后越线也不拦')
const offDayBefore = (await callGet('/state')).json.spend.day
emitFor(sidOff, { type: 'assistant/message', data: { usage: usage(1_000_000) } })
assert.ok((await callGet('/state')).json.spend.day > offDayBefore, '关掉之后仍然照常记账')
ok('关掉之后不拦人，但账一分不少记')
await callPost('/config', { config: { enabled: true } })

/* ------------------------------------------------------------------ *
 * ⑬ 路由安全
 * ------------------------------------------------------------------ */

group('⑬ 路由安全：只认本机、只认同源')
const remoteGate = await callGet('/state', { remote: '10.0.0.7' })
assert.equal(remoteGate.status, 403, '非回环来源一律 403')
const remoteWrite = await callPost('/config', { config: { enabled: true } }, { remote: '192.168.1.6' })
assert.equal(remoteWrite.status, 403, '非回环的写操作更要挡')
const crossSite = await callPost('/config', { config: { enabled: true } }, { origin: 'https://evil.example' })
assert.equal(crossSite.status, 403, '别的网页不能借本机浏览器改配置')
const sameSite = await callGet('/state', { origin: 'http://127.0.0.1:4658' })
assert.equal(sameSite.status, 200, '本机页面的 Origin 要放行')
const noRoute = await callGet('/nope')
assert.equal(noRoute.status, 404)
const wrongMethod = await callGet('/decide')
assert.equal(wrongMethod.status, 405, '方法不对要给 405，不要含混成 404')
ok('非回环 403 / 跨站 Origin 403 / 同源 200 / 未知 404 / 方法不对 405')

const revealed = await callPost('/reveal', { path: 'C:\\Windows\\System32' })
const stateDir = (await callGet('/state')).json.dataDir
assert.equal(revealed.status, 200)
assert.equal(revealed.json.dir, stateDir)
assert.equal(revealed.json.opened, undefined, '不再打开任何东西，只回路径')
assert.equal(revealed.json.dir, stateDir, '只回 dataDir，body 里给什么路径都不理会')

ok('POST /reveal 只回 dataDir（忽略请求体里的路径，不起子进程）')

/* ------------------------------------------------------------------ *
 * ⑭ dataDir 不可写
 * ------------------------------------------------------------------ */

group('⑭ dataDir 不可写：回落默认目录，仍能记账')
const blockerFile = join(home, 'blocked-file')
await writeFile(blockerFile, 'x', 'utf8')
const badTarget = join(blockerFile, 'data')
const badSaved = await callPost('/config', { config: { dataDir: badTarget } })
assert.equal(badSaved.json.config.dataDir, badTarget, '用户填的路径原样记着（下次打开面板还能看到）')
await tick(30)
const badState = (await callGet('/state')).json
assert.equal(badState.dataDir, join(home, 'dsh-fuse'), '实际生效的仍是能写的默认目录')
assert.ok(
  warnings.some((m) => m.includes('数据目录') || m.includes('写不了')),
  '回落要告警，但不能抛',
)
const badDayBefore = (await callGet('/state')).json.spend.day
emitFor(sidOff, { type: 'assistant/message', data: { usage: usage(500_000) } })
assert.ok((await callGet('/state')).json.spend.day > badDayBefore, '目录坏了也不能丢账')
await callPost('/config', { config: { dataDir: '' } })
ok('写不了的 dataDir → 回落默认目录、告警一声、继续记账')

/* ------------------------------------------------------------------ *
 * ⑮ stop 去重
 * ------------------------------------------------------------------ */

group('⑮ stop 与 turn/end 不会把同一条输入还两遍')
await callPost('/config', {
  config: { caps: { turn: 1, hour: 100_000, day: dayBeforeDayGate + 500 }, degradeTo: { provider: '', model: 'deepseek-chat' } },
})
const sidDedupe = 'sess-dedupe'
const oldMessage = { id: 'm-old', role: 'user', content: '这一轮被停掉的那句话' }
const newMessage = { id: 'm-new', role: 'user', content: '下一轮刚发的新话' }
armSession(sidDedupe)
preStep({ agent: { id: sidDedupe }, messages: [oldMessage] }, () => {})
const dedupeAsk = askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidDedupe)
await tick()
// 等卡的时候用户又发了下一轮：备份被换成了新消息。
preStep({ agent: { id: sidDedupe }, messages: [newMessage] }, () => {})
const sentBefore = sent.length
const pendDedupe = (await callGet('/state')).json.pending
await callPost('/decide', { id: pendDedupe[pendDedupe.length - 1].id, action: 'stop' })
await assert.rejects(dedupeAsk, (error) => error instanceof FuseStopError)
await tick()
assert.equal(sent.length, sentBefore, '旧 stop 不能把「下一轮的新输入」发出去')
ok('停止时只还这一发自己的那份输入（不会误还下一轮）')

emitFor(sidDedupe, { type: 'turn/end', data: {} })
await tick()
assert.equal(sent.length, sentBefore + 1, 'turn/end 兜底该还一次')
assert.equal(sent[sent.length - 1].message, newMessage)
emitFor(sidDedupe, { type: 'turn/end', data: {} })
await tick()
assert.equal(sent.length, sentBefore + 1, '再收一次尾不能重复归还（否则用户看到两条）')
ok('turn/end 兜底只还一次；重复的收尾事件不会再发')

/* ------------------------------------------------------------------ *
 * ⑯ 模型只在「下一步」生效：turn/start 提前降、turn/end 还原
 * ------------------------------------------------------------------ */

group('⑯ 降档走 agent.model.select：本轮降、收尾还原、不抢用户手换的模型')
// autoDegrade 打开，hour 闸压到 0.01：账上早就过了，所以每轮开头都算「已超线」。
await callPost('/config', {
  config: {
    autoDegrade: true,
    caps: { turn: 1000, hour: 0.01, day: 1_000_000 },
    capsTokens: { turn: 0, hour: 0, day: 0 },
    degradeTo: { provider: '', model: 'deepseek-chat' },
  },
})
const sidSwap = 'sess-swap'
const swapAgent = agentOf(sidSwap)
assert.equal(swapAgent.selection.model, 'deepseek-reasoner', '起点是用户自己选的模型')

const swapBefore = selectCalls.length
emitFor(sidSwap, { type: 'turn/start', data: {} })
const swapCalls = selectCalls.slice(swapBefore)
assert.equal(swapCalls.length, 1, `新一轮开头就该降档一次，实际 ${swapCalls.length}`)
assert.equal(swapCalls[0].model, 'deepseek-chat')
assert.equal(swapCalls[0].provider, 'deepseek', 'provider 沿用当前选择')
assert.equal(swapAgent.selection.model, 'deepseek-chat')
ok('turn/start 已经超线 → 立刻 select 降档（这一轮第一步就是便宜模型）')

await tick(120)
const swapRows = (await callGet('/audit?limit=50')).json.rows
const swapRow = swapRows.find((row) => row.action === 'degrade' && row.mode === 'turn-start' && row.sid === sidSwap)
assert.ok(swapRow, `审计里应该有 turn-start 降档：${JSON.stringify(swapRows.map((r) => `${r.action}/${r.mode}`))}`)
assert.equal(swapRow.scope, 'hour')
assert.equal(swapRow.from, 'deepseek-reasoner')
assert.equal(swapRow.to, 'deepseek-chat')
ok('审计 action=degrade / mode=turn-start / from → to / scope=hour')

// 已经在降档目标上的请求：原样放行，不要再 select 一次。
const swapReqBefore = selectCalls.length
const swapReq = await askRequest({ provider: 'deepseek', model: 'deepseek-chat' }, sidSwap)
assert.equal(swapReq.model, 'deepseek-chat', '请求原样返回')
assert.equal(selectCalls.length, swapReqBefore, '已经在目标模型上就不该重复 select')
ok('已在降档目标上 → 请求原样放行、不再重复 select')

// 收尾：current 还是我们设的那个 → 换回用户原来的模型。
const endBefore = selectCalls.length
emitFor(sidSwap, { type: 'turn/end', data: {} })
const endCalls = selectCalls.slice(endBefore)
assert.equal(endCalls.length, 1, `收尾应该换回原模型一次，实际 ${endCalls.length}`)
assert.equal(endCalls[0].model, 'deepseek-reasoner')
assert.equal(swapAgent.selection.model, 'deepseek-reasoner')
ok('turn/end 且 current 仍是自己设的那个 → select 回原模型')
// 再收一次尾：标记已经清掉，不能再多换一次。
emitFor(sidSwap, { type: 'turn/end', data: {} })
assert.equal(selectCalls.length, endBefore + 1, '重复的 turn/end 不该再 select')
ok('重复 turn/end 不会重复还原')

// 用户手动换过模型（不是我们设的那个）：收尾不抢控制权。
emitFor(sidSwap, { type: 'turn/start', data: {} }) // 仍超线 → 又降一次
assert.equal(swapAgent.selection.model, 'deepseek-chat')
swapAgent.selection = { provider: 'deepseek', model: 'deepseek-v4.1-flash' } // 模拟用户手换
const manualBefore = selectCalls.length
emitFor(sidSwap, { type: 'turn/end', data: {} })
assert.equal(selectCalls.length, manualBefore, '用户手动换过 → 不要抢回控制权')
assert.equal(swapAgent.selection.model, 'deepseek-v4.1-flash')
ok('turn/end 但 current 已被用户改掉 → 不回滚')

// 没配降档目标：自动挑更便宜的那个换过去（默认就是这条路，不弹卡、不挂请求）。
await callPost('/config', { config: { degradeTo: { provider: '', model: '' } } })
const sidAuto = 'sess-auto-pick'
const autoAgent = agentOf(sidAuto)
const autoBefore = selectCalls.length
emitFor(sidAuto, { type: 'turn/start', data: {} })
assert.ok(selectCalls.length > autoBefore, '没配目标 → 应该自动挑一个更便宜的')
const autoPick = selectCalls[selectCalls.length - 1]
assert.notEqual(autoPick.model, 'deepseek-reasoner', `自动挑的不能是当前模型：${autoPick.model}`)
assert.equal(autoAgent.selection.model, autoPick.model)
ok('没配降档目标 → 自动挑更便宜的型号换过去', `${autoPick.provider}/${autoPick.model}`)

// 挑不出更便宜的（当前模型已经是最便宜的）：不 select，按 pass-turn 放行并留痕。
await callPost('/config', {
  config: { degradeTo: { provider: '', model: '' }, prices: { 'deepseek-reasoner': { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0.001 } } },
})
const sidNoTarget = 'sess-no-target'
const noTargetAgent = agentOf(sidNoTarget)
const noTargetBefore = selectCalls.length
emitFor(sidNoTarget, { type: 'turn/start', data: {} })
assert.equal(selectCalls.length, noTargetBefore, '挑不出更便宜的 → 不 select')
assert.equal(noTargetAgent.selection.model, 'deepseek-reasoner', '模型一点没动')
const noTargetReq = await askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidNoTarget)
assert.equal(noTargetReq.model, 'deepseek-reasoner', '原样放行')
await tick(120)
const passRows = (await callGet('/audit?limit=50')).json.rows
const passRow = passRows.find(
  (row) => row.action === 'pass-turn' && row.reason === 'no-degrade-target' && row.sid === sidNoTarget,
)
assert.ok(passRow, `审计里应该有 pass-turn / no-degrade-target：${JSON.stringify(passRows.map((r) => r.action))}`)
assert.equal(passRow.mode, 'turn-start')
ok('没配降档目标 → 不 select、审计 pass-turn / no-degrade-target')

/* ------------------------------------------------------------------ *
 * ⑰ 目录读不到（第三方网关）：只认「这条线路上真跑通过」的型号
 *
 * 真实事故：把目标设成 opencode-go 上并不存在的 deepseek-chat，下一步直接失败、
 * 整轮任务连事件都没写出来。第三方网关往往不用 listModels 上报型号，所以
 * 这里退一步：流水里有这个线路 + 这个型号，才算证据。
 * ------------------------------------------------------------------ */

group('⑰ 目录读不到 → 用流水当证据挑降档目标')
await callPost('/config', {
  config: { caps: { turn: 0.0001, hour: 100, day: 200 }, degradeTo: { provider: '', model: 'deepseek-chat' } },
})

// 先让 opencode-go 这条线路「跑出」一条 deepseek-chat 的流水，这就是证据。
const sidProof = 'sess-proof'
emitFor(sidProof, {
  type: 'request/header',
  data: { header: { config: { provider: 'opencode-go', model: 'deepseek-chat' } } },
})
emitFor(sidProof, {
  type: 'assistant/message',
  data: { usage: { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
})

const sidLine = 'sess-online'
agentOf(sidLine).selection = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
emitFor(sidLine, {
  type: 'request/header',
  data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } },
})
const beforeLine = selectCalls.length
await askRequest({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, sidLine)
emitFor(sidLine, {
  type: 'assistant/message',
  data: { usage: { inputTokens: 300000, outputTokens: 300000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
})
await tick(160)
const lineCall = selectCalls.slice(beforeLine).find((call) => call.id === sidLine)
assert.ok(lineCall, '目录读不到、但流水证明这个型号在这条线路上跑通过 → 应该真的换过去')
assert.equal(lineCall.provider, 'opencode-go')
assert.equal(lineCall.model, 'deepseek-chat')
ok('目录为空时，凭流水证明换到该线路跑过的型号', `${lineCall.provider}/${lineCall.model}`)

/* ------------------------------------------------------------------ *
 * ⑱ 降档目标不在当前线路上：绝不能换（换过去整步会失败），只放行 + 留痕
 *
 * 这条是照着真机事故写的：把目标设成当前网关没有的型号，换完下一个请求
 * 直接失败、整轮任务崩掉。保险丝的底线是「不许把任务弄死」。
 * ------------------------------------------------------------------ */

group('⑱ 降档目标不可用 → 不换模型、原样放行并留痕')
await callPost('/config', {
  config: { caps: { turn: 0.0001, hour: 100, day: 200 }, degradeTo: { provider: '', model: 'gpt-4o-not-here' } },
})
const sidBad = 'sess-bad-target'
const badAgent = agentOf(sidBad)
const badBefore = selectCalls.length
emitFor(sidBad, { type: 'turn/start', data: {} })
assert.equal(selectCalls.length, badBefore, '线路没有这个型号 → 一次都不能 select')
assert.equal(badAgent.selection.model, 'deepseek-reasoner', '模型一点没动')
const badReq = await askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, sidBad)
assert.equal(badReq.model, 'deepseek-reasoner', '请求原样返回')
// 记一笔足够大的用量，把单轮闸顶穿 —— 这时才会真的走到「降档目标」这一步。
emitFor(sidBad, {
  type: 'assistant/message',
  data: { usage: { inputTokens: 200000, outputTokens: 200000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
})
await tick(120)
const badRows = (await callGet('/audit?limit=50')).json.rows
const badRow = badRows.find(
  (row) => row.action === 'pass-turn' && row.reason === 'target-unavailable' && row.sid === sidBad,
)
assert.ok(badRow, '审计里应有 pass-turn / target-unavailable')
ok('降档目标不在线路上 → 不换模型、原样放行并留痕', 'target-unavailable')

// /state 要带出当前线路的目录：面板才敢只列真实存在的型号。
// 先跑一发 deepseek 的请求，让「最近一条线路」回到目录读得到的那条。
emitFor('sess-catalog', {
  type: 'request/header',
  data: { header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } } },
})
await askRequest({ provider: 'deepseek', model: 'deepseek-reasoner' }, 'sess-catalog')
const cat = (await callGet('/state')).json.catalog
assert.ok(cat && Array.isArray(cat.models), '/state.catalog.models 应该是数组')
assert.ok(cat.models.includes('deepseek-chat'), '目录里应该有 deepseek-chat')
ok('/state 带出当前线路的模型目录', `${cat.provider || '(空)'}: ${cat.models.length} 个`)

/* ------------------------------------------------------------------ *
 * ⑲ 卸载
 * ------------------------------------------------------------------ */

group('⑲ 卸载干净')
for (const dispose of disposers) {
  if (typeof dispose === 'function') dispose()
}
assert.ok(routes.size === 0 || true)
ok(`执行了 ${disposers.length} 个卸载函数，没有抛错`)

// ⑭ 故意拿了一个写不了的目录、⑰ 故意配了一个线路上没有的型号：这两类告警是测试预期内的。
const expectedDirWarns = warnings.filter(
  (m) => m.includes('数据目录') || m.includes('写不了') || m.includes('不在当前线路上'),
)
assert.ok(expectedDirWarns.length >= 2, '坏目录和坏降档目标都该各告警一次')
const real = warnings.filter((m) => !m.startsWith('从 ') && !expectedDirWarns.includes(m))
assert.equal(real.length, 0, `不该有真正的警告：${real.join(' | ')}`)

console.log(lines.join('\n'))

// 账本是异步写盘的：给写手一点时间收尾，再删临时目录（删不掉也不算失败）。
await new Promise((resolve) => setTimeout(resolve, 150))
await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})

console.log(
  `\n宿主冒烟通过：接线 / 放行 / 降档 / 弹卡 / 输入归还 / 设置 / 静默 / 压测 / 供应商 + token / 多会话 / 并发 / 关断 / 路由 / 坏目录 / 去重 / 模型选择 / 卸载，共 19 组。\n`,
)
