/*
 * dsh-fuse · 浏览器半边（运行时装）
 *
 * ⚠️ 这个文件是 scripts/build-client.mjs 从 src/client.js 生成的，不要手改。
 * 改 src/client.js，然后跑 `node scripts/build-client.mjs`。
 */
window.__ModuleLoader__.load({
  id: "dsh-fuse",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports



/**
 * 保险丝 · 浏览器半边
 * dsh-fuse
 *
 * 纯 ES module，零裸包 import —— 跟 dsh-gameflow 一样，由
 * `scripts/build-client.mjs` 转成 `window.__ModuleLoader__.load({id, factory})` 那种经典 script。
 * 所以这里不能出现 `export default`，也不能 import 任何 npm 包。
 *
 * 界面只有三件东西，都在一个 Shadow DOM 里：
 *   · 药丸：右下角一枚很小的今日花费，平时几乎看不见；
 *   · 卡：熔断跳了才出现，三个按钮 + 倒计时；
 *   · 面板：点药丸打开，改阈值、价目表、看最近拦截。
 *
 * 数据只走同源相对路径 `/dsh-fuse/*`（宿主半边在 src/index.js 注册）。
 */

const inject = []

/** 路由前缀，必须跟 src/index.js 的 `ROUTE` 一致。 */
const ROUTE = '/dsh-fuse'

/** 轮询间隔。本机回环，1.2 秒一次几乎不花钱，但足够「跟手」。 */
const POLL_MS = 1200

const SCOPE_LABEL = { turn: '这一轮', hour: '近一小时', day: '今天' }

/** 供应商 id 的候选列表 id（高级区那张倍率表用）。 */
const PROV_LIST_ID = 'fz-provider-ids'

/** 面板顶部那三档的叫法，比 SCOPE_LABEL 更短，塞得进小格子。 */
const SPEND_LABEL = { turn: '本轮', hour: '近一小时', day: '今日' }

/** 一键预设：只填输入框，仍然要用户点「保存」才落盘。 */
const CAP_PRESETS = [
  { id: 'watch', label: '看账（不拦）', caps: { turn: 0, hour: 0, day: 0 } },
  { id: 'easy', label: '省心 5/15/50', caps: { turn: 5, hour: 15, day: 50 } },
  { id: 'strict', label: '严格 2/6/20', caps: { turn: 2, hour: 6, day: 20 } },
]

/** 首次使用提示只认这一次；换文案就升版本号，老用户还能再看一遍。 */
const WELCOME_KEY = 'dsh-fuse.seen-welcome.v1'

/** localStorage 用不了时的兜底：至少这一次会话里别再弹。 */
let welcomeSeenFallback = false

const S = {
  mounted: false,
  host: null,
  shadow: null,
  timer: null,
  state: null,
  shownPending: null,
  panelOpen: false,
  panelBuilt: false,
  /** 上一次看到的模型目录签名：宿主是异步上报目录的，变了就得重画下拉。 */
  catalogSig: '',
  /** 面板里有还没保存的改动：这时关掉重开不重画，免得把用户输入丢掉。 */
  panelDirty: false,
  cardTimer: null,
  toastTimer: null,
  busy: false,
  /** 上一次 /state 没拉通：药丸变灰、面板顶部提示，但不清空已有数字。 */
  offline: false,
  /** 点过「再看一次引导」：下一次建面板时无视「已看过」，只放行这一次。 */
  welcomeForce: false,
  /** 面板里刚点、还没保存的外观选择；有它就盖过宿主那份配置。 */
  appearancePick: null,
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function h(tag, cls, text) {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined && text !== null) el.textContent = String(text)
  return el
}

function svg(paths, size = 16) {
  const ns = 'http://www.w3.org/2000/svg'
  const el = document.createElementNS(ns, 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('width', String(size))
  el.setAttribute('height', String(size))
  el.setAttribute('fill', 'none')
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', '1.8')
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    el.appendChild(p)
  }
  return el
}

const ICON_BOLT = svg(['M13 2 4.5 13H11l-1 9 8.5-11H12l1-9Z'])
const ICON_X = svg(['M6 6l12 12', 'M18 6 6 18'])

function money(value, currency = '¥') {
  const n = Number(value)
  if (!Number.isFinite(n)) return `${currency}0.00`
  if (n >= 1000) return `${currency}${Math.round(n)}`
  return `${currency}${n.toFixed(2)}`
}

/** token 数按「万」来写：12000 → 1.2万，50000 → 5万。 */
function wan(tokens) {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return '0万'
  const w = n / 10000
  if (w >= 100) return `${Math.round(w)}万`
  const text = w.toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}万`
}

/** 外观只认 auto / dark / light；字段缺失或者乱填都当 auto（跟宿主）。 */
function normAppearance(value) {
  return value === 'dark' || value === 'light' ? value : 'auto'
}

/** 隐私模式 / 关掉存储时 localStorage 会直接抛，别为了一个提示条把面板弄崩。 */
function localStore() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

function welcomeSeen() {
  if (welcomeSeenFallback) return true
  try {
    return localStore()?.getItem(WELCOME_KEY) === '1'
  } catch {
    return false
  }
}

function markWelcome() {
  welcomeSeenFallback = true
  try {
    localStore()?.setItem(WELCOME_KEY, '1')
  } catch {
    // 存不下就算了，这会儿的 fallback 已经保证只显示一次
  }
}

/** 输入框里的非负数字；空、乱填、负数都当 0（0 = 这一道闸关掉）。 */
function readCap(input) {
  const raw = String(input?.value ?? '').trim()
  if (raw === '') return 0
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 把宿主给的 providers 摊成 [{ id, multiplier }]。
 * 宿主既可能给数组（id 列表，或者 [{ id, multiplier }]），也可能给
 * `{ "openrouter": { "multiplier": 0.3 } }` 这样的表 —— 两种都认，
 * 认不出来就返回空数组，面板照常能开。
 */
function providerEntries(source) {
  const out = []
  if (Array.isArray(source)) {
    for (const item of source) {
      if (typeof item === 'string') {
        if (item.trim() !== '') out.push({ id: item.trim(), multiplier: undefined })
      } else if (item && typeof item === 'object' && typeof item.id === 'string' && item.id.trim() !== '') {
        out.push({ id: item.id.trim(), multiplier: item.multiplier })
      }
    }
    return out
  }
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (typeof key !== 'string' || key.trim() === '') continue
      if (typeof value === 'number') out.push({ id: key.trim(), multiplier: value })
      else if (value && typeof value === 'object') out.push({ id: key.trim(), multiplier: value.multiplier })
      else out.push({ id: key.trim(), multiplier: undefined })
    }
  }
  return out
}

/**
 * 降档目标的候选型号，按「这条线到底能不能用」分层。
 * 顺序即可信度：
 *   ① state.catalog.models —— 宿主新给的「当前线路真实可用的型号」，最权威；
 *   ② state.models         —— 本机真跑过的，可能来自别的线路；
 *   ③ state.prices 的键    —— 生效价目表里的；
 *   ④ config.prices 的键   —— 用户自己加过的。
 * 为什么非得这么排：实测线路是 opencode-go、降档目标设成 deepseek-chat（别处
 * 见过的型号），切换后下一个请求直接失败、整轮任务崩掉。别的线路的型号不是
 * 「候选」，只能算「见过」，得排后面、还得分开显示。
 */
function modelOptions(state) {
  const cfg = state?.config ?? {}
  const catalog = state?.catalog && typeof state.catalog === 'object' ? state.catalog : null
  const provider = typeof catalog?.provider === 'string' ? catalog.provider.trim() : ''
  const seen = new Set()
  /** 取一批候选里「干净且没出现过」的名字：空串和 `*` 兜底键都不是型号。 */
  const take = (list) => {
    const out = []
    for (const raw of Array.isArray(list) ? list : []) {
      if (typeof raw !== 'string') continue
      const name = raw.trim()
      if (name === '' || name === '*' || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
    return out
  }
  const keys = (source) =>
    source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source) : []
  // catalog 先取，占住名次：同名型号不会在后面再出现一次。
  const catalogModels = take(catalog?.models)
  const seenModels = take(state?.models)
  const pricedModels = take(keys(state?.prices))
  const customModels = take(keys(cfg?.prices))
  return {
    provider,
    /** 当前线路真能用的：下拉的默认组。 */
    catalog: catalogModels,
    /** 其他来源见过的：拿到 catalog 时才单独成组，否则平铺（保持老界面）。 */
    others: [...seenModels, ...pricedModels, ...customModels],
    /** 全部候选：给「建议更便宜的型号」和「当前值在不在列表里」用。 */
    all: [...catalogModels, ...seenModels, ...pricedModels, ...customModels],
  }
}

function minutes(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${total}s`
}

function reachable() {
  if (typeof fetch !== 'function') return false
  if (typeof location !== 'undefined' && location.protocol === 'file:') return false
  return true
}

async function api(path, options) {
  if (!reachable()) return null
  try {
    const res = await fetch(`${ROUTE}${path}`, {
      ...options,
      headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
      cache: 'no-store',
    })
    if (!res.ok && res.status !== 409) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ *
 * 样式
 * ------------------------------------------------------------------ */

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
:host, .root {
  --fz-fg: #f2f4f8;
  --fz-dim: #9aa3b2;
  --fz-faint: #6b7484;
  --fz-bg: rgba(24, 26, 31, .96);
  --fz-bg2: rgba(32, 35, 41, .98);
  --fz-line: rgba(255, 255, 255, .09);
  --fz-line2: rgba(255, 255, 255, .16);
  --fz-amber: #f5a524;
  --fz-amber-soft: rgba(245, 165, 36, .14);
  --fz-red: #f2555a;
  --fz-green: #3ecf8e;
  --fz-shadow: 0 18px 48px rgba(0, 0, 0, .5);
  --fz-radius: 16px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fz-fg);
  font-size: 13px;
  line-height: 1.5;
}
.root[data-theme="light"] {
  --fz-fg: #1b1f27;
  --fz-dim: #5b6472;
  --fz-faint: #8b94a3;
  --fz-bg: rgba(255, 255, 255, .97);
  --fz-bg2: rgba(248, 249, 251, .99);
  --fz-line: rgba(15, 20, 30, .1);
  --fz-line2: rgba(15, 20, 30, .18);
  --fz-amber-soft: rgba(245, 165, 36, .16);
  --fz-shadow: 0 18px 48px rgba(20, 25, 40, .18);
}
.num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }

/* ---------------- 药丸 ---------------- */
.pill {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
  display: flex; align-items: center; gap: 7px;
  height: 30px; padding: 0 12px 0 10px;
  border-radius: 999px; border: 1px solid var(--fz-line);
  background: var(--fz-bg); color: var(--fz-dim);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .22);
  font-size: 12px; cursor: pointer; user-select: none;
  backdrop-filter: blur(14px) saturate(1.3);
  transition: color .18s, border-color .18s, transform .18s, background .18s;
}
.pill:hover { transform: translateY(-1px); border-color: var(--fz-line2); color: var(--fz-fg); }
.pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fz-green); box-shadow: 0 0 0 3px rgba(62, 207, 142, .14); }
.pill.warn .dot { background: var(--fz-amber); box-shadow: 0 0 0 3px var(--fz-amber-soft); }
.pill.warn { color: var(--fz-amber); border-color: rgba(245, 165, 36, .32); }
.pill.hot .dot { background: var(--fz-red); box-shadow: 0 0 0 3px rgba(242, 85, 90, .18); }
.pill.hot { color: var(--fz-red); border-color: rgba(242, 85, 90, .34); }
.pill .sep { color: var(--fz-faint); margin: 0 -2px; }
.pill .lim { color: var(--fz-faint); }
.pill .tag { font-size: 11px; padding: 0 5px; border-radius: 4px; background: var(--fz-amber-soft); color: var(--fz-amber); }
.pill.hidden { display: none; }
/* 宿主没响应：点变灰，数字留着（别让已花的钱看起来像 0） */
.pill.off { color: var(--fz-faint); border-color: var(--fz-line); }
.pill.off .dot { background: var(--fz-faint); box-shadow: 0 0 0 3px rgba(128, 137, 152, .14); }

/* ---------------- 卡 ---------------- */
.card {
  position: fixed; right: 18px; bottom: 58px; z-index: 2147483001;
  width: 372px; max-width: calc(100vw - 36px);
  padding: 16px 16px 12px;
  border-radius: var(--fz-radius); border: 1px solid var(--fz-line);
  background:
    radial-gradient(120% 80% at 100% 0%, rgba(245, 165, 36, .16), transparent 58%),
    linear-gradient(180deg, var(--fz-bg2), var(--fz-bg));
  box-shadow: var(--fz-shadow);
  backdrop-filter: blur(18px) saturate(1.35);
  transform-origin: 100% 100%;
  animation: cardIn .24s cubic-bezier(.22, 1, .36, 1);
}
@keyframes cardIn { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
.card.hidden { display: none; }
.card .head { display: flex; align-items: center; gap: 10px; }
.card .spark {
  width: 30px; height: 30px; border-radius: 9px; flex: none;
  display: flex; align-items: center; justify-content: center;
  color: #1a1305; background: linear-gradient(160deg, #ffc857, #f5a524);
  box-shadow: 0 0 0 4px var(--fz-amber-soft), 0 6px 14px rgba(245, 165, 36, .28);
}
.card .spark.hot { background: linear-gradient(160deg, #ff8a8d, #f2555a); box-shadow: 0 0 0 4px rgba(242, 85, 90, .18), 0 6px 14px rgba(242, 85, 90, .3); color: #2a0507; }
.card .titles { min-width: 0; }
.card .t { font-size: 14.5px; font-weight: 650; letter-spacing: .2px; }
.card .s { font-size: 11.5px; color: var(--fz-dim); margin-top: 1px; }
.card .chip {
  margin-left: auto; flex: none; font-size: 11px; padding: 3px 8px; border-radius: 999px;
  border: 1px solid rgba(245, 165, 36, .34); color: var(--fz-amber); background: var(--fz-amber-soft);
}
.card .nums { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 9px; }
.card .big { font-size: 30px; font-weight: 680; letter-spacing: -.6px; line-height: 1; }
.card .big.hot { color: var(--fz-red); }
.card .cap { font-size: 12px; color: var(--fz-faint); }
.card .bar { position: relative; height: 6px; border-radius: 99px; background: rgba(128, 137, 152, .18); overflow: hidden; }
.card .bar i {
  position: absolute; inset: 0 auto 0 0; display: block; border-radius: 99px;
  background: linear-gradient(90deg, #f5c24b, var(--fz-amber));
  transition: width .5s cubic-bezier(.22, 1, .36, 1);
}
.card .bar.hot i { background: linear-gradient(90deg, #ff8a8d, var(--fz-red)); }
.card .q { margin: 12px 0 12px; font-size: 12.5px; color: var(--fz-dim); }
.card .q b { color: var(--fz-fg); font-weight: 600; }
.card .acts { display: flex; gap: 7px; }
.card button {
  flex: 1; height: 34px; border-radius: 9px; cursor: pointer; font-size: 12.5px; font-weight: 550;
  border: 1px solid var(--fz-line2); background: transparent; color: var(--fz-fg);
  transition: background .15s, border-color .15s, transform .06s;
}
.card button:hover { background: rgba(128, 137, 152, .12); }
.card button:active { transform: translateY(1px); }
.card button.primary {
  border-color: transparent; color: #1a1305;
  background: linear-gradient(160deg, #ffc857, #f5a524);
  box-shadow: 0 6px 18px rgba(245, 165, 36, .26);
}
.card button.primary:hover { filter: brightness(1.05); }
.card button.danger { color: var(--fz-red); border-color: rgba(242, 85, 90, .34); }
.card button.danger:hover { background: rgba(242, 85, 90, .1); }
.card .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; font-size: 11px; color: var(--fz-faint); }
.card .foot .model { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .foot b { color: var(--fz-amber); font-weight: 600; }
.card .tick { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(245, 165, 36, .5); transform-origin: 0 50%; }

/* ---------------- 面板 ---------------- */
.panel {
  position: fixed; right: 18px; bottom: 58px; z-index: 2147483002;
  width: 400px; max-width: calc(100vw - 36px); max-height: min(78vh, 760px);
  display: flex; flex-direction: column;
  border-radius: var(--fz-radius); border: 1px solid var(--fz-line);
  background: linear-gradient(180deg, var(--fz-bg2), var(--fz-bg));
  box-shadow: var(--fz-shadow); backdrop-filter: blur(18px) saturate(1.3);
  animation: cardIn .2s cubic-bezier(.22, 1, .36, 1);
  overflow: hidden;
}
.panel.hidden { display: none; }
.panel header { display: flex; align-items: center; gap: 8px; padding: 13px 14px; border-bottom: 1px solid var(--fz-line); }
.panel header .ttl { font-size: 13.5px; font-weight: 650; }
.panel header .badge { font-size: 10.5px; color: var(--fz-faint); border: 1px solid var(--fz-line); padding: 2px 6px; border-radius: 5px; }
.panel header .close { margin-left: auto; border: 0; background: transparent; color: var(--fz-dim); cursor: pointer; padding: 4px; border-radius: 6px; display: flex; }
.panel header .close:hover { background: rgba(128, 137, 152, .14); color: var(--fz-fg); }
.panel .body { overflow: auto; padding: 6px 14px 12px; }
.panel section { padding: 9px 0; border-bottom: 1px solid var(--fz-line); }
.panel section:last-child { border-bottom: 0; }
.panel h4 { margin: 0 0 7px; font-size: 11.5px; font-weight: 600; color: var(--fz-dim); letter-spacing: .3px; }
.panel .row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.panel .row .lbl { flex: 1; font-size: 12.5px; }
.panel .row .hint { font-size: 11px; color: var(--fz-faint); }
.panel input[type="number"], .panel input[type="text"] {
  width: 84px; height: 28px; padding: 0 8px; border-radius: 7px;
  border: 1px solid var(--fz-line2); background: rgba(0, 0, 0, .18); color: var(--fz-fg);
  font-size: 12.5px; font-variant-numeric: tabular-nums; outline: none;
}
.panel .col > input[type="text"] { width: 100%; }
.panel select {
  width: 100%; height: 30px; padding: 0 8px; border-radius: 7px;
  border: 1px solid var(--fz-line2); background: rgba(0, 0, 0, .18); color: var(--fz-fg);
  font-size: 12.5px; outline: none; appearance: none; cursor: pointer;
  background-image: linear-gradient(45deg, transparent 50%, var(--fz-dim) 50%), linear-gradient(135deg, var(--fz-dim) 50%, transparent 50%);
  background-position: calc(100% - 15px) 13px, calc(100% - 10px) 13px;
  background-size: 5px 5px, 5px 5px; background-repeat: no-repeat;
}
.panel select:focus { border-color: rgba(245, 165, 36, .55); box-shadow: 0 0 0 3px var(--fz-amber-soft); }
.panel select option { background: #1b1f26; color: #e8ecf2; }
/* 「其他线路见过的」这一组折叠在下拉里：颜色压低一档，别跟当前线路的型号抢眼。 */
.panel select optgroup { background: #1b1f26; color: var(--fz-dim); font-style: normal; font-weight: 500; }
.panel select optgroup option { color: #e8ecf2; }
.root[data-theme="light"] .panel select optgroup { background: #fff; color: var(--fz-dim); }
.root[data-theme="light"] .panel select optgroup option { color: #1b1f27; }
.root[data-theme="light"] .panel input[type="number"], .root[data-theme="light"] .panel input[type="text"] { background: #fff; }
.panel input:focus { border-color: rgba(245, 165, 36, .55); box-shadow: 0 0 0 3px var(--fz-amber-soft); }
.panel .unit { font-size: 11px; color: var(--fz-faint); width: 30px; }
.panel .sw { position: relative; width: 36px; height: 20px; flex: none; }
.panel .sw input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; z-index: 2; }
.panel .sw i { position: absolute; inset: 0; border-radius: 99px; background: rgba(128, 137, 152, .3); transition: background .18s; }
.panel .sw i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .18s; }
.panel .sw input:checked + i { background: var(--fz-amber); }
.panel .sw input:checked + i::after { transform: translateX(16px); }
.panel .priceRow { display: grid; grid-template-columns: minmax(0, 1fr) 58px 58px 58px 20px; gap: 5px; align-items: center; margin: 6px 0; }
.panel .priceRow.rowOff { display: none; }
.panel .priceRow input { min-width: 0; }
.panel .priceRow .del { border: 0; background: transparent; color: var(--fz-faint); cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }
.panel .priceRow .del:hover { color: var(--fz-red); }
.panel .priceHead { display: grid; grid-template-columns: minmax(0, 1fr) 58px 58px 58px 20px; gap: 5px; font-size: 10.5px; color: var(--fz-faint); margin-bottom: 2px; }
.panel .priceBtns { display: flex; gap: 6px; margin-top: 8px; }
.panel .mini {
  height: 26px; padding: 0 10px; border-radius: 7px; font-size: 11.5px; cursor: pointer;
  border: 1px solid var(--fz-line2); background: transparent; color: var(--fz-dim);
}
.panel .mini:hover { color: var(--fz-fg); background: rgba(128, 137, 152, .12); }
/* 保险丝预设：一行三个胶囊，点一下只填数字 */
.panel .presets { display: flex; gap: 6px; margin: 2px 0 4px; }
.panel .presets button {
  flex: 1 1 0; min-width: 0; height: 27px; padding: 0 6px; border-radius: 7px;
  font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  border: 1px solid var(--fz-line2); background: transparent; color: var(--fz-dim);
  transition: color .15s, background .15s, border-color .15s;
}
.panel .presets button:hover { color: var(--fz-fg); background: rgba(128, 137, 152, .12); }
.panel .presets button.on { border-color: transparent; color: #1a1305; background: linear-gradient(160deg, #ffc857, #f5a524); }
/* 首次使用 / 宿主没响应：两条顶部提示，浅色，不抢数字的视线 */
.panel .welcome {
  margin: 8px 0 0; padding: 8px 10px; border-radius: 9px; line-height: 1.55;
  font-size: 11.5px; color: var(--fz-dim);
  border: 1px solid rgba(245, 165, 36, .28); background: var(--fz-amber-soft);
}
.panel .welcome b { color: var(--fz-fg); font-weight: 600; }
.root[data-theme="light"] .panel .welcome { background: rgba(245, 165, 36, .12); }
.panel .offline {
  margin: 8px 0 0; padding: 6px 10px; border-radius: 9px; font-size: 11.5px;
  color: var(--fz-red); border: 1px solid rgba(242, 85, 90, .3); background: rgba(242, 85, 90, .08);
}
/* 降档目标的自动建议：一行小字 + 一个「用 X」 */
.panel .sug { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; }
.panel .sug .sugTxt { flex: 1; min-width: 0; font-size: 10.5px; color: var(--fz-faint); line-height: 1.45; }
.panel .sug button { flex: none; }
/* 顶部三档实时数字 */
.panel .spends { display: flex; gap: 6px; margin: 9px 0 3px; }
.panel .spends .sp {
  flex: 1 1 0; min-width: 0; padding: 6px 7px; border-radius: 8px;
  border: 1px solid var(--fz-line); background: rgba(128, 137, 152, .09);
}
.root[data-theme="light"] .panel .spends .sp { background: rgba(15, 20, 30, .04); }
.panel .spends .k { font-size: 10.5px; color: var(--fz-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel .spends .v { font-size: 11.5px; color: var(--fz-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.panel .spends .sp.warn { border-color: rgba(245, 165, 36, .4); }
.panel .spends .sp.warn .v { color: var(--fz-amber); }
.panel .spends .sp.hot { border-color: rgba(242, 85, 90, .42); }
.panel .spends .sp.hot .v { color: var(--fz-red); }
/* 竖排一段：标签在上、整行输入在下（降档目标 / 数据目录） */
.panel .col { margin: 7px 0; }
.panel .col .lbl { font-size: 12.5px; }
.panel .col .hint { font-size: 11px; color: var(--fz-faint); }
/* 降档目标下面那行说明：跟下拉留一点距离，别贴在一起看不清 */
.panel .col .hint.degNote { margin-top: 4px; line-height: 1.45; }
.panel .col input[type="text"] { width: 100%; margin-top: 5px; }
.panel .dirNow { margin-top: 5px; font-size: 10.5px; color: var(--fz-faint); word-break: break-all; line-height: 1.45; }
.panel .audit { max-height: 132px; overflow: auto; font-size: 11px; }
.panel .audit div { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px dashed var(--fz-line); color: var(--fz-dim); }
.panel .audit div:last-child { border-bottom: 0; }
.panel .audit .t { color: var(--fz-faint); flex: none; width: 84px; font-variant-numeric: tabular-nums; }
.panel .audit .a { flex: none; width: 62px; color: var(--fz-amber); }
.panel .audit .a.stop { color: var(--fz-red); }
.panel .audit .a.pass-once { color: var(--fz-green); }
.panel footer { display: flex; gap: 8px; padding: 11px 14px; border-top: 1px solid var(--fz-line); }
.panel footer button {
  height: 32px; padding: 0 14px; border-radius: 8px; font-size: 12.5px; cursor: pointer; font-weight: 550;
  border: 1px solid var(--fz-line2); background: transparent; color: var(--fz-fg);
}
.panel footer button:hover { background: rgba(128, 137, 152, .12); }
.panel footer button.primary { border-color: transparent; color: #1a1305; background: linear-gradient(160deg, #ffc857, #f5a524); }
.panel footer .grow { flex: 1; }
/* 「再看一次引导」：文字按钮，不抢眼但点得到 */
.panel footer .link {
  height: 26px; padding: 0 4px; border: 0; background: transparent; align-self: center;
  color: var(--fz-faint); font-size: 11px; font-weight: 500;
}
.panel footer .link:hover { background: transparent; color: var(--fz-fg); text-decoration: underline; }
.panel .empty { color: var(--fz-faint); font-size: 11.5px; padding: 6px 0; }

/* 外观三选一：跟宿主 / 深色 / 浅色 */
.panel .seg { display: flex; gap: 4px; flex: none; }
.panel .seg button {
  height: 26px; padding: 0 9px; border-radius: 7px; font-size: 11.5px; cursor: pointer;
  border: 1px solid var(--fz-line2); background: transparent; color: var(--fz-dim);
  transition: color .15s, background .15s, border-color .15s;
}
.panel .seg button:hover { color: var(--fz-fg); background: rgba(128, 137, 152, .12); }
.panel .seg button.on { border-color: transparent; color: #1a1305; background: linear-gradient(160deg, #ffc857, #f5a524); }

/* 高级区：默认收起，点标题展开 */
.panel .advHead { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; outline: none; }
.panel .advHead h4 { margin: 0; }
.panel .advHead .chev { font-size: 9px; color: var(--fz-faint); transition: transform .16s; }
.panel .advHead.open .chev { transform: rotate(90deg); }
.panel .advHead .aside { margin-left: auto; font-size: 10.5px; color: var(--fz-faint); }
.panel .advHead:focus-visible { box-shadow: 0 0 0 3px var(--fz-amber-soft); border-radius: 6px; }
.panel .advBody { display: none; margin-top: 9px; }
.panel .advBody.open { display: block; }
.panel .sub { font-size: 10.5px; color: var(--fz-faint); margin: 0 0 6px; line-height: 1.45; }
/* 供应商倍率表：内宽 372，id 自适应 + 倍率 62 + 删除 18，不会横向溢出 */
.panel .provHead, .panel .provRow { display: grid; grid-template-columns: minmax(0, 1fr) 62px 18px; gap: 5px; align-items: center; }
.panel .provHead { font-size: 10.5px; color: var(--fz-faint); margin-bottom: 2px; }
.panel .provRow { margin: 5px 0; }
.panel .provRow input { width: 100%; min-width: 0; }
.panel .provRow .del { border: 0; background: transparent; color: var(--fz-faint); cursor: pointer; font-size: 15px; line-height: 1; padding: 0; }
.panel .provRow .del:hover { color: var(--fz-red); }
/* 按 token 卡：一行三格（本轮 / 近一小时 / 今日，单位万 token） */
.panel .tokRow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin: 6px 0 2px; }
.panel .tokRow .k { font-size: 10.5px; color: var(--fz-faint); margin-bottom: 2px; }
.panel .tokRow .fld { display: flex; align-items: center; gap: 3px; }
.panel .tokRow input { width: 100%; min-width: 0; }
.panel .tokRow .u { font-size: 10.5px; color: var(--fz-faint); flex: none; }

/* ---------------- 提示条 ---------------- */
.toast {
  position: fixed; right: 18px; bottom: 58px; z-index: 2147483003;
  max-width: 320px; padding: 9px 13px; border-radius: 10px;
  background: var(--fz-bg2); border: 1px solid var(--fz-line2); color: var(--fz-fg);
  box-shadow: var(--fz-shadow); font-size: 12px;
  animation: cardIn .18s cubic-bezier(.22, 1, .36, 1);
}
.toast.hidden { display: none; }

@media (prefers-reduced-motion: reduce) {
  .card, .panel, .toast { animation: none; }
  .card .bar i { transition: none; }
}
`

/* ------------------------------------------------------------------ *
 * 界面
 * ------------------------------------------------------------------ */

function createUi() {
  const root = h('div', 'root')

  const pill = h('div', 'pill hidden')
  const pillDot = h('span', 'dot')
  const pillAmt = h('span', 'num')
  const pillSep = h('span', 'sep', '/')
  const pillLim = h('span', 'lim')
  pill.append(pillDot, pillAmt, pillSep, pillLim)
  pill.title = '保险丝：点开可改阈值'

  const card = h('div', 'card hidden')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-live', 'assertive')

  const head = h('div', 'head')
  const spark = h('div', 'spark')
  spark.appendChild(ICON_BOLT)
  const titles = h('div', 'titles')
  const tEl = h('div', 't', '保险丝跳了')
  const sEl = h('div', 's')
  titles.append(tEl, sEl)
  const chip = h('div', 'chip', '这一轮')
  head.append(spark, titles, chip)

  const nums = h('div', 'nums')
  nums.setAttribute('aria-live', 'polite')
  const big = h('div', 'big num')
  const cap = h('div', 'cap num')
  nums.append(big, cap)

  const bar = h('div', 'bar')
  const barFill = h('i')
  bar.appendChild(barFill)

  const q = h('p', 'q')
  const acts = h('div', 'acts')
  const btnDegrade = h('button', 'primary', '降档继续')
  const btnPass = h('button', '', '放行一次')
  const btnStop = h('button', 'danger', '停止本轮')
  acts.append(btnDegrade, btnPass, btnStop)
  btnDegrade.setAttribute('aria-label', '降档继续：换到降档目标跑完这一轮')
  btnPass.setAttribute('aria-label', '放行一次：这一轮不再拦')
  btnStop.setAttribute('aria-label', '停止本轮：请求不发，输入回到输入框')

  const foot = h('div', 'foot')
  const footLeft = h('span')
  footLeft.setAttribute('aria-live', 'polite')
  const footModel = h('span', 'model')
  foot.append(footLeft, footModel)

  card.append(head, nums, bar, q, acts, foot)

  const toast = h('div', 'toast hidden')
  toast.setAttribute('aria-live', 'assertive')

  const panel = h('div', 'panel hidden')
  let panelBuilt = false

  /** 用户改过面板里的任何输入 / 开关 / 外观 / 数据目录：标记为「脏」，
      关闭重开时保留现场，不要拿 /state 重画把还没保存的值冲掉。 */
  function markPanelDirty() {
    S.panelDirty = true
  }
  // input / change 会从面板里任何输入框冒泡上来，一处就够；只点不改的
  // 那几颗按钮（预设、外观、增删行）在各自的处理器里单独标。
  panel.addEventListener('input', markPanelDirty)
  panel.addEventListener('change', markPanelDirty)

  btnDegrade.addEventListener('click', () => decide('degrade'))
  btnPass.addEventListener('click', () => decide('pass'))
  btnStop.addEventListener('click', () => decide('stop'))
  pill.addEventListener('click', () => togglePanel())

  function decide(action) {
    const pending = S.state?.pending?.[0]
    if (!pending || S.busy) return
    // 面板里没配降档目标时，中间那颗按钮的语义就是「这一轮继续」，别假装能降档。
    const real = action === 'degrade' && !pending.degradeTo ? 'pass' : action
    S.busy = true
    void api('/decide', { method: 'POST', body: JSON.stringify({ id: pending.id, action: real }) }).then((res) => {
      S.busy = false
      if (res?.ok) {
        hideCard()
        const words = { degrade: '已降档，接着跑', pass: '已放行这一轮', stop: '已停住，输入还在' }
        showToast(words[real] ?? '已处理')
      } else {
        // 多半是超时已经自动处置了：把卡收起来，下一轮状态自己会更新。
        hideCard()
        showToast('这张卡已经失效了（可能超时自动降档）')
      }
      void poll(true)
    })
  }

  function showToast(text) {
    toast.textContent = text
    toast.classList.remove('hidden')
    if (S.toastTimer) clearTimeout(S.toastTimer)
    S.toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600)
  }

  function hideCard() {
    card.classList.add('hidden')
    S.shownPending = null
    if (S.cardTimer) {
      clearInterval(S.cardTimer)
      S.cardTimer = null
    }
  }

  /* ---------------- 卡的绘制 ---------------- */

  function renderCard(pending) {
    const state = S.state
    if (!state) return
    const currency = state.currency ?? '¥'
    // A 侧对「按 token 卡」跳出来的卡只多带一个 unit: 'tokens'；money 那条路
    // 没有 unit，或者明确 'money'。所以除了 tokens 一律按金额走，老行为不变。
    const tokens = pending.unit === 'tokens'
    const over = pending.spent > pending.cap
    const ratio = pending.cap > 0 ? Math.min(1.6, pending.spent / pending.cap) : 1

    chip.textContent = SCOPE_LABEL[pending.scope] ?? pending.scope
    const hasTarget = Boolean(pending.degradeTo)
    btnDegrade.textContent = hasTarget ? '降档继续' : '继续本轮'
    btnDegrade.setAttribute(
      'aria-label',
      hasTarget ? `降档继续：换到 ${pending.degradeTo} 跑完这一轮` : '继续本轮：不换模型，跑完这一轮',
    )
    sEl.textContent = tokens
      ? `${SCOPE_LABEL[pending.scope] ?? ''}的 token 越过上限了`
      : `${SCOPE_LABEL[pending.scope] ?? ''}的钱越过上限了`
    big.textContent = tokens ? wan(pending.spent) : money(pending.spent, currency)
    big.title = tokens ? '单位：token（万）' : ''
    big.classList.toggle('hot', true)
    cap.textContent = tokens ? `上限 ${wan(pending.cap)} token` : `上限 ${money(pending.cap, currency)}`
    bar.classList.toggle('hot', over)
    barFill.style.width = `${Math.min(100, (ratio / 1.35) * 100)}%`
    spark.classList.toggle('hot', pending.scope === 'turn')
    q.innerHTML = ''
    q.append(
      document.createTextNode('还继续吗？'),
      (() => {
        const b = h('b')
        b.textContent = `${state.config?.decisionTimeoutSec ?? 30} 秒`
        return b
      })(),
      document.createTextNode(hasTarget ? '内不选，自动降到 ' : '内不选，自动放行这一轮'),
      ...(hasTarget
        ? [
            (() => {
              const b = h('b')
              b.textContent = pending.degradeTo
              return b
            })(),
            document.createTextNode(' 接着跑。'),
          ]
        : [document.createTextNode('。')]),
    )
    footModel.textContent = pending.degradeTo
      ? `${pending.model || '当前模型'} → ${pending.degradeTo}`
      : pending.model

    card.classList.remove('hidden')
    const deadline = Number(pending.deadline) || Date.now()
    const tick = () => {
      const left = deadline - Date.now()
      footLeft.innerHTML = ''
      const b = h('b')
      b.textContent = minutes(left)
      footLeft.append(document.createTextNode(hasTarget ? '自动降档倒计时 ' : '自动放行倒计时 '), b)
      if (left <= 0) hideCard()
    }
    tick()
    if (S.cardTimer) clearInterval(S.cardTimer)
    S.cardTimer = setInterval(tick, 250)
  }

  /* ---------------- 药丸 ---------------- */

  function renderPill() {
    const state = S.state
    // 药丸只受「显示药丸」这一项控制：把熔断关掉不等于不想看账
    // （关掉保险丝还要能看见今天花了多少，否则又回到「只看得见才敢花」的老路）。
    if (state && state.pill === false) {
      pill.classList.add('hidden')
      return
    }
    if (!state && !S.offline) {
      pill.classList.add('hidden')
      return
    }
    if (S.offline) {
      // 宿主重启中：点变灰，但已经显示过的金额原样留着，别刷成 ¥0。
      pill.classList.remove('hidden', 'warn', 'hot')
      pill.classList.add('off')
      if (!state) {
        pillAmt.textContent = '—'
        pillLim.textContent = '—'
      }
      pill.title = '宿主没响应，稍后自动重试'
      return
    }
    pill.classList.remove('off')
    const ratio = state.caps.day > 0 ? state.spend.day / state.caps.day : 0
    pill.classList.remove('hidden')
    pill.classList.toggle('warn', ratio >= (state.warnRatio ?? 0.6) && ratio < 1)
    pill.classList.toggle('hot', ratio >= 1)
    pillAmt.textContent = money(state.spend.day, state.currency ?? '¥')
    pillLim.textContent = money(state.caps.day, state.currency ?? '¥')
    pill.title = `今日 ${money(state.spend.day, state.currency)} / ${money(state.caps.day, state.currency)}\n近一小时 ${money(
      state.spend.hour,
      state.currency,
    )} / ${money(state.caps.hour, state.currency)}\n这一轮 ${money(state.spend.turn, state.currency)} / ${money(
      state.caps.turn,
      state.currency,
    )}`
  }

  /* ---------------- 面板 ---------------- */

  /** /state 里的配置到位了没（config.caps 在）。没到位就不建面板：
      宿主启动时可能先回一份还没有 config 的快照，拿它建会把三道闸的
      输入框钉成 0，用户一点「保存」就等于把闸门全关了。 */
  function capsReady(state = S.state) {
    const caps = state?.config?.caps
    return Boolean(caps) && typeof caps === 'object'
  }

  function buildPanel() {
    if (panelBuilt) return true
    if (!capsReady(S.state)) return false
    panelBuilt = true
    const state = S.state
    const cfg = state?.config ?? {}
    const currency = cfg.currency ?? '¥'

    const header = h('header')
    const ttl = h('span', 'ttl', '保险丝')
    const badge = h('span', 'badge num')
    badge.textContent = `今日 ${money(state?.spend?.day, currency)} / ${money(cfg?.caps?.day, currency)}`
    const close = h('button', 'close')
    close.appendChild(ICON_X)
    close.addEventListener('click', () => togglePanel(false))
    header.append(ttl, badge, close)

    const body = h('div', 'body')

    /* 宿主没响应时的顶部提示；轮询回来会自动收起 */
    const offlineBar = h('div', 'offline', '宿主没响应，稍后自动重试')
    offlineBar.style.display = S.offline ? '' : 'none'

    /* 首次使用：只在「今天还没花钱」且没看过时出现一次，措辞就是全套默认值的行为 */
    const spendDay = Number(state?.spend?.day) || 0
    const welcomeByDefault = !welcomeSeen() && Boolean(S.state) && spendDay === 0
    // 「再看一次引导」手动召回时绕开「已看过」和「今天还没花钱」两个条件，只放行这一次。
    const showWelcome = (S.welcomeForce || welcomeByDefault) && Number(cfg?.caps?.day) > 0
    let welcomeBar = null
    if (showWelcome) {
      welcomeBar = h('div', 'welcome')
      welcomeBar.append(
        document.createTextNode('刚装上？先什么都不用改。花到 '),
        h('b', '', money(cfg?.caps?.day, currency)),
        document.createTextNode(' 那天它会拦你一次，越线先降档、再问你。'),
      )
      S.welcomeForce = false
      markWelcome()
    }

    /* 顶部三档实时数字：轮询时只改字，不重建面板 */
    const spendBox = h('div', 'spends')
    const spendCells = {}
    for (const key of ['turn', 'hour', 'day']) {
      const cell = h('div', 'sp')
      const value = h('div', 'v num')
      cell.append(h('div', 'k', SPEND_LABEL[key]), value)
      spendBox.appendChild(cell)
      spendCells[key] = { cell, value }
    }
    spendBox.__cells = spendCells

    /* 外观：跟宿主 / 深色 / 浅色。点了立刻生效（先只改内存），保存时才落盘 */
    const secApp = h('section')
    const appRow = h('div', 'row')
    const appLbl = h('div', 'lbl')
    appLbl.append(document.createTextNode('界面颜色'), h('div', 'hint', '跟宿主 = 自动读当前界面深浅'))
    const seg = h('div', 'seg')
    const appBtns = new Map()
    const markAppearance = (value) => {
      const picked = normAppearance(value)
      for (const [key, btn] of appBtns) btn.classList.toggle('on', key === picked)
    }
    for (const [value, label] of [
      ['auto', '跟宿主'],
      ['dark', '深色'],
      ['light', '浅色'],
    ]) {
      const btn = h('button', '', label)
      btn.type = 'button'
      btn.title = value === 'auto' ? '跟着宿主界面的深浅走' : `一直用${label}`
      btn.addEventListener('click', () => {
        // 先只记在内存里：下一次轮询回来的还是旧配置，不能把刚点的选择盖回去。
        S.appearancePick = value
        cfg.appearance = value
        markPanelDirty()
        markAppearance(value)
        applyTheme()
      })
      appBtns.set(value, btn)
      seg.appendChild(btn)
    }
    markAppearance(themeSetting())
    appRow.append(appLbl, seg)
    secApp.append(h('h4', '', '外观'), appRow)

    /* 开关区 */
    const sec1 = h('section')
    sec1.appendChild(h('h4', '', '总开关'))
    sec1.appendChild(toggleRow('启用熔断', '关掉之后只记账，不拦任何请求', cfg.enabled !== false, (on) => {
      cfg.enabled = on
    }))
    sec1.appendChild(toggleRow('显示药丸', '右下角那枚今日花费，关掉就只剩弹卡', cfg.pill !== false, (on) => {
      cfg.pill = on
    }))
    sec1.appendChild(
      toggleRow('越线先问我一嘴', '关着就越线直接换便宜模型接着跑，不打断你；打开才弹卡等你点', cfg.askOnTrip === true, (on) => {
        cfg.askOnTrip = on
      }),
    )

    /* 三道闸 */
    const sec2 = h('section')
    sec2.appendChild(h('h4', '', '三道闸（超过就拦；单位跟价目表一致）'))
    const inputs = {}
    // /state 顶层和 config 里各有一份 caps。哪个有数用哪个：顶层是「生效值」，
    // 配置里那份可能因为历史保存而落后（实测踩过：config 里是 0，顶层是对的，
    // 结果输入框画成 0，用户一点保存就把三道闸全关了）。
    const capsSrc = state?.caps ?? cfg?.caps ?? {}
    // 给轮询留一个把手：万一建面板那一刻配置还没齐、输入框画成了 0，
    // 下次 /state 回来就能就地纠正（用户没动过才纠正，动过就尊重用户）。
    panel.__caps = inputs

    /* 一键预设：省得用户自己去猜 5/15/50 合不合适；点一下只填数字。 */
    const presetRow = h('div', 'presets')
    const presetList = []
    const paintPresets = () => {
      for (const item of presetList) {
        const same = ['turn', 'hour', 'day'].every((key) => (Number(inputs[key]?.value) || 0) === item.caps[key])
        item.btn.classList.toggle('on', same)
      }
    }
    for (const preset of CAP_PRESETS) {
      const btn = h('button', '', preset.label)
      btn.type = 'button'
      btn.title = `${preset.caps.turn} / ${preset.caps.hour} / ${preset.caps.day}（单轮 / 近一小时 / 每日）——只是填数字，点「保存」才生效`
      btn.addEventListener('click', () => {
        for (const key of ['turn', 'hour', 'day']) inputs[key].value = String(preset.caps[key])
        markPanelDirty()
        paintPresets()
      })
      presetList.push({ btn, caps: preset.caps })
      presetRow.appendChild(btn)
    }
    sec2.append(presetRow, h('div', 'sub', '点一下只是填数字，还要点下面的「保存」才生效。'))

    for (const [key, label, hint] of [
      ['turn', '单轮', '一次「发一句话→跑完」最多花多少'],
      ['hour', '近一小时', '滚动一小时，防短时间连环爆'],
      ['day', '每日', '本地零点换日'],
    ]) {
      const row = h('div', 'row')
      const lbl = h('div', 'lbl')
      lbl.append(document.createTextNode(label), h('div', 'hint', hint))
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '0'
      input.step = '0.5'
      // 优先用「生效值」capsSrc，退回 config.caps，全都没有才写 0。
      input.value = String(capsSrc[key] ?? cfg?.caps?.[key] ?? 0)
      input.addEventListener('input', paintPresets)
      inputs[key] = input
      row.append(lbl, input, h('span', 'unit', currency))
      sec2.appendChild(row)
    }
    paintPresets()

    /* 越线之后：下拉建议 + 可手写，留空 = 不降档 */
    const sec3 = h('section')
    sec3.appendChild(h('h4', '', '越线之后降到哪个模型'))
    // 候选分三层：当前线路真能用的（catalog）在前，其他来源见过的排后面。
    const options = modelOptions(state)
    const knownModels = options.all
    const onLine = options.catalog
    const offLine = options.others

    const degCol = h('div', 'col')
    const degLbl = h('div', 'lbl', '降档目标')
    // 真下拉：之前用 datalist，很多人根本不知道要打字才会弹候选，等于不能选。
    const degSelect = document.createElement('select')
    degSelect.className = 'fz-select'
    const CUSTOM = '__custom__'
    const currentDeg = String(cfg?.degradeTo?.model ?? '')
    const opt = (value, text, parent = degSelect) => {
      const o = document.createElement('option')
      o.value = value
      o.textContent = text
      parent.appendChild(o)
      return o
    }
    opt('', '不降档（越线只问我）')
    if (onLine.length > 0) {
      // 默认组 = 这条线真有的型号（不写组名，别再给默认路径加一层噪音）。
      for (const name of onLine) opt(name, name)
      // 别的线路见过的单独一组：不分组会让人以为降过去也能用，实测那样会把请求打死。
      if (offLine.length > 0) {
        const group = document.createElement('optgroup')
        group.label = '其他线路见过的'
        for (const name of offLine) opt(name, name, group)
        degSelect.appendChild(group)
      }
    } else {
      // 没拿到 catalog（宿主还没给、或这条线查不到）：退回老样子平铺。
      for (const name of knownModels) opt(name, name)
    }
    opt(CUSTOM, '其他…（手填型号）')
    const inList = currentDeg === '' || knownModels.includes(currentDeg)
    degSelect.value = inList ? currentDeg : CUSTOM

    const degInput = document.createElement('input')
    degInput.type = 'text'
    degInput.value = currentDeg
    degInput.placeholder = '填一个你线路上便宜些的型号'
    degInput.autocomplete = 'off'
    degInput.spellcheck = false
    degInput.title = '填你这条线路上真实存在的便宜型号；留空就不降档'
    degInput.style.display = inList ? 'none' : ''
    // 这行灰字是「下拉里哪些型号真能用」的唯一说明；轮询里只改字，不重建面板。
    const degNote = h('div', 'hint degNote')

    degSelect.addEventListener('change', () => {
      const custom = degSelect.value === CUSTOM
      degInput.style.display = custom ? '' : 'none'
      if (!custom) degInput.value = degSelect.value
      if (custom) degInput.focus()
      paintSuggestion()
    })
    degInput.addEventListener('input', () => paintSuggestion())

    /** 保存时取实际生效的型号：选了「其他…」就以手填的为准。 */
    const readDegrade = () => (degSelect.value === CUSTOM ? degInput.value.trim() : degSelect.value).trim()

    /* 没配降档目标时，挑一个输入/输出两项都更便宜的型号当建议；
       只是建议 —— 不写配置，不替用户做决定。 */
    const sugRow = h('div', 'sug')
    const sugTxt = h('span', 'sugTxt')
    const sugBtn = h('button', 'mini', '')
    sugBtn.type = 'button'
    sugRow.append(sugTxt, sugBtn)
    sugRow.style.display = 'none'

    const priceAt = (name) => {
      const own = cfg?.prices?.[name]
      const price = own ?? state?.prices?.[name]
      return price && typeof price === 'object' ? price : null
    }
    // 当前模型：有挂起的卡就用卡上那个，否则用宿主排在最前面的（最近真跑过的）。
    const currentModel = () => {
      const pending = state?.pending?.[0]?.model
      if (typeof pending === 'string' && pending !== '') return pending
      const first = Array.isArray(state?.models) ? state.models[0] : ''
      return typeof first === 'string' ? first : ''
    }
    const cheapPick = () => {
      const from = currentModel()
      const base = priceAt(from)
      if (from === '' || !base) return null
      const inNow = Number(base.input)
      const outNow = Number(base.output)
      if (!Number.isFinite(inNow) || !Number.isFinite(outNow)) return null
      let best = null
      for (const name of knownModels) {
        if (name === from) continue
        const price = priceAt(name)
        if (!price) continue
        const input = Number(price.input)
        const output = Number(price.output)
        // 两项都得严格更小：只便宜一项的型号，降过去可能更贵。
        if (!Number.isFinite(input) || !Number.isFinite(output)) continue
        if (!(input < inNow && output < outNow)) continue
        if (!best || input + output < best.input + best.output) best = { name, input, output }
      }
      return best
    }
    const tile = (value) => String(Math.round(value * 100) / 100)
    const paintSuggestion = () => {
      const pick = readDegrade() === '' ? cheapPick() : null
      if (!pick) {
        sugRow.style.display = 'none'
        return
      }
      sugTxt.textContent = `${pick.name} 两项单价都更低（输入 ${tile(pick.input)} / 输出 ${tile(
        pick.output,
      )} 元每百万）`
      sugBtn.textContent = `用 ${pick.name}`
      sugBtn.title = '填进「降档目标」，点「保存」后生效'
      sugRow.style.display = ''
    }
    sugBtn.addEventListener('click', () => {
      const pick = cheapPick()
      if (!pick) return
      markPanelDirty()
      if (knownModels.includes(pick.name)) {
        degSelect.value = pick.name
        degInput.value = pick.name
        degInput.style.display = 'none'
      } else {
        degSelect.value = CUSTOM
        degInput.value = pick.name
        degInput.style.display = ''
      }
      paintSuggestion()
      showToast('已填入，点「保存」生效')
    })

    degCol.append(degLbl, degSelect, degInput, degNote)
    sec3.appendChild(degCol)
    sec3.appendChild(sugRow)
    sec3.appendChild(h('div', 'empty', '留空 = 不降档：越线时只问你，或者停。'))
    paintSuggestion()

    /* 数据目录 */
    const secDir = h('section')
    secDir.appendChild(h('h4', '', '数据目录'))
    const dirCol = h('div', 'col')
    const dirLbl = h('div', 'lbl')
    dirLbl.append(document.createTextNode('保存位置'), h('div', 'hint', '账本和审计记录放这儿，默认在 C 盘'))
    const dirInput = document.createElement('input')
    dirInput.type = 'text'
    dirInput.value = typeof cfg?.dataDir === 'string' ? cfg.dataDir : ''
    dirInput.placeholder = '留空 = 用默认位置'
    dirInput.autocomplete = 'off'
    dirInput.spellcheck = false
    const dirNow = h('div', 'dirNow')
    dirNow.style.display = 'none'
    dirCol.append(dirLbl, dirInput, dirNow)
    secDir.appendChild(dirCol)

    /* 价目表：默认只露一行，免得把面板挤满 */
    const sec4 = h('section')
    sec4.appendChild(h('h4', '', '价目表（元 / 百万 token，可改）'))
    const priceHead = h('div', 'priceHead')
    for (const label of ['模型', '输入', '命中缓存', '输出', '']) priceHead.appendChild(h('span', '', label))
    sec4.appendChild(priceHead)
    const priceBox = h('div', 'priceBox')
    sec4.appendChild(priceBox)
    const priceBtns = h('div', 'priceBtns')
    const moreBtn = h('button', 'mini', '+ 再加一行')
    const toggleBtn = h('button', 'mini', '')
    priceBtns.append(toggleBtn, moreBtn)
    sec4.appendChild(priceBtns)
    const priceRows = []
    let priceExpanded = false
    let featuredRow = null

    function applyPriceView() {
      for (const row of priceRows) {
        row.classList.toggle('rowOff', !priceExpanded && row !== featuredRow)
      }
      toggleBtn.style.display = priceRows.length <= 1 ? 'none' : ''
      toggleBtn.textContent = priceExpanded ? '收起' : `显示全部（${priceRows.length} 行）`
    }

    function addPriceRow(name, price) {
      const row = h('div', 'priceRow')
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.value = name
      nameInput.placeholder = '模型名'
      nameInput.autocomplete = 'off'
      nameInput.spellcheck = false
      nameInput.style.width = '100%'
      const mk = (value) => {
        const input = document.createElement('input')
        input.type = 'number'
        input.min = '0'
        input.step = '0.01'
        input.value = value === undefined || value === null ? '' : String(value)
        input.style.width = '100%'
        return input
      }
      const i1 = mk(price?.input)
      const i2 = mk(price?.cacheRead)
      const i3 = mk(price?.output)
      const del = h('button', 'del', '×')
      del.title = '删掉这一行'
      del.addEventListener('click', () => {
        const at = priceRows.indexOf(row)
        if (at >= 0) priceRows.splice(at, 1)
        row.remove()
        if (featuredRow === row) featuredRow = priceRows[0] ?? null
        markPanelDirty()
        applyPriceView()
      })
      row.append(nameInput, i1, i2, i3, del)
      row.__name = () => nameInput.value.trim()
      row.__read = () => ({
        name: nameInput.value.trim(),
        price: { input: Number(i1.value) || 0, cacheRead: Number(i2.value) || 0, output: Number(i3.value) || 0 },
      })
      priceRows.push(row)
      priceBox.appendChild(row)
      applyPriceView()
      return row
    }

    const prices = state?.prices ?? {}
    for (const [name, price] of Object.entries(prices)) {
      if (name === '*') continue
      addPriceRow(name, price)
    }
    const custom = state?.config?.prices ?? {}
    for (const [name, price] of Object.entries(custom)) {
      if (prices[name] !== undefined) continue
      addPriceRow(name, price)
    }

    // 默认露哪一行：当前降档目标那一行；没有目标是第一行。
    const targetName = degInput.value.trim()
    featuredRow = priceRows.find((row) => row.__name() === targetName) ?? priceRows[0] ?? null
    applyPriceView()

    toggleBtn.addEventListener('click', () => {
      priceExpanded = !priceExpanded
      applyPriceView()
    })
    moreBtn.addEventListener('click', () => {
      const row = addPriceRow('', { input: 2, cacheRead: 0.2, output: 3 })
      featuredRow = row
      markPanelDirty()
      applyPriceView()
      const nameInput = row.firstChild
      if (nameInput && typeof nameInput.focus === 'function') nameInput.focus()
    })

    /* 高级：第三方中转站倍率 + 按 token 卡。默认收起，免得把面板挤满 */
    const secAdv = h('section')
    const advHead = h('div', 'advHead')
    advHead.setAttribute('role', 'button')
    advHead.setAttribute('tabindex', '0')
    const chev = h('span', 'chev', '▶')
    const advAside = h('span', 'aside', '中转站倍率 / 按 token 卡')
    advHead.append(chev, h('h4', '', '高级'), advAside)
    const advBody = h('div', 'advBody')
    let advOpen = false
    const paintAdv = () => {
      advBody.classList.toggle('open', advOpen)
      advHead.classList.toggle('open', advOpen)
      advHead.setAttribute('aria-expanded', advOpen ? 'true' : 'false')
      advHead.title = advOpen ? '收起高级' : '展开：第三方倍率、按 token 卡'
    }
    const flipAdv = () => {
      advOpen = !advOpen
      paintAdv()
    }
    advHead.addEventListener('click', flipAdv)
    advHead.addEventListener('keydown', (event) => {
      if (event?.key === 'Enter' || event?.key === ' ' || event?.key === 'Spacebar') {
        if (typeof event.preventDefault === 'function') event.preventDefault()
        flipAdv()
      }
    })
    paintAdv()

    /* 供应商倍率：同一个模型名在不同中转站能差几倍，按 id 打折记账 */
    advBody.appendChild(h('div', 'sub', '用第三方中转站时填倍率，按它打折记账；留空或 1 = 原价。'))
    const provHead = h('div', 'provHead')
    provHead.append(h('span', '', '供应商 id'), h('span', '', '倍率'), h('span', '', ''))
    const provList = h('div')
    const provRows = []
    // 宿主知道的供应商 id 只当候选（datalist），不自动建行 —— 否则一展开就是几十行。
    const provIds = []
    for (const item of providerEntries(state?.providers)) {
      if (item.id && !provIds.includes(item.id)) provIds.push(item.id)
    }

    function addProvRow(id, multiplier) {
      const row = h('div', 'provRow')
      const idInput = document.createElement('input')
      idInput.type = 'text'
      idInput.value = typeof id === 'string' ? id : ''
      idInput.placeholder = provIds[0] ?? 'openrouter'
      idInput.title = '第三方中转站 / 网关的供应商 id，比如 openrouter'
      idInput.autocomplete = 'off'
      idInput.spellcheck = false
      if (provIds.length > 0) idInput.setAttribute('list', PROV_LIST_ID)
      const mInput = document.createElement('input')
      mInput.type = 'number'
      mInput.min = '0'
      mInput.step = '0.01'
      mInput.placeholder = '1'
      mInput.title = '倍率：0.3 = 按三折记账；留空或 1 = 原价'
      const m = Number(multiplier)
      mInput.value = multiplier === undefined || multiplier === null || multiplier === '' || !Number.isFinite(m) ? '' : String(m)
      const del = h('button', 'del', '×')
      del.type = 'button'
      del.title = '删掉这一行'
      del.addEventListener('click', () => {
        const at = provRows.indexOf(row)
        if (at >= 0) provRows.splice(at, 1)
        row.remove()
        markPanelDirty()
      })
      // 保存时读这一行：空 id 不发（别拿空 key 去脏配置），倍率非法整行跳过。
      row.__read = () => {
        const name = idInput.value.trim()
        if (name === '') return null
        const raw = mInput.value.trim()
        const value = raw === '' ? 1 : Number(raw)
        if (!Number.isFinite(value) || value < 0) return null
        return { id: name, multiplier: value }
      }
      row.append(idInput, mInput, del)
      provRows.push(row)
      provList.appendChild(row)
      return row
    }

    const customProviders = providerEntries(cfg?.providers)
    for (const item of customProviders) addProvRow(item.id, item.multiplier)
    // 一行都没有时留一个空行，不然「高级」展开像坏了。
    if (provRows.length === 0) addProvRow('', '')
    if (provIds.length > 0) {
      const provDatalist = document.createElement('datalist')
      provDatalist.id = PROV_LIST_ID
      for (const id of provIds) {
        const option = document.createElement('option')
        option.value = id
        provDatalist.appendChild(option)
      }
      provList.appendChild(provDatalist)
    }
    const provBtns = h('div', 'priceBtns')
    const provMore = h('button', 'mini', '+ 再加一行')
    provMore.type = 'button'
    provMore.addEventListener('click', () => {
      const row = addProvRow('', '')
      markPanelDirty()
      const first = row.firstChild
      if (first && typeof first.focus === 'function') first.focus()
    })
    provBtns.appendChild(provMore)
    advBody.append(provHead, provList, provBtns)

    /* 按 token 卡：不知道单价时的兜底。单位「万 token」，0 = 关 */
    advBody.appendChild(h('div', 'sub', '不知道单价就按 token 卡；0 = 关。'))
    const tokRow = h('div', 'tokRow')
    const tokInputs = {}
    for (const key of ['turn', 'hour', 'day']) {
      const cell = h('div')
      cell.appendChild(h('div', 'k', SPEND_LABEL[key]))
      const fld = h('div', 'fld')
      const input = document.createElement('input')
      input.type = 'number'
      input.min = '0'
      input.step = '1'
      input.placeholder = '0'
      input.title = `${SPEND_LABEL[key]}最多用多少万 token；0 = 这一道关掉`
      const was = Number(cfg?.capsTokens?.[key] ?? state?.capsTokens?.[key])
      input.value = Number.isFinite(was) && was > 0 ? String(was) : ''
      tokInputs[key] = input
      fld.append(input, h('span', 'u', '万'))
      cell.appendChild(fld)
      tokRow.appendChild(cell)
    }
    advBody.appendChild(tokRow)

    secAdv.append(advHead, advBody)

    /* 最近拦截 */
    const sec5 = h('section')
    sec5.appendChild(h('h4', '', '最近的拦截'))
    const audit = h('div', 'audit')
    audit.textContent = '读取中…'
    sec5.appendChild(audit)

    body.append(...[offlineBar, welcomeBar, spendBox, secApp, sec1, sec2, sec3, secDir, sec4, secAdv, sec5].filter(Boolean))

    const footer = h('footer')
    const save = h('button', 'primary', '保存')
    const reveal = h('button', '', '复制数据目录')
    const grow = h('span', 'grow')
    const welcomeAgain = h('button', 'link', '再看一次引导')
    welcomeAgain.type = 'button'
    welcomeAgain.title = '把顶部那条首次使用提示再显示一遍'
    welcomeAgain.addEventListener('click', () => {
      welcomeSeenFallback = false
      try {
        localStore()?.removeItem(WELCOME_KEY)
      } catch {
        // 存储只读 / 不可用：清不掉也还有本次会话的 force 兜着
      }
      S.welcomeForce = true
      rebuildPanel()
    })
    footer.append(save, grow, welcomeAgain, reveal)

    save.addEventListener('click', () => {
      const next = {
        enabled: cfg.enabled,
        pill: cfg.pill,
        // 默认 false：越线直接降档，不挂起请求（挂起会把一整轮任务钉住）。
        askOnTrip: cfg.askOnTrip === true,
        appearance: normAppearance(cfg.appearance),
        caps: {
          turn: Number(inputs.turn.value) || 0,
          hour: Number(inputs.hour.value) || 0,
          day: Number(inputs.day.value) || 0,
        },
        // 万 token / 0 = 关；空行、乱填、负数都落成 0。
        capsTokens: {
          turn: readCap(tokInputs.turn),
          hour: readCap(tokInputs.hour),
          day: readCap(tokInputs.day),
        },
        providers: {},
        degradeTo: { ...(cfg.degradeTo ?? {}), model: readDegrade() },
        dataDir: dirInput.value.trim(),
        prices: {},
      }
      for (const row of priceBox.children) {
        const read = row.__read?.()
        if (!read || read.name === '') continue
        next.prices[read.name] = read.price
      }
      for (const row of provRows) {
        const read = row.__read?.()
        if (!read) continue
        next.providers[read.id] = { multiplier: read.multiplier }
      }
      save.disabled = true
      void api('/config', { method: 'POST', body: JSON.stringify({ config: next }) }).then((res) => {
        if (res?.ok) {
          // 用宿主回的合并结果重画：连着改两次时，第二次提交的才是新值，
          // 而不是这次从旧快照里带出来的值。
          if (res.config) S.state = { ...(S.state ?? {}), config: res.config }
          // 已经落盘了，就不需要那个「还没保存的选择」再压着配置。
          S.appearancePick = null
          // 刚落盘：之前那些输入不再算「未保存的改动」，重开可以放心按 /state 重画。
          S.panelDirty = false
          rebuildPanel()
          showToast('已保存')
          void poll(true)
        } else {
          save.disabled = false
          showToast('保存失败：宿主没应答')
        }
      })
    })

    reveal.addEventListener('click', () => {
      // 不再调系统文件管理器（那需要插件起子进程，多个市场会把它当成需要复核的能力）。
      // 改成把路径放进剪贴板：用户粘到资源管理器地址栏一样能进。
      void (async () => {
        const res = await api('/reveal', { method: 'POST', body: '{}' })
        const dir = res?.dir ?? S.state?.dataDir ?? ''
        if (dir === '') {
          showToast('没拿到数据目录')
          return
        }
        try {
          await navigator.clipboard.writeText(dir)
          showToast(`路径已复制：${dir}`)
        } catch {
          showToast(`数据目录：${dir}`)
        }
      })()
    })

    panel.append(header, body, footer)
    panel.__audit = audit
    panel.__spend = spendBox
    panel.__badge = badge
    panel.__dirNow = dirNow
    panel.__catalogHint = degNote
    panel.__mark = markAppearance
    panel.__offline = offlineBar
    // 记下建面板时配置到底全不全：万一旧路径留下一个拿空 state 建的面板，
    // 轮询拿到完整配置后可以据此自动重画一次。
    panel.__capsOk = capsReady(state)
    paintSpend(S.state)
    paintDir(S.state)
    paintCatalog(S.state)

    function toggleRow(label, hint, checked, onChange) {
      const row = h('div', 'row')
      const lbl = h('div', 'lbl')
      lbl.append(document.createTextNode(label), h('div', 'hint', hint))
      const sw = h('label', 'sw')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = checked
      input.addEventListener('change', () => onChange(input.checked))
      const knob = h('i')
      sw.append(input, knob)
      row.append(lbl, sw)
      return row
    }

    return true
  }

  /** 面板上那三档数字 + 标题里的今日徽标：只改字，不动输入框。 */
  function paintSpend(state) {
    const box = panel.__spend
    const spend = state?.spend ?? {}
    const caps = state?.config?.caps ?? state?.caps ?? {}
    const currency = state?.currency ?? '¥'
    const warn = typeof state?.warnRatio === 'number' ? state.warnRatio : 0.6
    // token 闸：配置里是「万 token」，账上是 token，这里换算成 token 再跟金额那道比。
    const capsTokens = state?.config?.capsTokens ?? state?.capsTokens ?? {}
    const spentTokens = spend.tokens ?? {}
    if (box && box.__cells) {
      for (const key of ['turn', 'hour', 'day']) {
        const cell = box.__cells[key]
        const spent = Number(spend[key]) || 0
        const cap = Number(caps[key]) || 0
        // 0 表示这道闸没开，别算成超线。
        const moneyRatio = cap > 0 ? spent / cap : 0
        const tokenCap = Math.max(0, Number(capsTokens[key]) || 0) * 10000
        const tokenSpent = Math.max(0, Number(spentTokens[key]) || 0)
        const tokenRatio = tokenCap > 0 ? tokenSpent / tokenCap : 0
        if (tokenCap > 0 && tokenRatio > moneyRatio) {
          // token 闸开着而且比金额那道更吃紧：这一格改报 token（例：1.2万/5万）。
          cell.value.textContent = `${wan(tokenSpent)}/${wan(tokenCap)}`
          cell.value.title = `按 token 卡：${Math.round(tokenSpent)} / ${Math.round(tokenCap)} token`
          cell.cell.classList.toggle('warn', tokenRatio >= warn && tokenRatio < 1)
          cell.cell.classList.toggle('hot', tokenRatio >= 1)
        } else {
          cell.value.textContent = `${money(spent, currency)} / ${money(cap, currency)}`
          cell.value.title = ''
          cell.cell.classList.toggle('warn', moneyRatio >= warn && moneyRatio < 1)
          cell.cell.classList.toggle('hot', moneyRatio >= 1)
        }
      }
    }
    if (panel.__badge) {
      panel.__badge.textContent = `今日 ${money(spend.day, currency)} / ${money(caps.day, currency)}`
    }
  }

  /** 外观按钮的高亮跟着「当前实际生效的选择」走（还没保存的选择优先）。 */
  function paintAppearance() {
    if (typeof panel.__mark === 'function') panel.__mark(themeSetting())
  }

  /** 数据目录那行灰字：宿主告诉实际放哪就显示哪，没说就先藏着。 */
  function paintDir(state) {
    const el = panel.__dirNow
    if (!el) return
    const dir = typeof state?.dataDir === 'string' ? state.dataDir.trim() : ''
    if (dir === '') {
      el.style.display = 'none'
      return
    }
    el.textContent = `现在放在：${dir}`
    el.title = dir
    el.style.display = ''
  }

  /**
   * 降档目标下面那行灰字：告诉用户下拉里哪些型号是这条线真能用的。
   * 每次轮询都跟着 /state 重画这一行，但只改 textContent —— 不碰 select、
   * 不重建面板、不抢焦点，用户正在手填的型号也不会被冲掉。
   */
  function paintCatalog(state) {
    const el = panel.__catalogHint
    if (!el) return
    const options = modelOptions(state)
    const count = options.catalog.length
    if (count > 0) {
      const line = options.provider === '' ? '当前线路' : `当前线路（${options.provider}）`
      el.textContent = `${line}可用 ${count} 个型号`
      el.title = '这些是宿主从当前线路读到的型号；「其他线路见过的」不保证这条线能用'
    } else {
      el.textContent = '没读到当前线路的型号列表，请确认型号在该线路可用'
      el.title = ''
    }
  }

  /** 宿主没响应的提示条：轮询通了就收起来，不重画面板。 */
  function paintOffline(flag) {
    const el = panel.__offline
    if (el) el.style.display = flag ? '' : 'none'
  }

  /**
   * 把「输入框里的 0」纠正成 /state 里的真值。
   * 只在用户还没动过（!S.panelDirty）时动手；动过就保留现场。
   */
  function syncCaps(state) {
    const caps = state?.caps ?? state?.config?.caps
    const boxes = panel.__caps
    if (!caps || !boxes) return
    if (S.panelDirty) return
    for (const key of ['turn', 'hour', 'day']) {
      const el = boxes[key]
      if (!el) continue
      const want = Number(caps[key])
      const has = Number(el.value)
      if ((!Number.isFinite(has) || has === 0) && Number.isFinite(want) && want > 0) el.value = String(want)
    }
  }

  /** 保存成功后按宿主回的配置重画面板（旧快照不会再把新值盖回去）。 */
  function rebuildPanel() {
    if (!panel.__spend) return buildPanel()
    // 拿不到完整配置就先别拆：拆了只会留下一个空壳，下次还得重来。
    if (!capsReady(S.state)) return false
    const wasOpen = S.panelOpen
    panel.innerHTML = ''
    panelBuilt = false
    panel.__audit = null
    panel.__spend = null
    panel.__badge = null
    panel.__dirNow = null
    panel.__catalogHint = null
    panel.__mark = null
    panel.__offline = null
    panel.__capsOk = null
    try {
      if (!buildPanel()) throw new Error('state 里没有 config.caps')
      // 面板已经按最新配置重建过：之前的改动都落盘（或已作废）了，清脏。
      S.panelDirty = false
      if (wasOpen) panel.classList.remove('hidden')
      paintOffline(S.offline)
      void refreshAudit()
      return true
    } catch (error) {
      if (typeof console !== 'undefined') console.warn('[dsh-fuse] 面板重画失败：', error)
      // 重画坏了就把面板收掉，下次点开重新建，别留一半空壳在那儿。
      panelBuilt = false
      panel.innerHTML = ''
      panel.__audit = null
      panel.__spend = null
      panel.__badge = null
      panel.__dirNow = null
      panel.__catalogHint = null
      panel.__mark = null
      panel.__offline = null
      panel.__capsOk = null
      showToast('面板没刷新成，重开一下')
      togglePanel(false)
      return false
    }
  }

  async function refreshAudit() {
    if (!panel.__audit) return
    const res = await api('/audit?limit=12')
    if (!res) {
      // 宿主没应答：已经读到的记录留着，空的时候就说是没连上，别说成「没拦过」。
      if (panel.__audit.childElementCount === 0) panel.__audit.textContent = '宿主没响应，稍后自动重试'
      return
    }
    const rows = Array.isArray(res?.rows) ? res.rows : []
    panel.__audit.innerHTML = ''
    if (rows.length === 0) {
      panel.__audit.appendChild(h('div', 'empty', '还没有拦过——保险丝没跳过，就是它最好的状态。'))
      return
    }
    for (const row of rows.slice().reverse()) {
      const line = h('div')
      const when = new Date(row.t)
      const time = h('span', 't', `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`)
      const act = h('span', `a ${row.action ?? ''}`, { degrade: '降档', 'degrade-silent': '静默降档', 'pass-once': '放行', stop: '停止' }[row.action] ?? row.action)
      const scopeWord = row.scope === 'turn' ? '本轮' : row.scope === 'hour' ? '一小时' : '今日'
      // 历史记录里 token 闸的行也按 token 写，别拿「¥」去糊它。
      const amount =
        row.unit === 'tokens' ? `${wan(row.spent)} / ${wan(row.cap)} token` : `${money(row.spent)} / ${money(row.cap)}`
      const detail = h('span', '', `${scopeWord} ${amount}${row.to ? ` → ${row.to}` : ''}`)
      line.append(time, act, detail)
      panel.__audit.appendChild(line)
    }
  }

  function togglePanel(force) {
    const open = force === undefined ? !S.panelOpen : force
    if (!open) {
      S.panelOpen = false
      panel.classList.add('hidden')
      return
    }
    S.panelOpen = true
    if (!panelBuilt) {
      // 配置还没到：先别建（建了就是 0 的输入框），下一次轮询补上或再点一次。
      if (!buildPanel()) {
        S.panelOpen = false
        panel.classList.add('hidden')
        return
      }
    } else if (!S.panelDirty) {
      // 没有未保存的改动：每次打开都按最新 /state 重画，别拿旧快照糊用户。
      // 有改动时保留现场（下面照常只刷数字），不让轮询把输入冲掉。
      if (!rebuildPanel()) {
        S.panelOpen = false
        return
      }
    }
    panel.classList.remove('hidden')
    paintSpend(S.state)
    paintDir(S.state)
    paintCatalog(S.state)
    paintAppearance()
    paintOffline(S.offline)
    void refreshAudit()
  }

  /* Esc 只做「退一步」：先收卡，再收面板。卡上按 Esc 走「降档继续」而不是
     「停止本轮」—— 半夜误触时把请求停掉最气人，降档才是安全的一侧。 */
  function onKeydown(event) {
    if (!S.mounted || event?.isComposing || event?.key !== 'Escape') return
    const cardUp = !card.classList.contains('hidden')
    const panelUp = S.panelOpen
    if (!cardUp && !panelUp) return
    if (typeof event.preventDefault === 'function') event.preventDefault()
    if (cardUp) decide('degrade')
    else togglePanel(false)
  }

  /* ---------------- 轮询 ---------------- */

  async function poll(immediate) {
    if (!S.mounted) return
    if (!immediate && typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedule()
      return
    }
    const res = await api('/state')
    if (res?.ok) {
      S.offline = false
      S.state = res
      applyTheme()
      renderPill()
      const pending = Array.isArray(res.pending) ? res.pending[0] : null
      if (pending) {
        renderCard(pending)
        S.shownPending = pending.id
      } else if (S.shownPending !== null) {
        hideCard()
      }
      // 旧路径留下一个拿不完整 state 建的面板：现在配置齐了、又没有未保存的
      // 改动，就重画一次，别让 0 的输入框一直挂着。
      if (panelBuilt && !S.panelDirty && panel.__capsOk === false && capsReady(res)) {
        rebuildPanel()
      }
      // 模型目录是宿主异步读出来的（第三方网关可能几秒到几分钟才有）。
      // 目录一变就重画一次，免得降档下拉里一直是「一个型号都没有」的旧名单；
      // 用户动过面板（有未保存改动）就不动它。
      const catalogSig = `${res?.catalog?.provider ?? ''}|${(res?.catalog?.models ?? []).join(',')}`
      if (catalogSig !== S.catalogSig) {
        S.catalogSig = catalogSig
        if (panelBuilt && !S.panelDirty && capsReady(res)) rebuildPanel()
      }
      if (S.panelOpen) {
        // 上次打开时配置还没到：这里补建一次（再点一次药丸也会重建）。
        let justBuilt = false
        if (!panelBuilt && capsReady(res)) justBuilt = buildPanel()
        if (justBuilt) panel.classList.remove('hidden')
        if (panelBuilt) {
          // 面板开着时，只刷新数字（不重绘，免得打断输入）。
          syncCaps(res)
          paintSpend(res)
          paintDir(res)
          paintCatalog(res)
          paintAppearance()
          paintOffline(false)
          if (justBuilt) void refreshAudit()
        }
      }
    } else {
      // 宿主重启 / 端口还没起来：留着上一次的数字，只把状态标成「没连上」。
      S.offline = true
      renderPill()
      paintOffline(true)
    }
    schedule()
  }

  function schedule() {
    if (S.timer) clearTimeout(S.timer)
    S.timer = setTimeout(() => void poll(false), POLL_MS)
  }

  /* ---------------- 挂载 ---------------- */

  function mount() {
    try {
      mountInner()
    } catch (error) {
      // 挂不上不能把 DSH 的页面带崩，宿主那边还有熔断在跑。
      if (typeof console !== 'undefined') console.warn('[dsh-fuse] 界面挂载失败：', error)
    }
  }

  function mountInner() {
    if (S.mounted) return
    S.mounted = true

    const host = document.createElement('div')
    host.setAttribute('data-dsh-fuse', '')
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000'
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = CSS
    shadow.append(style, root)
    ;[pill, card, toast, panel].forEach((el) => {
      el.style.pointerEvents = 'auto'
      root.appendChild(el)
    })
    document.body.appendChild(host)
    S.host = host
    S.shadow = shadow

    applyTheme()

    // 宿主重排 body 时把自己挂回去；顺带盯深色开关。
    const observer = new MutationObserver(() => {
      if (S.mounted && !document.body.contains(host)) document.body.appendChild(host)
      applyTheme()
    })
    observer.observe(document.body, { childList: true, attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
    S.observer = observer

    try {
      if (typeof window.matchMedia === 'function') {
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const onChange = () => applyTheme()
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange)
        else if (typeof mq.addListener === 'function') mq.addListener(onChange)
        S.mq = { mq, onChange }
      }
    } catch {
      // 读不到系统偏好就用宿主那个开关
    }

    document.addEventListener('visibilitychange', onVisible)
    // capture 阶段先拿到 Esc，免得宿主里别的监听把键吞掉。
    document.addEventListener('keydown', onKeydown, true)
    void poll(true)
  }

  function onVisible() {
    if (document.visibilityState === 'visible') void poll(true)
  }

  // 深色判定：宿主可能把开关挂在 html 上，也可能只在 body；两边都看。
  // config.appearance 是 auto 时按这个顺序走：
  //   ① data-ds-dark-theme 标记；
  //   ② 底色亮度 < 128 判深色；
  //   ③ 文字色亮度 > 160 判深色（深色界面的字是浅的 —— 宿主把背景画在 canvas 上、
  //      backgroundColor 读出来是透明时，只有这条能兜住）；
  //   ④ 最后才问系统偏好。
  // 宁可多读一次，也不要在深色界面里甩出一块白板。
  function themeAttr(el) {
    if (!el) return undefined
    let value
    if (el.dataset && el.dataset.dsDarkTheme !== undefined) value = el.dataset.dsDarkTheme
    else if (typeof el.getAttribute === 'function') value = el.getAttribute('data-ds-dark-theme')
    if (value === null || value === undefined) return undefined
    return value
  }

  /** 把 css 颜色串（rgb / rgba）算成 0–255 的亮度；读不出来返回 null。 */
  function colorLum(raw) {
    if (typeof raw !== 'string') return null
    const m = /^rgba?\(([^)]+)\)/i.exec(raw.trim())
    if (!m) return null
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter((s) => s !== '')
      .map(Number)
    if (parts.length < 3 || !parts.slice(0, 3).every((n) => Number.isFinite(n))) return null
    const alpha = parts.length > 3 ? parts[3] : 1
    if (!Number.isFinite(alpha) || alpha <= 0) return null
    return parts[0] * 0.299 + parts[1] * 0.587 + parts[2] * 0.114
  }

  function styleOf(el, prop) {
    if (!el || typeof getComputedStyle !== 'function') return null
    try {
      const cs = getComputedStyle(el)
      return cs ? cs[prop] : null
    } catch {
      return null
    }
  }

  function bgIsDark(el) {
    const lum = colorLum(styleOf(el, 'backgroundColor'))
    return lum === null ? null : lum < 128
  }

  /** 文字亮 = 深色主题。返回 true / false，拿不准就 null。 */
  function textIsLight(el) {
    const lum = colorLum(styleOf(el, 'color'))
    if (lum === null) return null
    if (lum > 160) return true
    if (lum < 110) return false
    return null
  }

  function systemDark() {
    try {
      return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true
    } catch {
      return true
    }
  }

  function autoDark() {
    const roots = [document.documentElement, document.body].filter(Boolean)
    // ① 宿主直接打了标记：标记在（哪怕是空串）就是深色，明确写 false / light 才排掉。
    for (const el of roots) {
      const value = themeAttr(el)
      if (value === undefined) continue
      return !/^(false|0|light|no|off)$/i.test(String(value).trim())
    }
    // ② 底色：够黑直接算深色；够白先记一笔，继续看文字色（背景可能是透明的）。
    let bgSaysLight = false
    for (const el of roots) {
      const dark = bgIsDark(el)
      if (dark === true) return true
      if (dark === false) bgSaysLight = true
    }
    // ③ 文字色：深色界面里文字是浅的。背景透明时全靠这一条。
    for (const el of roots) {
      const light = textIsLight(el)
      if (light !== null) return light
    }
    // ④ 都读不出来才按系统偏好
    if (bgSaysLight) return false
    return systemDark()
  }

  /** 当前该用哪种外观：面板里刚点还没保存的选择 > 宿主配置 > auto。 */
  function themeSetting() {
    const want = S.appearancePick ?? S.state?.config?.appearance
    return want === 'dark' || want === 'light' ? want : 'auto'
  }

  function applyTheme() {
    const want = themeSetting()
    const dark = want === 'auto' ? autoDark() : want === 'dark'
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
    return dark
  }

  function destroy() {
    S.mounted = false
    if (S.timer) clearTimeout(S.timer)
    if (S.cardTimer) clearInterval(S.cardTimer)
    if (S.toastTimer) clearTimeout(S.toastTimer)
    S.timer = S.cardTimer = S.toastTimer = null
    document.removeEventListener('visibilitychange', onVisible)
    document.removeEventListener('keydown', onKeydown, true)
    try {
      S.observer?.disconnect()
    } catch {
      // 摘不掉也不该把页面弄崩
    }
    S.observer = null
    try {
      if (S.mq) {
        if (typeof S.mq.mq.removeEventListener === 'function') S.mq.mq.removeEventListener('change', S.mq.onChange)
        else if (typeof S.mq.mq.removeListener === 'function') S.mq.mq.removeListener(S.mq.onChange)
      }
    } catch {
      // 同上
    }
    S.mq = null
    S.host?.remove()
    S.host = null
    S.shadow = null
    S.state = null
    S.shownPending = null
    S.panelOpen = false
    S.panelBuilt = false
    S.panelDirty = false
    S.appearancePick = null
    S.offline = false
  }

  return { mount, destroy }
}

/* ------------------------------------------------------------------ *
 * 给 DSH 的入口
 * ------------------------------------------------------------------ */

let ui = null

function apply(ctx) {
  ui = createUi()
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      ui.mount()
      return () => ui.destroy()
    }, 'dsh-fuse')
  } else {
    ui.mount()
  }
}


    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
