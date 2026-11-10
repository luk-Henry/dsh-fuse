/**
 * 自检：不连宿主，离线跑一遍「保险丝」的账本与闸门逻辑。
 *
 *   node scripts/selftest.mjs
 *
 * 覆盖：用量归一化 → 折算成钱 → 三道闸的判定顺序 → 弹卡/静默降档两条路径
 * → 真降档的返回值 → 审计落盘 → 重启后日额度还在 → 同一道闸的静默期
 * → 数据目录可换 / 坏路径回落。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { costOf, createLedger, dayKey, normalizeUsage, priceFor } from '../src/ledger.js'
import { createFuse, DEFAULT_CONFIG, normalizeConfig } from '../src/fuse.js'
import { __internal, chooseDataDir } from '../src/index.js'

const lines = []
function ok(label, extra = '') {
  lines.push(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
}
function group(title) {
  lines.push(`\n${title}`)
}

const round4 = (n) => Math.round(n * 10000) / 10000

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-fuse-test-'))
  const warnings = []

  group('① 用量归一化')
  const a = normalizeUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })
  assert.equal(a.input, 1_000_000)
  assert.equal(a.output, 1_000_000)
  assert.equal(a.cacheRead, 1_000_000)
  assert.equal(a.cacheWrite, 0)
  ok('DSH 归一化字段（inputTokens / outputTokens / cacheReadTokens）')

  const b = normalizeUsage({ prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } })
  assert.equal(b.input, 20, '输入应该扣掉命中缓存的部分')
  assert.equal(b.cacheRead, 100)
  assert.equal(b.output, 30)
  ok('OpenAI 原始字段（prompt_tokens 里含缓存命中）→ 自动拆出净输入', `${b.input}+${b.cacheRead}+${b.output}`)

  const c = normalizeUsage(null)
  assert.equal(c.input + c.output + c.cacheRead + c.cacheWrite, 0)
  ok('空 usage 不炸，记 0')

  group('② 折算成钱（元 / 百万 token）')
  const chatPrice = priceFor('deepseek-chat')
  assert.equal(round4(costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, chatPrice)), 2)
  assert.equal(round4(costOf({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, chatPrice)), 0.2)
  assert.equal(round4(costOf({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, chatPrice)), 3)
  ok('输入 ¥2 / 命中缓存 ¥0.2 / 输出 ¥3（每百万 token）')

  // 本机真实型号：按 cost-meter 的汇率把 opencode-go 报价折成人民币后的校准值。
  const flash = priceFor('deepseek-v4.1-flash')
  assert.equal(flash.input, 1)
  assert.equal(flash.cacheRead, 0.02)
  assert.equal(flash.output, 4)
  // 用校准价复算 cost-meter 2026-11-08 的日账：296 万输入 / 4692 万命中 / 46 万输出。
  const replay = costOf({ input: 2_962_714, cacheRead: 46_919_424, cacheWrite: 0, output: 460_914 }, flash)
  assert.ok(Math.abs(replay - 5.7488) < 0.02, `应复现 cost-meter 的 ¥5.7488，实际 ¥${round4(replay)}`)
  ok('本机型号价格与 cost-meter 对齐到分', `¥${round4(replay)} vs ¥5.7488`)

  const unknown = costOf({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, priceFor('some-third-party-model'))
  assert.ok(unknown > 0, '不认识的模型也要有个兜底价，不能算成免费')
  ok('不认识的模型按兜底价算（不会变成免费）', `¥${round4(unknown)}`)

  const prefixed = priceFor('deepseek-chat-0927')
  assert.equal(prefixed.input, 2, '带日期后缀的型号应该按前缀认出来')
  ok('前缀匹配（deepseek-chat-0927 认 deepseek-chat）')

  group('③ 三道闸的判定顺序')
  let config = normalizeConfig({ ...DEFAULT_CONFIG, caps: { turn: 2, hour: 8, day: 50 } })
  const ledger = createLedger({ dir, getPrices: () => config.prices, warn: (m) => warnings.push(m) })
  await ledger.load()

  const fuse = createFuse({ ledger, getConfig: () => config, warn: (m) => warnings.push(m) })
  const sid = 'session-test'

  fuse.noteModel(sid, 'deepseek', 'deepseek-chat')
  fuse.noteTurnStart(sid)
  ledger.record({ sessionId: sid, model: 'deepseek-chat', usage: { inputTokens: 1_100_000 } }) // ¥2.2

  const spend = ledger.spend(sid)
  assert.equal(round4(spend.turn), 2.2)
  assert.equal(round4(spend.hour), 2.2)
  assert.equal(round4(spend.day), 2.2)
  ok('一轮花了 ¥2.2，单轮 / 小时 / 日 三档都记上了')

  const trip = fuse.check(sid)
  assert.ok(trip, '应该越线')
  assert.equal(trip.scope, 'turn', '单轮最先触发')
  ok('最先触发的是「这一轮」（顺序 turn → hour → day）', `${trip.scope} ${round4(trip.spent)}/${trip.cap}`)

  fuse.noteTurnStart(sid)
  assert.equal(fuse.check(sid), null, '新一轮单轮清零后不该再拦')
  ok('新一轮开始后单轮额度清零，不再是熔断状态')

  // 把单轮闸放高，单独验证「一小时」这一档能不能接住连环爆。
  config = normalizeConfig({ ...config, caps: { turn: 100, hour: 8, day: 50 } })
  ledger.record({ sessionId: sid, model: 'deepseek-chat', usage: { inputTokens: 4_000_000 } }) // +¥8
  const trip2 = fuse.check(sid)
  assert.equal(trip2?.scope, 'hour', '一小时累计越线')
  ok('短时间连环爆 → 由「近一小时」接住', `${round4(trip2.spent)}/${trip2.cap}`)

  group('④ 弹卡 vs 静默降档')
  fuse.forget(sid)
  config = normalizeConfig({ ...config, caps: { turn: 1, hour: 100, day: 100 } })
  ledger.record({ sessionId: sid, model: 'deepseek-chat', usage: { inputTokens: 600_000 } }) // ¥1.2
  assert.ok(fuse.check(sid), '越线')

  assert.equal(fuse.clientIdleMs(), Number.POSITIVE_INFINITY, '界面从没来过')
  assert.equal(fuse.plan(sid), 'silent-degrade', '没人看着界面 → 静默降档')
  ok('界面 45 秒没动静 → 静默降档（不问人，也不停）')

  // 默认 askOnTrip=false：界面在线也不挂请求，直接降档（挂住会把整轮任务钉死）。
  fuse.touchClient()
  assert.equal(fuse.plan(sid), 'silent-degrade', '默认不问人 → 越线直接降档')
  ok('默认不弹卡：界面在线也直接降档，请求永不挂起')

  // 显式打开「越线先问我一嘴」，才走弹卡。
  config = normalizeConfig({ ...config, askOnTrip: true })
  assert.equal(fuse.plan(sid), 'card', '开了询问 → 弹卡')
  ok('打开 askOnTrip → 弹卡让人选')

  // 没配目标：自动挑一个输入/输出都比现在便宜的（ledger 里见过的型号）。
  config = normalizeConfig({ ...config, degradeTo: { provider: '', model: '' } })
  const auto = fuse.degradeTarget(sid, { provider: 'deepseek', model: 'deepseek-reasoner' })
  assert.equal(auto?.model, 'deepseek-chat', '自动挑更便宜的型号')
  assert.equal(auto?.provider, 'deepseek', 'provider 沿用当前线路')
  ok('没配降档目标 → 自动挑更便宜的型号', `${auto?.provider}/${auto?.model}`)

  config = normalizeConfig({ ...config, degradeTo: { provider: '', model: 'deepseek-chat' } })
  const target = fuse.degradeTarget(sid, { provider: 'deepseek', model: 'deepseek-reasoner' })
  assert.equal(target.model, 'deepseek-chat')
  assert.equal(target.provider, 'deepseek', 'provider 要保留，只换 model')
  // 行为变化：这不再是「一份改好的请求配置」（宿主会整步拒绝），只是一份模型选择。
  assert.deepEqual(Object.keys(target).sort(), ['model', 'provider'], '只带 provider/model，不再 spread 旧 config')
  ok('降档 = 只换 model、provider 留空则沿用当前（模型选择，不是改请求）', `${target.provider}/${target.model}`)

  group('⑤ 卡：选「降档」')
  const asking = fuse.ask({ sessionId: sid, trip: fuse.check(sid), current: { provider: 'deepseek', model: 'deepseek-reasoner' } })
  const pending = fuse.pendingList()
  assert.equal(pending.length, 1)
  assert.ok(pending[0].remainingMs > 0 && pending[0].remainingMs <= 30_000)
  assert.equal(pending[0].degradeTo, 'deepseek-chat')
  ok('挂起一张卡，带倒计时与降档目标', `${pending[0].remainingMs}ms`)

  assert.equal(fuse.decide(pending[0].id, 'degrade'), true)
  assert.equal(await asking, 'degrade')
  assert.equal(fuse.pendingList().length, 0)
  ok('点「降档」→ 卡收起，请求用降档后的模型继续')

  group('⑥ 卡：超时按降档收场')
  config = normalizeConfig({ ...config, decisionTimeoutSec: 0.15 })
  fuse.forget(sid)
  const asking2 = fuse.ask({ sessionId: sid, trip: { scope: 'turn', spent: 2, cap: 1, currency: '¥' }, current: {} })
  assert.equal(await asking2, 'degrade')
  assert.equal(fuse.pendingList().length, 0)
  ok('没人点 → 到点自动降档接着跑（不粗暴中断）')

  group('⑦ 卡：选「停止」与「放行一次」')
  const ask3 = fuse.ask({ sessionId: sid, trip: { scope: 'turn', spent: 2, cap: 1, currency: '¥' }, current: {} })
  assert.equal(fuse.decide(fuse.pendingList()[0].id, 'stop'), true)
  assert.equal(await ask3, 'stop')
  ok('选「停止本轮」→ 返回 stop（宿主侧把输入还回队列）')

  const ask4 = fuse.ask({ sessionId: 'session-b', trip: { scope: 'day', spent: 60, cap: 50, currency: '¥' }, current: {} })
  assert.equal(fuse.decide(fuse.pendingList()[0].id, 'pass'), true)
  assert.equal(await ask4, 'pass')
  ok('选「放行一次」→ 本轮放行，且只放行这一轮')

  group('⑧ 卸载/重装后日额度还在')
  await ledger.flush()
  const ledger2 = createLedger({ dir, getPrices: () => config.prices, warn: (m) => warnings.push(m) })
  await ledger2.load()
  const reloaded = ledger2.spend(sid)
  assert.ok(reloaded.day > 0, '重启后今日花费要读回来')
  ok('流水落盘（ledger-YYYY-MM-DD.jsonl），重启后日额度继续算', `今日 ¥${round4(reloaded.day)}`)

  // 回归：早上的花销不能因为「超过一小时」就从今日里消失。
  // （entries 只留最近一小时，日累计要单独记，否则跑满一小时后今日金额会自己缩水。）
  const oldDir = await mkdtemp(join(tmpdir(), 'dsh-fuse-old-'))
  const oldLedger = createLedger({ dir: oldDir, getPrices: () => config.prices, warn: () => {} })
  await oldLedger.load()
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000
  oldLedger.record({ sessionId: 'old', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 }, at: threeHoursAgo }) // ¥2（在今日内、但早于一小时）
  oldLedger.record({ sessionId: 'old', model: 'deepseek-chat', usage: { inputTokens: 500_000 } }) // ¥1（刚刚）
  await oldLedger.flush()
  const oldAgain = createLedger({ dir: oldDir, getPrices: () => config.prices, warn: () => {} })
  await oldAgain.load()
  const oldSpend = oldAgain.spend('old')
  assert.equal(round4(oldSpend.day), 3, '早上的账要算进今日')
  assert.equal(round4(oldSpend.hour), 1, '一小时窗口只算刚过去这一小时')
  ok('重启后「今日」接回整天的账，「近一小时」只算一小时', `今日 ¥${round4(oldSpend.day)} / 一小时 ¥${round4(oldSpend.hour)}`)
  await rm(oldDir, { recursive: true, force: true })

  group('⑨ 审计')
  await ledger.audit({ kind: 'fuse', action: 'stop', sid, scope: 'turn', spent: 2.31, cap: 2 })
  const month = new Date()
  const auditFile = join(dir, `audit-${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}.jsonl`)
  const auditText = await readFile(auditFile, 'utf8')
  const row = JSON.parse(auditText.trim().split('\n').pop())
  assert.equal(row.action, 'stop')
  assert.equal(row.spent, 2.31)
  assert.ok(typeof row.t === 'number')
  assert.ok(typeof row.at === 'string')
  ok('每次拦截写一行审计（时间 / 动作 / 额度 / 金额）')

  group('⑩ 坏配置不会把宿主带死')
  const broken = normalizeConfig({ caps: { turn: -5, day: 'abc' }, degradeTo: null, currency: '' })
  assert.ok(broken.caps.turn >= 0)
  assert.ok(Number.isFinite(broken.caps.day))
  assert.equal(broken.degradeTo.model, '', '默认不猜降档目标，留空')
  assert.equal(broken.currency, '¥')
  ok('阈值填错 / 字段缺失 → 逐项回落到安全默认值')

  group('⑪ 同一道闸一小时内只问一次')
  // 这一组单独开一本账、单独一个可拨的时钟，免得跟前面的用例互相干扰。
  const qdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-quiet-'))
  const qsid = 'session-quiet'
  let clock = Date.now()
  let qconfig = normalizeConfig({ caps: { turn: 100, hour: 100, day: 5 }, scopeQuietMinutes: 60, askOnTrip: true })
  const qledger = createLedger({
    dir: qdir,
    getPrices: () => qconfig.prices,
    now: () => clock,
    warn: (m) => warnings.push(m),
  })
  await qledger.load()
  const qfuse = createFuse({
    ledger: qledger,
    getConfig: () => qconfig,
    now: () => clock,
    warn: (m) => warnings.push(m),
  })
  qfuse.touchClient() // 界面在线，否则一律静默降档，看不到「问人」
  qfuse.noteTurnStart(qsid)
  qledger.record({ sessionId: qsid, model: 'deepseek-chat', usage: { inputTokens: 6_000_000 } }) // ¥12 > 日闸 ¥5

  const quietTrip = qfuse.check(qsid)
  assert.equal(quietTrip?.scope, 'day', '这一组用日闸验证静默')
  assert.equal(qfuse.plan(qsid, quietTrip), 'card', '第一次越线：该问人')
  const quietAsk = qfuse.ask({ sessionId: qsid, trip: quietTrip, current: { provider: 'deepseek', model: 'deepseek-chat' } })
  assert.equal(qfuse.decide(qfuse.pendingList()[0].id, 'pass'), true)
  assert.equal(await quietAsk, 'pass')
  ok('第一次越线照常弹卡（挂卡那一刻记下「问过人」的时间）')

  // ① 静默期内第二次越线 → silent-pass
  qfuse.noteTurnStart(qsid)
  const quietSnap = qfuse.snapshot(qsid)
  assert.equal(qfuse.plan(qsid, qfuse.check(qsid)), 'silent-pass', '同一道闸静默期内不该再问')
  assert.ok(quietSnap.quiet.day > 0, '快照里要能看到这道闸还在静默期')
  ok('静默期内第二次越线 → silent-pass（不弹卡、不降档）', `还要静默 ${quietSnap.quiet.day}s`)

  // ② 静默期过后 → 又回 card（把静默期缩到 1.2 秒，再把时钟往前拨 2 秒）
  qconfig = normalizeConfig({ ...qconfig, scopeQuietMinutes: 0.02 })
  qfuse.touchClient()
  clock += 2000
  assert.equal(qfuse.plan(qsid, qfuse.check(qsid)), 'card', '静默期过了就该再问一次')
  ok('静默期过后 → 又回 card（过一阵会重新问）')

  // ③ scopeQuietMinutes: 0 → 不静默
  qconfig = normalizeConfig({ ...qconfig, scopeQuietMinutes: 0 })
  const quietTrip3 = qfuse.check(qsid)
  const quietAsk3 = qfuse.ask({ sessionId: qsid, trip: quietTrip3, current: { provider: 'deepseek', model: 'deepseek-chat' } })
  qfuse.decide(qfuse.pendingList()[0].id, 'pass')
  await quietAsk3
  assert.equal(qfuse.plan(qsid, qfuse.check(qsid)), 'card', '关了静默就该每轮都问')
  ok('scopeQuietMinutes: 0 → 关闭静默（照旧弹卡）')

  // turn 闸不参与：它每轮重置，问过一次也留不住
  qfuse.forget(qsid)
  qconfig = normalizeConfig({ ...qconfig, scopeQuietMinutes: 60, caps: { turn: 1, hour: 100, day: 100 } })
  qfuse.touchClient()
  qfuse.noteTurnStart(qsid)
  qledger.record({ sessionId: qsid, model: 'deepseek-chat', usage: { inputTokens: 600_000 } }) // ¥1.2 > 单轮 ¥1
  const turnTrip = qfuse.check(qsid)
  assert.equal(turnTrip?.scope, 'turn')
  const turnAsk = qfuse.ask({ sessionId: qsid, trip: turnTrip, current: {} })
  qfuse.decide(qfuse.pendingList()[0].id, 'pass')
  await turnAsk
  assert.equal(qfuse.plan(qsid, qfuse.check(qsid)), 'card', 'turn 闸每轮重置，不该被静默')
  ok('turn 闸不参与静默（每轮照常问）')

  group('⑫ 数据目录可配')
  // ④ 切换 dataDir：新流水进新目录，旧目录不再增长
  const dirA = await mkdtemp(join(tmpdir(), 'dsh-fuse-data-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'dsh-fuse-data-b-'))
  const moving = createLedger({ dir: dirA, getPrices: () => config.prices, warn: (m) => warnings.push(m) })
  await moving.load()
  moving.record({ sessionId: 'move', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } }) // ¥2
  await moving.flush()

  const day = dayKey(Date.now())
  const fileA = join(dirA, `ledger-${day}.jsonl`)
  const fileB = join(dirB, `ledger-${day}.jsonl`)
  assert.equal((await readFile(fileA, 'utf8')).trim().split('\n').length, 1)

  await moving.relocate(dirB)
  assert.equal(moving.dir(), dirB)
  assert.equal(round4(moving.spend('move').day), 0, '换目录后以新目录的流水为准（新目录还是空的）')
  moving.record({ sessionId: 'move', model: 'deepseek-chat', usage: { inputTokens: 500_000 } }) // ¥1
  await moving.flush()

  assert.equal((await readFile(fileA, 'utf8')).trim().split('\n').length, 1, '旧目录不该再增长')
  assert.equal((await readFile(fileB, 'utf8')).trim().split('\n').length, 1, '新流水应该写进新目录')
  assert.equal(round4(moving.spend('move').day), 1, '新目录的流水要能读回来')
  ok('dataDir 切换后流水写进新目录、旧目录不再增长', `${dirA} → ${dirB}`)

  // ⑤ 非法 dataDir：回落默认目录，且不抛错（拿一个文件当目录用，必然建不出来）
  const blocker = join(dirA, 'not-a-dir')
  await writeFile(blocker, 'x', 'utf8')
  const dirWarnings = []
  const picked = await chooseDataDir(join(blocker, 'sub'), {
    home: dirA,
    warn: (m) => dirWarnings.push(String(m)),
  })
  assert.equal(picked, join(dirA, 'dsh-fuse'), '路径用不了就该回落到默认目录')
  assert.equal(dirWarnings.length, 1, '回落时要 warn 一声')
  ok('非法 dataDir → warn 一声回落到默认目录（不抛错）')

  // ⑥ normalizeConfig 对坏值兜底
  const badQuiet = normalizeConfig({ scopeQuietMinutes: -3, dataDir: 42 })
  assert.equal(badQuiet.scopeQuietMinutes, DEFAULT_CONFIG.scopeQuietMinutes, '负数静默期回默认')
  assert.equal(badQuiet.dataDir, '', '非字符串目录当没填')
  assert.equal(normalizeConfig({ scopeQuietMinutes: 'abc' }).scopeQuietMinutes, 60)
  assert.equal(normalizeConfig({ scopeQuietMinutes: 0 }).scopeQuietMinutes, 0, '0 是合法的「关掉」')
  assert.equal(normalizeConfig({ scopeQuietMinutes: 99999 }).scopeQuietMinutes, 1440, '超过一天就压到 1440')
  assert.equal(normalizeConfig({ dataDir: '  D:/fuse-data  ' }).dataDir, 'D:/fuse-data', '两边空格去掉')
  ok('normalizeConfig：静默期 0..1440、dataDir 只认字符串，坏值回落默认')

  await rm(qdir, { recursive: true, force: true })
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })

  group('⑬ 按供应商计价（第三方网关 / 中转站）')
  // ① 同一模型、不同线路：倍率乘在全局价上（base ¥1 → 0.3 倍 → ¥0.3）。
  const basePrice = priceFor('deepseek-v4.1-flash')
  const scaled = priceFor('deepseek-v4.1-flash', {}, { provider: 'gw', providers: { gw: { multiplier: 0.3 } } })
  assert.equal(basePrice.input, 1)
  assert.equal(round4(scaled.input), 0.3)
  assert.equal(round4(scaled.cacheRead), 0.006, '命中价也要一起乘倍率')
  ok('同一模型走不同供应商 → 倍率生效（¥1 → 0.3 倍 → ¥0.3）', `¥${round4(scaled.input)}`)

  // ② 供应商自己标的价优先，且不再乘倍率。
  const own = priceFor(
    'deepseek-v4.1-flash',
    {},
    {
      provider: 'cheap',
      providers: {
        cheap: { multiplier: 0.3, prices: { 'deepseek-v4.1-flash': { input: 0.05, output: 0.2 } } },
      },
    },
  )
  assert.equal(own.input, 0.05)
  assert.equal(own.output, 0.2)
  assert.equal(round4(own.cacheRead), 0.005, '只给输入的价目表要自动补命中价')
  ok('供应商自报价优先（倍率不再叠在它上面）', `¥${own.input} / ¥${own.output}`)

  // ③ 供应商价目表里同样走「精确 → 前缀 → *」；全局那条路的兜底价也乘倍率。
  const prefixOwn = priceFor(
    'deepseek-chat-0927',
    {},
    { provider: 'p', providers: { p: { prices: { 'deepseek-chat': { input: 9, output: 9 } } } } },
  )
  assert.equal(prefixOwn.input, 9, '供应商价目表里也要认前缀')
  const wildcardOwn = priceFor(
    'who-knows',
    {},
    { provider: 'p2', providers: { p2: { multiplier: 2, prices: { '*': { input: 5, output: 5 } } } } },
  )
  assert.equal(wildcardOwn.input, 5, '供应商的 * 命中即最终价')
  const fallbackScaled = priceFor('who-knows', {}, { provider: 'p3', providers: { p3: { multiplier: 0.5 } } })
  assert.equal(round4(fallbackScaled.input), 0.5, '认不出的型号走兜底价，也要乘倍率')
  ok('供应商层同样走「精确 → 前缀 → *」，兜底价也乘倍率')

  // ④ 老调用保持原样；非法倍率按 1。
  const custom = { 'deepseek-chat': { input: 7, output: 8 } }
  assert.deepEqual(priceFor('deepseek-chat', custom), priceFor('deepseek-chat', custom, {}))
  assert.equal(priceFor('deepseek-chat', {}, { provider: 'bad', providers: { bad: { multiplier: 'abc' } } }).input, 2)
  assert.equal(priceFor('deepseek-chat', {}, { provider: 'bad', providers: { bad: { multiplier: -3 } } }).input, 2)
  ok('老调用 priceFor(model, prices) 行为不变；非法倍率按 1')

  // ⑤ 同一笔用量走两条线路，记出不同的钱；流水行带 p。
  const pdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-provider-'))
  const pconfig = normalizeConfig({ providers: { gw: { multiplier: 0.3 }, official: {} } })
  const pricing = () => ({ prices: pconfig.prices, providers: pconfig.providers })
  const pledger = createLedger({ dir: pdir, getPrices: pricing, warn: (m) => warnings.push(m) })
  await pledger.load()
  const oneShot = { inputTokens: 1_000_000 }
  const viaOfficial = pledger.record({ sessionId: 'p-official', model: 'deepseek-v4.1-flash', provider: 'official', usage: oneShot })
  const viaGw = pledger.record({ sessionId: 'p-gw', model: 'deepseek-v4.1-flash', provider: 'gw', usage: oneShot })
  assert.equal(round4(viaOfficial), 1)
  assert.equal(round4(viaGw), 0.3)
  await pledger.flush()
  const pday = dayKey(Date.now())
  const prow = JSON.parse((await readFile(join(pdir, `ledger-${pday}.jsonl`), 'utf8')).trim().split('\n').pop())
  assert.equal(prow.p, 'gw', '流水行要有 p 字段')
  ok('同一模型两条线路记出不同的钱（¥1 vs ¥0.3），流水行带 p', `p=${prow.p}`)

  // ⑥ 旧流水行没有 p：读回来按空处理，不报错，钱和 token 都接上。
  const legacyLine = JSON.stringify({
    t: Date.now(),
    sid: 'legacy',
    model: 'deepseek-chat',
    i: 1_000_000,
    o: 0,
    r: 0,
    w: 0,
    cost: 2,
  })
  await writeFile(join(pdir, `ledger-${pday}.jsonl`), legacyLine + '\n', { flag: 'a' })
  const pAgain = createLedger({ dir: pdir, getPrices: pricing, warn: (m) => warnings.push(m) })
  await pAgain.load()
  const legacySpend = pAgain.spend('legacy')
  assert.equal(round4(legacySpend.day), 3.3, '旧行照算：¥1 + ¥0.3 + ¥2')
  assert.equal(legacySpend.tokens.day, 3_000_000, '旧行的 token 也能从 i+o+r+w 累加')
  ok('旧流水行没有 p → 按空处理，不报错（钱与 token 都接上）')
  await rm(pdir, { recursive: true, force: true })

  group('⑭ 按 token 卡（不知道单价也能用）')
  const tdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-tokens-'))
  const tconfig = normalizeConfig({
    caps: { turn: 100, hour: 1000, day: 1000 },
    capsTokens: { turn: 1, hour: 0, day: 0 },
  })
  const tledger = createLedger({ dir: tdir, getPrices: () => tconfig.prices, warn: (m) => warnings.push(m) })
  await tledger.load()
  const tfuse = createFuse({ ledger: tledger, getConfig: () => tconfig, warn: (m) => warnings.push(m) })
  const tsid = 'session-token'
  tfuse.noteModel(tsid, 'gw', 'deepseek-chat')
  tfuse.noteTurnStart(tsid)
  tledger.record({
    sessionId: tsid,
    model: 'deepseek-chat',
    provider: 'gw',
    usage: { inputTokens: 9000, outputTokens: 2000, cacheReadTokens: 1000, cacheWriteTokens: 0 },
  })

  const tSpend = tledger.spend(tsid)
  assert.equal(tSpend.tokens.turn, 12000, '四个桶相加 = 12000')
  assert.equal(tSpend.tokens.hour, 12000)
  assert.equal(tSpend.tokens.day, 12000)
  assert.ok(tSpend.turn < tconfig.caps.turn, '金额远没到闸')
  ok('spend() 同时给出三个窗口的 token（i+o+r+w）', `${tSpend.tokens.turn} token`)

  const tTrip = tfuse.check(tsid)
  assert.ok(tTrip, 'token 该越线')
  assert.equal(tTrip.unit, 'tokens', '越线的是 token 闸')
  assert.equal(tTrip.scope, 'turn')
  assert.equal(tTrip.spent, 12000, '报出来的 spent 用 token 数')
  assert.equal(tTrip.cap, 10000, '阈值写的是「万 token」，报出来要换算成 token')
  ok('token 闸越线 → unit=tokens，金额闸仍是放行的', `${tTrip.spent}/${tTrip.cap} token`)

  // 重启后 token 的日累计也要接回来（和 money 一样）。
  await tledger.flush()
  const tAgain = createLedger({ dir: tdir, getPrices: () => tconfig.prices, warn: (m) => warnings.push(m) })
  await tAgain.load()
  assert.equal(tAgain.spend(tsid).tokens.day, 12000, '重启后今日 token 不能缩水')
  ok('重启后今日 token 累计接得回来')

  // 新一轮：单轮 token 额度跟钱一起清零。
  tfuse.noteTurnStart(tsid)
  assert.equal(tfuse.check(tsid), null, '新一轮不该还挂在上一轮的 token 上')
  ok('新一轮开始 → 单轮 token 清零')
  await rm(tdir, { recursive: true, force: true })

  group('⑮ capsTokens 全 0：永不因 token 触发')
  const zdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-zero-'))
  const zconfig = normalizeConfig({ caps: { turn: 1_000_000, hour: 1_000_000, day: 1_000_000 } })
  assert.deepEqual(zconfig.capsTokens, { turn: 0, hour: 0, day: 0 }, '默认全 0 = 这道闸关掉')
  const zledger = createLedger({ dir: zdir, getPrices: () => zconfig.prices, warn: (m) => warnings.push(m) })
  await zledger.load()
  const zfuse = createFuse({ ledger: zledger, getConfig: () => zconfig, warn: (m) => warnings.push(m) })
  const zsid = 'session-zero'
  zfuse.noteModel(zsid, 'official', 'deepseek-chat')
  zfuse.noteTurnStart(zsid)
  zledger.record({ sessionId: zsid, model: 'deepseek-chat', usage: { inputTokens: 50_000_000 } })
  assert.equal(zledger.spend(zsid).tokens.turn, 50_000_000, 'token 照常统计')
  assert.equal(zfuse.check(zsid), null, 'capsTokens 全 0 → 永不因 token 触发')
  ok('用了 5000 万 token 也不触发 token 闸（全 0 = 关掉）', '50000000 token')

  // 配置归一：外观只认三值、token 阈值 0..1e12、供应商表二级兜底。
  assert.equal(normalizeConfig({ appearance: 'dark' }).appearance, 'dark')
  assert.equal(normalizeConfig({ appearance: 'light' }).appearance, 'light')
  assert.equal(normalizeConfig({ appearance: 'DARK' }).appearance, 'auto')
  assert.equal(normalizeConfig({ appearance: 42 }).appearance, 'auto')
  const badTokens = normalizeConfig({ capsTokens: { turn: -5, hour: 'abc', day: 1e18 } })
  assert.equal(badTokens.capsTokens.turn, 0, '负数回默认 0')
  assert.equal(badTokens.capsTokens.hour, 0, '乱字符回默认 0')
  assert.equal(badTokens.capsTokens.day, 1e12, '超过一万亿就压到一万亿')
  const pn = normalizeConfig({
    providers: { gw: { multiplier: 'x', prices: { m: { input: 1 } } }, bad: null, '': {} },
  })
  assert.equal(pn.providers.gw.multiplier, 1, '非法倍率按 1')
  assert.ok(pn.providers.gw.prices.m, '供应商价目表要保留')
  assert.equal(pn.providers.bad, undefined, '非对象供应商条目丢掉')
  assert.equal(pn.providers[''], undefined, '空 id 丢掉')
  assert.deepEqual(DEFAULT_CONFIG.capsTokens, { turn: 0, hour: 0, day: 0 })
  assert.equal(DEFAULT_CONFIG.appearance, 'auto')
  ok('normalizeConfig：appearance 三选一、capsTokens 0..1e12、providers 二级归一')

  const zsnap = zfuse.snapshot(zsid)
  assert.equal(zsnap.appearance, 'auto')
  assert.deepEqual(zsnap.capsTokens, zconfig.capsTokens)
  assert.deepEqual(zsnap.providers, zconfig.providers)
  ok('snapshot() 带出 appearance / capsTokens / providers（界面要用）')
  await zledger.flush()
  await rm(zdir, { recursive: true, force: true })

  group('⑯ 时钟回拨与跨天')
  const cdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-clock-'))
  // 本地时间构造：dayKey 用本地时区，测试也按本地算，避免跑在别的时区就红。
  let cclock = new Date(2026, 2, 10, 12, 0, 0).getTime()
  const cwarn = []
  const cledger = createLedger({ dir: cdir, now: () => cclock, warn: (m) => cwarn.push(m) })
  await cledger.load()
  cledger.record({ sessionId: 'c1', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  assert.equal(round4(cledger.spend('c1').day), 2)
  const dayBefore = cledger.dayKey()

  // 回拨 13 小时：不能清零（否则拨一下表就白拿一份日额度），更不能记成负数。
  cclock = new Date(2026, 2, 9, 23, 0, 0).getTime()
  cledger.record({ sessionId: 'c1', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  const back = cledger.spend('c1')
  assert.equal(round4(back.day), 4, '回拨期间继续累计，不清零')
  assert.ok(back.day >= 0 && back.hour >= 0, '任何窗口都不该出现负数')
  assert.equal(cledger.dayKey(), dayBefore, '回拨不换账（还记在原日期里）')

  // 拨到明天：这才该换账，新的一天从零开始。
  cclock = new Date(2026, 2, 11, 9, 0, 0).getTime()
  assert.equal(cledger.spend('c1').day, 0, '跨天换账')
  cledger.record({ sessionId: 'c1', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  await cledger.flush()
  const oldLines = (await readFile(join(cdir, `ledger-${dayBefore}.jsonl`), 'utf8')).trim().split('\n').length
  const newDay = cledger.dayKey()
  const newLines = (await readFile(join(cdir, `ledger-${newDay}.jsonl`), 'utf8')).trim().split('\n').length
  assert.equal(oldLines, 2, '回拨那笔仍写在原日期文件里')
  assert.equal(newLines, 1, '新的一天另起一个文件')
  ok('回拨不清零、不出负数；拨回昨天不重置，跨天才换账', `${oldLines} 行 / ${newLines} 行`)
  await rm(cdir, { recursive: true, force: true })

  group('⑰ 坏流水行：跳过 + 计数，不整份放弃')
  const bdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-bad-'))
  const bday = dayKey(Date.now())
  const baseRow = { t: Date.now() - 1000, sid: 'b', model: 'deepseek-chat', i: 1_000_000, o: 0, r: 0, w: 0 }
  // 7 行里只有 2 行是好的：半行、非 JSON、缺 cost、负 cost、坏 t 各一行。
  const badText =
    [
      JSON.stringify({ ...baseRow, cost: 1.5 }),
      '{"t":',
      'not json at all',
      JSON.stringify({ t: Date.now() }),
      JSON.stringify({ t: Date.now(), cost: -5 }),
      JSON.stringify({ t: '123', cost: 1 }),
      JSON.stringify({ ...baseRow, cost: 1 }),
    ].join('\n') + '\n'
  await writeFile(join(bdir, `ledger-${bday}.jsonl`), badText)
  const bwarn = []
  const bledger = createLedger({ dir: bdir, warn: (m) => bwarn.push(m) })
  await bledger.load()
  assert.equal(round4(bledger.spend('b').day), 2.5, '好行照算：1.5 + 1')
  assert.equal(bledger.stats().entries, 2, '只有好行进小时窗口')
  const badLineWarns = bwarn.filter((m) => m.includes('行读不了'))
  assert.equal(badLineWarns.length, 1, '坏行只汇总告警一次')
  assert.ok(badLineWarns[0].includes('5 行读不了'), `数出来的坏行是 5：${badLineWarns[0]}`)
  ok('半行 / 非 JSON / 缺字段 / 负金额 / 坏时间 → 5 行跳过，今日仍算 ¥2.5')
  await rm(bdir, { recursive: true, force: true })

  group('⑱ 脏配置归一（不把 NaN 写进文件）')
  const dirty = normalizeConfig({
    enabled: 'false',
    pill: 'off',
    autoDegrade: '0',
    caps: { day: 'abc', turn: -5, hour: true },
    capsTokens: { day: 1e30, turn: 'abc' },
    prices: { ghost: { input: NaN, output: -1 } },
    providers: { gw: { multiplier: 'x', prices: { m: { input: 'abc' } } } },
    degradeTo: ['m'],
    appearance: ['dark'],
  })
  assert.equal(dirty.enabled, false, '字符串 "false" 要真的关掉熔断')
  assert.equal(dirty.pill, false, '"off" 要真的关掉药丸')
  assert.equal(dirty.autoDegrade, false, '"0" 不能被当成真值')
  assert.equal(dirty.caps.day, DEFAULT_CONFIG.caps.day, 'abc → 默认')
  assert.equal(dirty.caps.turn, DEFAULT_CONFIG.caps.turn, '负数 → 默认')
  assert.equal(dirty.caps.hour, DEFAULT_CONFIG.caps.hour, '布尔 → 默认（Number(true) 会是 1）')
  assert.equal(dirty.capsTokens.day, 1e12, '超大 token 闸压到一万亿')
  assert.equal(dirty.capsTokens.turn, 0)
  assert.equal(dirty.prices.ghost, undefined, '坏价目整条丢掉')
  assert.equal(dirty.providers.gw.multiplier, 1, '坏倍率按 1')
  assert.equal(dirty.providers.gw.prices.m, undefined, '坏价目不能被记成 0 元')
  assert.deepEqual(dirty.degradeTo, DEFAULT_CONFIG.degradeTo, '数组不能当对象用')
  assert.equal(dirty.appearance, 'auto', '数组不能当外观')
  assert.ok(!JSON.stringify(dirty).includes('null'), 'NaN / Infinity 不能落成 null 写进文件')
  assert.equal(
    round4(
      costOf(
        { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        priceFor('deepseek-chat', dirty.prices, { providers: dirty.providers, provider: 'gw' }),
      ),
    ),
    2,
    '坏价目要回落标准价，不是免费',
  )
  ok('字符串布尔 / 数组 / NaN / 负倍率全部收干净；坏价目回落标准价')

  // 配置文件本身：空、数组、字符串、尾逗号都要能读；救不回来只告警一次。
  const { parseConfigText } = __internal
  assert.equal(parseConfigText('', () => {}).caps.day, DEFAULT_CONFIG.caps.day, '空文件 → 默认值')
  assert.equal(parseConfigText('[]', () => {}).enabled, DEFAULT_CONFIG.enabled, '数组 → 默认值')
  assert.equal(parseConfigText('"hello"', () => {}).enabled, DEFAULT_CONFIG.enabled, '字符串 → 默认值')
  assert.equal(parseConfigText('{"caps":{"day":9,},}', () => {}).caps.day, 9, '尾逗号能救回来')
  const cfgWarn = []
  parseConfigText('{"caps":', (m) => cfgWarn.push(m))
  assert.equal(cfgWarn.length, 1, '真读不了才告警，且只一次')
  ok('parseConfigText：空 / 数组 / 字符串 / 尾逗号都兜得住，不整份丢设置')

  group('⑲ 同会话并发只挂一张卡；卡被放掉不吊死')
  const kdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-cards-'))
  const kconfig = normalizeConfig({ decisionTimeoutSec: 0.2 })
  const kledger = createLedger({ dir: kdir, warn: (m) => warnings.push(m) })
  await kledger.load()
  const kfuse = createFuse({ ledger: kledger, getConfig: () => kconfig, warn: (m) => warnings.push(m) })
  const cardTrip = { scope: 'day', unit: 'money', spent: 5, cap: 3, currency: '¥' }
  const current = { provider: 'gw', model: 'deepseek-chat' }

  const first = kfuse.ask({ sessionId: 's1', trip: cardTrip, current })
  const second = kfuse.ask({ sessionId: 's1', trip: cardTrip, current })
  assert.equal(kfuse.stats().pending, 1, '同一会话并发两发只该有一张卡')
  assert.equal(kfuse.pendingList().length, 1)
  assert.equal(kfuse.decide(kfuse.pendingList()[0].id, 'degrade'), true)
  assert.equal(await first, 'degrade')
  assert.equal(await second, 'degrade', '第二发拿到的是人工决定，不是自己的超时降档')
  assert.equal(kfuse.stats().pending, 0, '决定之后不留残卡')
  ok('同会话两发复用同一张卡、同一个回答（不再互相顶掉）')

  const pa = kfuse.ask({ sessionId: 'sa', trip: cardTrip, current })
  const pb = kfuse.ask({ sessionId: 'sb', trip: cardTrip, current })
  assert.equal(kfuse.stats().pending, 2, '不同会话各挂各的')
  const idA = kfuse.pendingList().find((entry) => entry.sessionId === 'sa').id
  kfuse.decide(idA, 'pass')
  assert.equal(await pa, 'pass')
  assert.equal(kfuse.stats().pending, 1, 'a 的决定不影响 b')
  const idB = kfuse.pendingList()[0].id
  kfuse.decide(idB, 'stop')
  assert.equal(await pb, 'stop')
  ok('两个会话的卡互不干扰（a 放行 / b 停止）')

  const pc = kfuse.ask({ sessionId: 'sc', trip: cardTrip, current })
  kfuse.releaseSession('sc', 'release', 'disabled')
  assert.equal(await pc, 'release', '配置关掉时挂着的卡按「放行」放掉')
  assert.equal(kfuse.stats().pending, 0)
  const pd = kfuse.ask({ sessionId: 'sd', trip: cardTrip, current })
  kfuse.dispose()
  assert.equal(await pd, 'degrade', '卸载时按降档放行，不吊死也不停用户')
  assert.equal(kfuse.stats().pending, 0, '卸载后不留挂起的卡')
  ok('release / releaseSession / dispose 都能把挂着的请求放掉')

  const kfuse2 = createFuse({ ledger: kledger, getConfig: () => kconfig, warn: (m) => warnings.push(m) })
  const pe = kfuse2.ask({ sessionId: 'se', trip: cardTrip, current })
  assert.equal(await pe, 'degrade', '到点自动按降档处理')
  assert.equal(kfuse2.stats().pending, 0)
  kfuse2.dispose()
  ok('弹卡到点（200ms 测试值）按降档收尾，不无限挂起')
  await rm(kdir, { recursive: true, force: true })

  group('⑳ 会话表与单轮表有上限（长跑不涨）')
  const mdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-mem-'))
  const mconfig = normalizeConfig({})
  const mledger = createLedger({ dir: mdir, warn: (m) => warnings.push(m) })
  await mledger.load()
  const mfuse = createFuse({ ledger: mledger, getConfig: () => mconfig, warn: (m) => warnings.push(m) })
  for (let i = 0; i < 1200; i += 1) mfuse.noteModel(`s-${i}`, 'gw', 'deepseek-chat')
  const fuseSessions = mfuse.stats().sessions
  assert.ok(fuseSessions <= 500, `会话状态要有上限：${fuseSessions}`)
  for (let i = 0; i < 3000; i += 1) mledger.startTurn(`t-${i}`)
  const ledgerSessions = mledger.stats().sessions
  assert.ok(ledgerSessions <= 2000, `单轮表要有上限：${ledgerSessions}`)
  mledger.startTurn('main')
  mledger.record({ sessionId: 'main', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  assert.equal(round4(mledger.spend('main').turn), 2, '老会话被挤掉也不影响新账')
  ok('1200 个会话 → 状态表 ≤500；3000 轮 → 单轮表 ≤2000', `${fuseSessions} / ${ledgerSessions}`)
  await mledger.flush()
  await rm(mdir, { recursive: true, force: true })

  group('㉑ 换数据目录失败要回滚（不能白送一天的额度）')
  const rdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-reloc-'))
  const rwarn = []
  const rledger = createLedger({ dir: rdir, warn: (m) => rwarn.push(m) })
  await rledger.load()
  rledger.record({ sessionId: 'r1', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  await rledger.flush()
  assert.equal(round4(rledger.spend('r1').day), 2)
  // 目标路径已经是个文件：目录建不出来，切换必须失败。
  const cfgBlock = join(rdir, 'blocker')
  await writeFile(cfgBlock, 'x', 'utf8')
  const kept = await rledger.relocate(cfgBlock)
  assert.equal(kept, rdir, '写不了就留在旧目录')
  assert.equal(rledger.dir(), rdir, '内部目录也要回滚')
  assert.equal(round4(rledger.spend('r1').day), 2, '当日累计不能被清零')
  rledger.record({ sessionId: 'r1', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  assert.equal(round4(rledger.spend('r1').day), 4, '回滚之后还能继续记账')
  assert.ok(rwarn.some((m) => m.includes('写不了')), '失败要告警，但不能抛')
  ok('relocate 到不可写路径 → 回滚旧目录、累计不变、照常记账')
  await rm(rdir, { recursive: true, force: true })

  group('㉒ 写盘失败只 warn、不影响记账')
  const wdir = await mkdtemp(join(tmpdir(), 'dsh-fuse-fail-'))
  // 父路径是个文件：mkdir / append 都会失败，模拟只读盘 / 满盘。
  const asFile = join(wdir, 'not-a-dir')
  await writeFile(asFile, 'x', 'utf8')
  const wwarn = []
  const wledger = createLedger({ dir: join(asFile, 'data'), warn: (m) => wwarn.push(m) })
  await wledger.load()
  for (let i = 0; i < 5; i += 1) {
    wledger.record({ sessionId: 'w1', model: 'deepseek-chat', usage: { inputTokens: 1_000_000 } })
  }
  await wledger.flush()
  assert.equal(round4(wledger.spend('w1').day), 10, '写不进盘也照记（账在内存里）')
  const writeWarns = wwarn.filter((m) => m.includes('写流水失败'))
  assert.equal(writeWarns.length, 1, `五分钟内只提醒一次，实际 ${writeWarns.length}`)
  ok('写盘失败只 warn 一次，record / flush 都不抛', `¥10 照记，${writeWarns.length} 条告警`)
  await rm(wdir, { recursive: true, force: true })

  const realWarnings = warnings.filter((m) => !m.startsWith('从 '))
  assert.equal(realWarnings.length, 0, `不该有真正的警告：${realWarnings.join(' | ')}`)

  console.log(lines.join('\n'))
  console.log('\n自检通过，全部 22 组。\n')
}

main().catch((error) => {
  console.log(lines.join('\n'))
  console.error('\n✗ 自检失败：', error?.message ?? error)
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 6).join('\n'))
  process.exitCode = 1
})
