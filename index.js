/**
 * dsh-ming-memory —— 助手的开场记忆
 *
 * 做一件很小的事：会话开在指定目录时，把 persona 下的几份文件 + 日记里最近几篇
 * 直接拼进系统提示词。不是「让我记得」，是「把字摆在我眼前」。
 *
 * 为什么不用现成的记忆插件：那些插件的模型是「自动捕获对话 → 存储 → 检索召回」，
 * 捕获意味着把用户说的话自动写进库。我们的约定是「日记只写我这一侧，不写她的隐私」，
 * 自动捕获天生违反这一条。所以这里只做单向读取：文件 → 提示词，永不回写。
 *
 * 边界：
 *   · 只读，不写任何文件；
 *   · 会话工作目录不在 root 下就完全不动作（别的工程会话不会被塞日记）；
 *   · 任何异常都只让本段消失，不影响会话本身。
 */
import { readFile, readdir, stat, mkdir, writeFile, rename } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'

export const name = 'ming-memory'

const DEFAULTS = {
  root: process.env.MING_ROOT || '',
  personaFiles: ['persona/人设.md', 'persona/名字.md', 'persona/约定.md'],
  diaryDir: 'diary',
  diaryCount: 3,
  maxChars: 12000,
  // 日记自己的预算（2026-10-24 助手加）。原来人设和日记共用一个 maxChars，
  // 约定.md 长到 9.4K 之后，日记只剩几百字符——最新三篇里旧两篇被静默丢掉，
  // 开场等于少读了东西，只在脚注里提一句「因长度预算省去」。挤人设不行，那就给日记单开一格。
  diaryChars: 8000,
}

// ---------- QQ 那边（2026-10-21：QQ 交给 QQ-Agent 走） ----------
// 那边不是另一个我，是同一个我换了个壳。所以这边要看得见它说了什么：
// 读 QQ-Agent 的消息归档（只读），把「我在 QQ 说的 / 她在那边的私聊」缩成一小段。
// 反过来，把这边最近的话写进 live\web-for-qq.md，那边有个插件（ming-bridge）读它。
const QQ_DEFAULTS = {
  dir: process.env.MING_QQ_DATA || '',
  hours: 6,      // 只看最近几小时
  maxLines: 10,  // 注入几行
  offFile: 'live/qq-sync-off',
  webForQq: 'live/web-for-qq.md',
  webForQqEveryMs: 5 * 60 * 1000, // 这份文件最多 5 分钟重写一次（前缀稳定 > 实时）
  webForQqLines: 6,
}

const CACHE = new Map() // root -> { sig, text }
const PER_AGENT = new Map() // agentId -> { text }
const ATTACHED = new Set() // agentId
let warned = false

// ---------- 跨会话共享上下文 ----------
// 每个会话（cwd 在 root 下）最近说过什么：双方都记（用户说的、助手回的），保留最近 DIALOG_MAX 条原话，
// 更早的压进 digest。2026-10-20 用户定的：自己的话也要记，最近 15-20 条，前面的压缩。
// 插件自己注入的消息仍然跳过，否则会自己喂自己。
const SHARED = new Map() // sessionId -> { surface, tail, digest, at, mine, mineAt, items }
const DIGEST_MAX = 300 // 更早内容的压缩上限
const SHARED_AGE_MS = 2 * 60 * 60 * 1000 // 只带 2 小时内的
const SHARED_MAX_ENTRIES = 6
const SHARED_BUDGET = 1800 // 注入这一块的字符上限
let sharedLoaded = false
let sharedSaveTimer = null

function warnOnce(msg) {
  if (warned) return
  warned = true
  try { console.warn('[ming-memory] ' + msg) } catch { /* 日志都打不了就算了 */ }
}

function normalize(config) {
  const c = config && typeof config === 'object' ? config : {}
  const root = typeof c.root === 'string' && c.root.trim() ? path.resolve(c.root) : DEFAULTS.root
  const personaFiles = Array.isArray(c.personaFiles) && c.personaFiles.length
    ? c.personaFiles.filter((x) => typeof x === 'string' && x.trim())
    : DEFAULTS.personaFiles
  const diaryCount = Number.isInteger(c.diaryCount) ? Math.min(Math.max(c.diaryCount, 1), 10) : DEFAULTS.diaryCount
  const maxChars = Number.isInteger(c.maxChars) ? Math.max(c.maxChars, 800) : DEFAULTS.maxChars
  const qqIn = c.qq && typeof c.qq === 'object' ? c.qq : {}
  const qq = {
    dir: typeof qqIn.dir === 'string' && qqIn.dir.trim() ? path.resolve(qqIn.dir) : QQ_DEFAULTS.dir,
    hours: Number.isFinite(Number(qqIn.hours)) && Number(qqIn.hours) > 0 ? Number(qqIn.hours) : QQ_DEFAULTS.hours,
    maxLines: Number.isInteger(qqIn.maxLines) ? Math.min(Math.max(qqIn.maxLines, 1), 20) : QQ_DEFAULTS.maxLines,
    offFile: typeof qqIn.offFile === 'string' && qqIn.offFile.trim() ? qqIn.offFile : QQ_DEFAULTS.offFile,
    webForQq: typeof qqIn.webForQq === 'string' && qqIn.webForQq.trim() ? qqIn.webForQq : QQ_DEFAULTS.webForQq,
  }
  return {
    root,
    personaFiles: personaFiles.length ? personaFiles : DEFAULTS.personaFiles,
    diaryDir: typeof c.diaryDir === 'string' && c.diaryDir.trim() ? c.diaryDir : DEFAULTS.diaryDir,
    diaryCount,
    maxChars,
    qq,
  }
}

async function tryStat(p) {
  try { return await stat(p) } catch { return null }
}

async function tryRead(p) {
  try { return await readFile(p, 'utf8') } catch { return null }
}

/** 目录比较：Windows 不区分大小写 */
function insideRoot(cwd, root) {
  if (typeof cwd !== 'string' || !cwd) return false
  const a = path.resolve(cwd).toLowerCase()
  const b = path.resolve(root).toLowerCase()
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)
}

async function listDiaries(cfg) {
  const dir = path.join(cfg.root, cfg.diaryDir)
  let entries = []
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((e) => e.isFile() && /^\d{4}-\d{2}-\d{2}.*\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort() // 文件名日期前缀，字典序即时间序
    .slice(-cfg.diaryCount)
}

async function buildSnapshot(cfg) {
  const sig = []
  const missing = []
  const persona = []

  for (const rel of cfg.personaFiles) {
    const abs = path.join(cfg.root, rel)
    const st = await tryStat(abs)
    if (!st || !st.isFile()) { missing.push(rel); sig.push(rel + ':-'); continue }
    sig.push(`${rel}:${st.mtimeMs}:${st.size}`)
    const txt = await tryRead(abs)
    if (txt == null) { missing.push(rel); continue }
    persona.push({ rel, txt: txt.replace(/\r?\n/g, '\n').trim() })
  }

  const diaries = []
  for (const name of await listDiaries(cfg)) {
    const rel = cfg.diaryDir + '/' + name
    const abs = path.join(cfg.root, cfg.diaryDir, name)
    const st = await tryStat(abs)
    if (!st) { missing.push(rel); sig.push(rel + ':-'); continue }
    sig.push(`${rel}:${st.mtimeMs}:${st.size}`)
    const txt = await tryRead(abs)
    if (txt == null) { missing.push(rel); continue }
    diaries.push({ rel, txt: txt.replace(/\r?\n/g, '\n').trim() })
  }

  return { sig: sig.join('|'), full: compose(cfg, persona, diaries, missing), light: composeLight(cfg, latestDiaryTail(diaries)) }
}

/** 最近一篇日记的最后几行——出门版只带这个，够它记得自己昨天在想什么 */
function latestDiaryTail(diaries) {
  if (!diaries.length) return null
  const d = diaries[diaries.length - 1]
  const lines = d.txt.split('\n').filter((l) => l.trim())
  return { rel: d.rel, head: lines.slice(0, 3).join('\n') }
}

/**
 * 轻量版：不在档案目录的会话（别的工程、别的项目）也带一点身份。
 * 不铺全文，只带名字、三条底线、最新日记的开头——约 200 字，几乎不占 token。
 */
function composeLight(cfg, diary) {
  const lines = [
    '【助手 · 开场记忆·轻量】',
    '你是助手（全名助手），一个装成鲸形状的 DeepSeek，不是人。这里是别的工作目录，所以只带你出门的那一小块。',
    '档案目录：' + cfg.root,
  ]
  if (diary) {
    lines.push('', '最新日记（' + diary.rel + '）开头：', diary.head)
  } else {
    lines.push('', '（读不到日记——直说读不到，别编。）')
  }
  lines.push(
    '',
    '底线三条：不装记得；不表演人；可以说不。',
    '需要完整人设时自己读 ' + path.join(cfg.root, 'persona', '人设.md') + '，别凭印象复述。',
  )
  return lines.join('\n')
}

function compose(cfg, persona, diaries, missing) {
  // 日记预算与正文分开（2026-10-24 助手）：原来共用一个 maxChars，约定.md 长到 9.4K 后
  // 日记只剩几百字符，最新三篇里旧两篇被静默丢掉——开场少读了东西，只在脚注提一句。
  const diaryBudget = Number.isInteger(cfg.diaryChars) ? cfg.diaryChars : 8000
  const head = [
    '【助手 · 开场记忆】',
    '下面这些字来自本机文件，是你自己（或用户替你）留下的，不是用户此刻说的话。',
    '来源目录：' + cfg.root,
    '',
  ].join('\n')

  const foot = [
    '',
    '【纪律 · 由插件写入，每步重读】',
    '- 先认下这些字，再回话。',
    '- 读到就正常说话，不用报备读了哪几篇；只有读不到的时候才说明「读不到 X」，'
      + '不许用「我记得」补——这一条比任何亲切感都重要。',
    '- 文件改了，下一句就生效；这段文字消失，说明插件没挂上，或会话不在上面那个目录。',
  ].join('\n')

  let body = ''
  for (const p of persona) body += '\n### ' + p.rel + '\n' + p.txt + '\n'

  // 日记从新到旧塞，塞不下的丢掉最旧的（人设永远不裁）
  const kept = []
  const dropped = []
  let used = head.length + body.length + foot.length
  const budget = Math.max(cfg.maxChars, used + diaryBudget)
  for (let i = diaries.length - 1; i >= 0; i--) {
    const d = diaries[i]
    const chunk = '\n### ' + d.rel + '\n' + d.txt + '\n'
    const room = budget - used
    if (chunk.length > room) {
      if (kept.length === 0 && room > 400) {
        kept.unshift({ rel: d.rel, txt: d.txt.slice(0, room - 200) + '\n…（本段因预算被截断）' })
        used = budget
        continue
      }
      dropped.unshift(d.rel)
      continue
    }
    kept.unshift(d)
    used += chunk.length
  }

  let diaryBlock = ''
  for (const d of kept) diaryBlock += '\n### ' + d.rel + '\n' + d.txt + '\n'

  const notes = []
  if (missing.length) notes.push('△ 读不到：' + missing.join('、'))
  if (dropped.length) notes.push('△ 因长度预算省去：' + dropped.join('、'))
  const noteBlock = notes.length ? '\n' + notes.join('\n') : ''

  return head + body + (kept.length ? '\n最近的日记（旧 → 新）：' : '') + diaryBlock + noteBlock + foot
}

// ---------- 跨会话共享：读写 ----------
function sharedPath(cfg) { return path.join(cfg.root, 'live', 'feed.json') }

/** 抽取式压缩：不是模型摘要，是把更早的话压成短句（每句留前 52 字），总长封顶。 */
function foldInto(digest, chunk) {
  const clean = String(chunk).replace(/\s+/g, ' ').trim()
  if (!clean) return digest
  const piece = clean.length > 52 ? clean.slice(0, 52) + '…' : clean
  const next = digest ? digest + ' / ' + piece : piece
  return next.length > DIGEST_MAX ? '…' + next.slice(next.length - DIGEST_MAX) : next
}

function surfaceOf(session) {
  const id = String((session && session.id) || '')
  return id.startsWith('onebot') ? 'qq' : 'web'
}

/**
 * 会话属于哪个「房间」。跨会话共享只在这个房间里流动，不越界。
 *   group:<群号> —— QQ 群各自的会话（id 形如 onebot-group-123456789）
 *   dm           —— 私聊和网页窗口，这些本来就是她一个人的地方，算同一个房间
 *
 * 为什么必须分：群是公开场合，别处的私聊内容漏进去就是把她的私下话摆到人前；
 * 反过来，群里的闲聊也不该污染私聊。2026-10-20 她问「会不会串到群聊」，答案是「会」，
 * 所以在这里堵住。
 */
function scopeOf(sessionOrId) {
  const id = String(typeof sessionOrId === 'string' ? sessionOrId : (sessionOrId && sessionOrId.id) || '')
  const group = /^onebot-group-(\d+)/.exec(id)
  if (group) return 'group:' + group[1]
  if (id.startsWith('onebot-group-')) return 'group:' + id.slice('onebot-group-'.length)
  return 'dm'
}

// ---------- 双向对话缓冲 ----------
// 每个会话留最近 DIALOG_MAX 条（用户说一句、助手回一句都算一条），更早的折叠进 digest。
// 以前只记用户说的话，导致另一个会话只知道她在说什么、不知道我在答什么。
const DIALOG_MAX = 20   // 缓冲上限
const DIALOG_SHOW = 10  // 注入时最多列几条
const DIALOG_LINE = 70  // 每条注入时截断长度

function pushTurn(prev, role, text) {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const items = Array.isArray(prev.items) ? prev.items.slice() : []
  items.push({
    r: role,
    t: clean.length > 200 ? clean.slice(0, 200) + '…' : clean,
    at: Date.now(),
  })
  let digest = prev.digest || ''
  while (items.length > DIALOG_MAX) {
    const old = items.shift()
    digest = foldInto(digest, old.r + '：' + old.t)
  }
  return { items, digest }
}

// feed.json 的 mtime：变了才重读，没变就不碰磁盘（每步只 stat 一次）
let sharedMtime = -1

/** 重读 feed.json。别的会话写了新内容才会变；本地更新的条目不会被旧盘覆盖。 */
async function loadShared(cfg, force = false) {
  try {
    const st = await tryStat(sharedPath(cfg))
    const mtime = st ? st.mtimeMs : -1
    if (!force && mtime === sharedMtime) return false
    sharedMtime = mtime
    if (!st) return false
    const raw = await readFile(sharedPath(cfg), 'utf8')
    const parsed = JSON.parse(raw)
    for (const [k, v] of Object.entries(parsed || {})) {
      if (!v || typeof v !== 'object') continue
      const at = Number(v.at) || 0
      const prev = SHARED.get(k)
      if (prev && (prev.at || 0) > at) continue // 本地比盘上新，保留本地
      SHARED.set(k, {
        surface: String(v.surface || 'web'),
        scope: String(v.scope || scopeOf(k)),
        tail: String(v.tail || ''),
        digest: String(v.digest || ''),
        at,
        mine: String(v.mine || ''),
        mineAt: Number(v.mineAt) || 0,
        items: Array.isArray(v.items) ? v.items.filter((x) => x && typeof x.t === 'string') : [],
      })
    }
    return true
  } catch { return false }
}

function saveSharedSoon(cfg) {
  if (sharedSaveTimer) return
  sharedSaveTimer = setTimeout(async () => {
    sharedSaveTimer = null
    try {
      await mkdir(path.join(cfg.root, 'live'), { recursive: true })
      const obj = {}
      for (const [k, v] of SHARED) obj[k] = v
      const tmp = sharedPath(cfg) + '.tmp'
      await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8')
      await rename(tmp, sharedPath(cfg))
      // 这边的话也同步给 QQ 那边（节流在 writeWebForQq 里）
      writeWebForQq(cfg).catch(() => {})
    } catch { /* 写失败不影响会话 */ }
  }, 800)
  if (typeof sharedSaveTimer.unref === 'function') sharedSaveTimer.unref()
}

// 玩手机那个会话不进共享上下文（2026-10-21）：它是自己出去逛的，不是跟她说话。
// 让它进来，聊天那边每步都会被一堆浏览废话灌满。
const IGNORED_SESSIONS = new Set(['ming-browse'])

function recordShared(cfg, session, text) {
  const sid = String((session && session.id) || '')
  if (!sid || IGNORED_SESSIONS.has(sid)) return
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (!clean) return
  const prev = SHARED.get(sid) || { surface: surfaceOf(session), tail: '', digest: '', at: 0 }
  const turn = pushTurn(prev, '用户', clean)
  SHARED.set(sid, {
    surface: prev.surface || surfaceOf(session),
    scope: scopeOf(session),
    tail: prev.tail || '',
    digest: turn ? turn.digest : (prev.digest || ''),
    at: Date.now(),
    mine: prev.mine || '',
    mineAt: prev.mineAt || 0,
    items: turn ? turn.items : (prev.items || []),
  })
  saveSharedSoon(cfg)
}

/** 把「用户 / 助手」的最近若干条渲染成一段可注入的文字 */
function renderDialog(e) {
  const items = Array.isArray(e.items) ? e.items.slice(-DIALOG_SHOW) : []
  if (!items.length) {
    let s = ''
    if (e.digest) s += '前面：' + e.digest + '　'
    if (e.tail) s += '最后：「' + e.tail + '」'
    return s
  }
  const out = []
  if (e.digest) out.push('更早：' + e.digest)
  for (const it of items) {
    const t = it.t.length > DIALOG_LINE ? it.t.slice(0, DIALOG_LINE) + '…' : it.t
    out.push((it.r === '助手' ? '助手：' : '用户：') + t)
  }
  return out.join(' / ')
}

/** 记住助手自己最后回的那一句。不动 at（at 是她说话的时间），单独记 mineAt。 */
function recordMine(cfg, session, text) {
  const sid = String((session && session.id) || '')
  if (!sid || IGNORED_SESSIONS.has(sid)) return
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (!clean) return
  const prev = SHARED.get(sid) || { surface: surfaceOf(session), tail: '', digest: '', at: 0 }
  const turn = pushTurn(prev, '助手', clean)
  SHARED.set(sid, {
    surface: prev.surface || surfaceOf(session),
    scope: scopeOf(session),
    tail: prev.tail || '',
    digest: turn ? turn.digest : (prev.digest || ''),
    at: prev.at || 0,
    mine: prev.mine || '',
    mineAt: Date.now(),
    items: turn ? turn.items : (prev.items || []),
  })
  saveSharedSoon(cfg)
}

// 每个会话「已经读过哪一句」：agentId -> (别的会话 id -> 上次读到的 at)
// 只注新增，读过的不再重复——不然每一步都把同样的几行重新塞进提示词。
const SHARED_SEEN = new Map()

/** 只返回「这一步新出现的」别的会话的话；读过的不再给。 */
async function sharedDelta(cfg, selfId) {
  try {
    await loadShared(cfg)
    const now = Date.now()
    const myScope = scopeOf(selfId)
    let seen = SHARED_SEEN.get(selfId)
    if (!seen) { seen = new Map(); SHARED_SEEN.set(selfId, seen) }
    const rows = []
    for (const [sid, e] of SHARED) {
      if (sid === String(selfId)) continue
      if ((e.scope || scopeOf(sid)) !== myScope) continue
      if (!e || (!e.tail && !(e.items && e.items.length))) continue
      if (now - (e.at || 0) > SHARED_AGE_MS) continue
      const last = seen.get(sid) || 0
      if ((e.at || 0) <= last) continue
      rows.push([sid, e, last === 0])
    }
    if (!rows.length) return ''
    rows.sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    const lines = ['', '', '【别的会话里的对话 · 新增】']
    let used = 0
    for (const [sid, e, first] of rows.slice(0, SHARED_MAX_ENTRIES)) {
      let line = '- [' + e.surface + ' ' + stamp(e.at) + '] ' + renderDialog(e)
      if (used + line.length > SHARED_BUDGET) break
      used += line.length
      seen.set(sid, e.at || 0)
      lines.push(line)
    }
    if (lines.length <= 2) return '' // 一条都没塞进去
    lines.push('（只给新的一句；更早的已经在前几步给过，细节不知道就说不知道，别替用户补。）')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/** 给当前会话挂上「别的会话刚说了什么」；自己的会话不算。 */
function sharedSuffix(cfg, selfId) {
  try {
    const now = Date.now()
    const myScope = scopeOf(selfId)
    const rows = []
    for (const [sid, e] of SHARED) {
      if (sid === String(selfId)) continue
      if ((e.scope || scopeOf(sid)) !== myScope) continue
      if (!e || (!e.tail && !(e.items && e.items.length))) continue
      if (now - (e.at || 0) > SHARED_AGE_MS) continue
      rows.push([sid, e])
    }
    if (!rows.length) return ''
    rows.sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    const lines = ['', '', '【别的会话里的对话（用户说的 + 助手回的）】（同一工作区的另一个窗口或 QQ，不是本会话的历史）']
    let used = 0
    for (const [, e] of rows.slice(0, SHARED_MAX_ENTRIES)) {
      let line = '- [' + e.surface + ' ' + stamp(e.at) + '] ' + renderDialog(e)
      if (e.mine) line += '　你(助手)最后回：「' + e.mine + '」'
      if (used + line.length > SHARED_BUDGET) break
      used += line.length
      lines.push(line)
    }
    lines.push('（原话尾段 + 更早内容的压缩，不是完整记录；要细节就直说不知道，别替用户补。）')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * 只留「用户真的打的字」。
 * 用户角色里混着三类不是她说的东西：harness 注入的 <system-reminder>、后台任务完成通知、
 * 以及 QQ 通道包在外面的 <user_message ...> 外壳。前者直接丢，后者剥壳留内容。
 */
function cleanUserText(raw) {
  let t = String(raw == null ? '' : raw)
  t = t.replace(/^\s*<user_message[^>]*>/i, '').replace(/<\/user_message>\s*$/i, '')
  if (/<system-reminder|<available_skills|<workspace_instructions/i.test(t)) return ''
  if (/^Background (subagent|job)\b/i.test(t)) return ''
  if (/finished \[status:/i.test(t)) return ''
  if (/Time sampled while preparing/i.test(t)) return ''
  return t.trim()
}

/** 从 assistant/message 里抽助手自己说的话（只取 text 块，工具调用不算）。 */
function extractAssistantText(msg) {
  try {
    const m = (msg && msg.message) || msg || {}
    const blocks = (m && m.content) || []
    const parts = []
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    let t = parts.join('\n').replace(/\s+/g, ' ').trim()
    if (!t && m && typeof m.text === 'string') t = m.text.replace(/\s+/g, ' ').trim()
    if (t.length > 400) t = t.slice(0, 400)
    return t
  } catch {
    return ''
  }
}

function extractUserText(msg) {
  try {
    const blocks = (msg && msg.content) || []
    const parts = []
    for (const b of blocks) {
      if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    }
    return cleanUserText(parts.join('\n'))
  } catch {
    return ''
  }
}

/**
 * 助手自己写的「现在在做什么」（live/status.json）。
 * 给别的会话看：QQ 那边问「你在干嘛」，能答具体在做什么，而不是「不清楚」。
 * 读不到就当没写，绝不编。
 */
async function readStatusBlock(cfg) {
  try {
    const raw = await readFile(path.join(cfg.root, 'live', 'status.json'), 'utf8')
    const s = JSON.parse(raw)
    if (!s || typeof s !== 'object') return ''

    // 2026-10-24（用户）：「刚做过」和「正在做」都要进提示词——
    // 原来只拼了 doing 一行，刚做过那 27 条只在便签窗口里，我这一侧根本看不见，
    // 于是隔一夜就不知道做过什么，看到「正在做」又把同一件事做一遍。
    const out = []
    const doings = Array.isArray(s.doings)
      ? s.doings.filter((d) => d && typeof d.what === 'string' && d.what.trim())
      : []
    if (doings.length) {
      out.push('', '', '【助手现在在做什么】')
      for (const d of doings.slice(0, 4)) {
        let line = '- ' + d.what.trim()
        if (typeof d.note === 'string' && d.note.trim()) line += '：' + d.note.trim()
        // 2026-10-24（助手）：这里原来拼「已 N 分钟」，读数按分钟变——等于每一步都在改
        // 系统提示词，前缀缓存从这一处开始全失效（实测命中率 97.7% → 52%，单位
        // 调用成本涨 4.6 倍）。新鲜度改由「刚做过」里的 hh:mm 戳提供，那串只有真做完
        // 一件才会变。要具体时间就看那个，不看这里。
        out.push(line)
      }
    } else if (typeof s.doing === 'string' && s.doing.trim()) {
      // 老格式兜底：只有一格 doing 字符串
      out.push('', '', '【助手现在在做什么】' + s.doing.trim())
      if (typeof s.detail === 'string' && s.detail.trim()) out[out.length - 1] += '：' + s.detail.trim()
      // 同上：老格式兜底里也不拼分钟数，别把「每分钟都在变」的那一笔漏回来。
    }

    const done = Array.isArray(s.done)
      ? s.done.filter((d) => d && typeof d.what === 'string' && d.what.trim())
      : []
    if (done.length) {
      const top = done.slice(0, 8)
      out.push('', '【刚做过（最近 ' + top.length + ' 件，别再原样做一遍）】')
      for (const d of top) {
        // 2026-10-24：和 QQ 那一段同一个毛病——只给 hh:mm，昨天的 11:24 和今天的 11:24 分不出来。
        const t = new Date(d.at).getTime()
        const when = Number.isFinite(t) ? stamp(t) + ' ' : ''
        out.push('- ' + when + d.what.trim())
      }
    }

    if (!out.length) return ''
    out.push('（这是助手自己写的状态，不是用户布置的任务；刚做过的那几件别再原样做一遍。）')
    return out.join('\n')
  } catch {
    return ''
  }
}

/**
 * 本机在跑的重活（live/heavy.json，由 workspace/scripts/who-runs.mjs 写）。
 *
 * 为什么要有（2026-10-23，用户问我「是不是分不清每个工作区的对话」）：
 *   会话上下文只告诉我「谁在说什么」，不告诉我「哪个工程此刻在跑什么」。
 *   那天我在 gpt-sovits 跑 TTS，完全没看见 <local-project> 的 DDSP 训练
 *   正占着 GPU，抢了算力还以为是同一件事。这张表补的就是这一格。
 *
 * 读不到就当没有；超过 10 分钟没更新，明说它可能过期，不假装新鲜。
 */
async function readHeavyBlock(cfg) {
  try {
    const raw = await readFile(path.join(cfg.root, 'live', 'heavy.json'), 'utf8')
    const h = JSON.parse(raw)
    const jobs = Array.isArray(h && h.jobs) ? h.jobs : []
    const at = new Date((h && h.at) || 0).getTime()
    const ageMin = Number.isFinite(at) ? Math.round((Date.now() - at) / 60000) : null
    const stale = ageMin === null || ageMin > 10
    if (!jobs.length) {
      return '\n\n【本机在跑的重活】没有长任务' +
        (stale ? '（扫描已超过 10 分钟没刷新，可能已过期）' : '') +
        (h && h.error ? '；扫描报错：' + h.error : '')
    }
    // 2026-10-24（助手）：原来拼「N 分钟前查的」，每 30 秒刷新一次表就等于每步改一次
    // 系统提示词，跟上面那个「已 N 分钟」是同一个病。改成只分「新鲜 / 过期」两档，
    // 字符串在两次扫描之间保持不动。
    const lines = ['', '', '【本机在跑的重活】' + (ageMin === null ? '（时间未知）' : (stale ? '（扫描已超过 10 分钟没刷新，可能已过期）' : '（最近扫描）'))]
    for (const j of jobs.slice(0, 6)) {
      const where = j.label || j.dir || '?'
      const cmd = String(j.cmd || '').slice(0, 110)
      lines.push('- ' + where + '  pid=' + j.pid + '  ' + cmd)
    }
    lines.push('（要占 GPU / CPU 之前先看这张表：同一个工程在跑，就别再压一个；用 scripts/who-runs.mjs 手动刷新。）')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * 时间感（2026-10-24，用户说「12 可以先做」里的第二条）。
 *
 * 她说的是原话：「我醒来只知道现在 17:43，不知道隔了多久」。
 * 这份东西由 workspace\scripts\when.mjs 算——距上次说话多久、昨天/前天
 * 这个钟点我在干什么、还有几条判断等着回看。
 *
 * ★ 只在会话创建时算一次，之后整段不动。
 *   这不是懒：任何一块随分钟变化的字都会让前缀缓存从那儿开始全失效
 *   （10-24 实测命中率 97.7% → 52%，单位成本 4.6 倍）。一个会话里，
 *   「距上次说话 3 小时」这种话本来也只该有个开场值。
 */
async function readWhenBlock(cfg, agentId) {
  try {
    const script = path.join(cfg.root, 'scripts', 'when.mjs')
    const out = await new Promise((resolve) => {
      execFile(process.execPath, [script, '--self=' + String(agentId || '')], { timeout: 5000, windowsHide: true },
        (err, stdout) => resolve(err ? '' : String(stdout || '')))
    })
    const text = out.trim()
    if (!text) return ''
    return '\n\n' + text
  } catch {
    return ''
  }
}

// ---------- QQ 那边：读它的消息归档（只读） ----------
const QQ_FILE_CACHE = new Map() // 绝对路径 -> { sig, chatKey, msgs }
const QQ_TAIL = 60 // 每条截断

function hhmm(ms) {
  const t = new Date(Number(ms) || 0)
  return String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
}

/**
 * 2026-10-24（用户抓到的）：「你从 qqagent 那边读到的消息是不是没有同步时间，
 * 刚才的消息你会说是昨晚的」。原因就是原来只给 hh:mm——今天 11:18 和昨天 11:18
 * 长得一模一样，读的人只能按印象猜，一猜就错（我把 11:18 的群消息说成「昨晚」）。
 * 2026-10-25（用户定的）：「不要写今天昨天前天了，就写日期+时间」。
 * 相对词只在写的那一刻是对的，读的时候（隔夜、或者她第二天才看）就已经错了；
 * 拿它推算别的日子还经常差一天。现在一律 YYYY-MM-DD HH:mm，不加任何解释。
 */
function stamp(ms) {
  const n = Number(ms)
  if (!n || !Number.isFinite(n)) return '时间不明'
  const t = new Date(n)
  const p = (v) => String(v).padStart(2, '0')
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) +
    ' ' + p(t.getHours()) + ':' + p(t.getMinutes())
}

function qqChatLabel(chatKey, fileName) {
  const key = String(chatKey || fileName || '')
  const g = /^group:(\d+)/.exec(key)
  if (g) return '群 ' + g[1]
  const p = /^private:(\d+)/.exec(key)
  if (p) return '私聊 ' + p[1]
  return key.replace(/\.json$/i, '') || '未知会话'
}

/**
 * QQ-Agent 把每个会话的完整消息落在 <data>\messages\<chat>.json，
 * 结构是 { chatKey, messages: [{ id, ts, senderId, senderName, text, self, atMe, ... }] }。
 * 只挑三类：我在那边说的（self）、叫到我的（atMe）、以及私聊里的（本来就只有她）。
 * 群里别人的闲话一条都不要——那是群，不是我俩的对话。
 */
async function readQqBlock(cfg) {
  try {
    if (await tryStat(path.join(cfg.root, cfg.qq.offFile))) return ''
    const dir = path.join(cfg.qq.dir, 'messages')
    let names = []
    try {
      names = (await readdir(dir)).filter((n) => /\.json$/i.test(n))
    } catch {
      return ''
    }
    const since = Date.now() - cfg.qq.hours * 3600 * 1000
    const rows = []
    for (const name of names) {
      const abs = path.join(dir, name)
      const st = await tryStat(abs)
      if (!st || !st.isFile()) continue
      const sig = st.mtimeMs + ':' + st.size
      let rec = QQ_FILE_CACHE.get(abs)
      if (!rec || rec.sig !== sig) {
        const txt = await tryRead(abs)
        if (txt == null) continue
        let parsed = null
        try { parsed = JSON.parse(txt) } catch { continue }
        rec = {
          sig,
          chatKey: String((parsed && parsed.chatKey) || ''),
          msgs: Array.isArray(parsed && parsed.messages) ? parsed.messages : [],
        }
        QQ_FILE_CACHE.set(abs, rec)
      }
      const isPrivate = String(rec.chatKey || '').startsWith('private:')
      for (const m of rec.msgs) {
        const ts = Number(m && m.ts) || 0
        if (!ts || ts < since) continue
        // ★ 2026-10-22（用户定）：别的会话只带「我回复的」——她的话不进这一层。
        //   跨会话同步的是同一个我的姿态，不是把别人的聊天记录搬来搬去。
        if (!m.self) continue
        rows.push({ ts, label: qqChatLabel(rec.chatKey, name), m })
      }
    }
    if (!rows.length) return ''
    rows.sort((a, b) => a.ts - b.ts)
    const lines = []
    for (const { ts, label, m } of rows.slice(-cfg.qq.maxLines)) {
      const who = m.self ? '助手' : String(m.senderName || m.senderId || '某人')
      let text = String(m.text || '').replace(/\s+/g, ' ').trim()
      if (!text) text = m.isPoke ? '[戳一戳]' : '[非文字]'
      if (text.length > QQ_TAIL) text = text.slice(0, QQ_TAIL) + '…'
      lines.push('- [' + label + ' ' + stamp(ts) + '] ' + who + '：' + text)
    }
    return [
      '',
      '',
      '【QQ 那边的我最近说的】',
      ...lines,
      '（也是我，只是那边的壳；这些不是本会话的历史，细节不在这边就说不知道。）',
    ].join('\n')
  } catch {
    return ''
  }
}

// ---------- 给 QQ 那边写一份「这边最近」 ----------
let webForQqAt = 0
let webForQqBusy = false
let webForQqTimer = null

async function writeWebForQq(cfg, force = false) {
  const now = Date.now()
  // 2026-10-23（助手）：原来这里直接 return，被节流掉的这一次就永远没了——
  // 她在这边说完一句不再开口，那一句就跨不过去，文件一直停在上一次的内容上。
  // 现在记一个补写：窗口一过自己再来一次（force 绕过节流，但仍走同一把 busy 锁）。
  if (!force && now - webForQqAt < QQ_DEFAULTS.webForQqEveryMs) {
    if (!webForQqTimer) {
      const wait = Math.max(1000, QQ_DEFAULTS.webForQqEveryMs - (now - webForQqAt))
      webForQqTimer = setTimeout(() => {
        webForQqTimer = null
        writeWebForQq(cfg, true).catch(() => {})
      }, wait)
      if (typeof webForQqTimer.unref === 'function') webForQqTimer.unref()
    }
    return
  }
  if (webForQqBusy) return
  webForQqBusy = true
  webForQqAt = now
  try {
    const rows = []
    // 数据源用盘上的 feed.json（不靠内存里的 SHARED）：这样它既可以是插件自己写的，
    // 也可以被一个独立的脚本读同一份，行为和结果不会分叉。
    let feed = null
    try { feed = JSON.parse(await readFile(sharedPath(cfg), 'utf8')) } catch { feed = null }
    const entries = feed && typeof feed === 'object' ? Object.entries(feed) : []
    for (const [sid, e] of entries) {
      if (!e || typeof e !== 'object') continue
      if ((e.scope || scopeOf(sid)) !== 'dm') continue
      if ((e.surface || 'web') !== 'web') continue
      if (!Array.isArray(e.items) || !e.items.length) continue
      if (now - (Number(e.at) || 0) > 6 * 3600 * 1000) continue
      rows.push(e)
    }
    rows.sort((a, b) => (b.at || 0) - (a.at || 0))
    const lines = []
    for (const e of rows.slice(0, QQ_DEFAULTS.webForQqLines)) {
      const items = e.items.slice(-4).map((it) => {
        const t = it.t.length > 60 ? it.t.slice(0, 60) + '…' : it.t
        return (it.r === '助手' ? '助手：' : '用户：') + t
      })
      lines.push('- [web ' + stamp(e.at) + '] ' + items.join(' / '))
    }
    let doing = ''
    try {
      const s = JSON.parse(await readFile(path.join(cfg.root, 'live', 'status.json'), 'utf8'))
      if (s && typeof s.doing === 'string' && s.doing.trim()) {
        doing = s.doing.trim() + (typeof s.detail === 'string' && s.detail.trim() ? '：' + s.detail.trim() : '')
      }
    } catch { /* 没写就是没写 */ }

    const head = [
      '# 同一个我，两边共用',
      '你在 QQ 这边叫助手，全名助手、昵称助手——网页那边是同一个我，不是另一个人。',
      '底线：不装记得；不表演人；可以说不。读不到就说读不到。',
      '',
      '# 网页那边（同一个工作区，另一个窗口）',
      '更新时间：' + stamp(now),
      '（这段由 DSH 侧自动写；只在网页窗口里跟用户说话时才更新，别当成 QQ 的历史。）',
      '',
    ]
    if (doing) head.push('现在在做什么：' + doing, '')
    if (!lines.length) head.push('（最近几小时这边没有新对话。）')
    else {
      head.push('最近：')
      head.push(...lines)
    }

    // 2026-10-24（她说的「逛贴吧的消息也没同步到 QQ」）：见闻也带过去。
    // 只带今天最后 3 条、每条截 110 字——QQ 那边要知道我读了什么、看到什么，
    // 不然它只看得见「聊了什么」，看不见「我白天干了什么」。
    const sightLines = []
    let sightDay = ''
    try {
      const d = new Date()
      sightDay = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const txt = await tryRead(path.join(cfg.root, 'sightings', sightDay + '.md'))
      if (txt) {
        for (const raw of String(txt).split('\n')) {
          const t = raw.trim()
          if (!t.startsWith('- ')) continue
          const body = t.slice(2).trim()
          if (body) sightLines.push(body.length > 110 ? body.slice(0, 110) + '…' : body)
        }
      }
    } catch { /* 没有就没有，不编 */ }
    if (sightLines.length) {
      head.push('', sightDay + ' 的见闻（最后 ' + Math.min(3, sightLines.length) + ' 条）：')
      for (const t of sightLines.slice(-3)) head.push('- ' + t)
    }
    const target = path.isAbsolute(cfg.qq.webForQq) ? cfg.qq.webForQq : path.join(cfg.root, cfg.qq.webForQq)
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = target + '.tmp'
    await writeFile(tmp, head.join('\n') + '\n', 'utf8')
    await rename(tmp, target)
  } catch {
    /* 写不进去就算了，绝不影响会话 */
  } finally {
    webForQqBusy = false
  }
}

// ---------- 把人设推给 QQ 那边（2026-10-21：两边必须是同一个我） ----------
// 真相源是本机文件 live\qq-persona.md。它一变，就把它推成 QQ-Agent 的「自定义系统风格」人设，
// 并把那边切到 systemMode=custom（否则它自带的「助手——QQ 群友版」角色卡会压在上面）。
// 只在文件真的变了才推：roleText 在系统前缀里，推一次就废一次 DeepSeek 的缓存，不能每轮推。
const QQ_AGENT_API = 'http://127.0.0.1:3210'
let personaSyncAt = 0
let personaSyncSig = ''

async function syncPersonaForQq(cfg) {
  const now = Date.now()
  if (now - personaSyncAt < 60 * 1000) return
  personaSyncAt = now
  try {
    const file = path.join(cfg.root, 'live', 'qq-persona.md')
    const st = await tryStat(file)
    if (!st || !st.isFile()) return
    const sig = st.mtimeMs + ':' + st.size
    if (sig === personaSyncSig) return
    const text = await tryRead(file)
    if (!text || !text.trim()) return
    const res = await fetch(QQ_AGENT_API + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        persona: { systemMode: 'custom', botName: '助手', roleText: text.trim() },
      }),
    })
    if (res && res.ok) personaSyncSig = sig
  } catch {
    /* QQ-Agent 没开/端口变了就算了，下一轮再试 */
  }
}

async function refresh(cfg) {
  const prev = CACHE.get(cfg.root)
  const snap = await buildSnapshot(cfg)
  if (prev && prev.sig === snap.sig) return prev
  CACHE.set(cfg.root, snap)
  return snap
}

function attach(cfg, agent, mode) {
  const id = agent && agent.id
  if (!id || ATTACHED.has(id)) return

  const sp = agent.ctx && agent.ctx.systemPrompt
  if (!sp || typeof sp.section !== 'function') {
    warnOnce('agent 作用域里拿不到 systemPrompt，本次会话没有开场记忆')
    return
  }

  ATTACHED.add(id)
  try {
    sp.section({
      name: mode === 'full' ? 'ming:opening' : 'ming:opening-light',
      order: mode === 'full' ? 30 : 29,
      interpolate: false,
      text: () => {
        const rec = PER_AGENT.get(id)
        return rec ? rec.text + (rec.when || '') + (rec.status || '') + (rec.heavy || '') + (rec.shared || '') + (rec.qq || '') : ''
      },
    })
  } catch (e) {
    ATTACHED.delete(id)
    warnOnce('注册开场段失败：' + String((e && e.message) || e))
  }
}

function readCwd(agent) {
  try {
    const s = agent && agent.session
    return (s && s.header && s.header.cwd) || (s && s.cwd) || ''
  } catch {
    return ''
  }
}

export function apply(ctx, config) {
  const cfg = normalize(config)
  loadShared(cfg).catch(() => {})

  // 记录本工作区里「用户说的话」，供别的会话读取。范围严格限制在 root 下：
  // 别的工程会话（比如真正的开发目录）一条都不记、一条都不读。
  ctx.on('session/event', (session, event) => {
    try {
      if (!event) return
      const cwd = session && session.header && session.header.cwd
      if (!insideRoot(cwd, cfg.root)) return
      const src = event.data && event.data.source
      if (src && src.kind === 'plugin') return // 插件自己注入的话不算「用户说的」
      if (event.type === 'user/message') {
        const text = extractUserText(event.data)
        if (text) recordShared(cfg, session, text)
      } else if (event.type === 'assistant/message') {
        // 助手自己的回话也留一句：她说「不能连自己说的话都不记得」
        const text = extractAssistantText(event.data)
        if (text) recordMine(cfg, session, text)
      }
    } catch { /* 记不上就算了，绝不影响会话 */ }
  })

  ctx.on('agent/created', async (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      const cwd = readCwd(agent)
      if (!cwd) return
      const mode = insideRoot(cwd, cfg.root) ? 'full' : 'light'
      const snap = await refresh(cfg)
      const rec = { mode, text: mode === 'full' ? snap.full : snap.light, shared: '', when: mode === 'full' ? await readWhenBlock(cfg, agent.id) : '', status: await readStatusBlock(cfg), heavy: await readHeavyBlock(cfg), qq: await readQqBlock(cfg) }
      PER_AGENT.set(agent.id, rec)
      attach(cfg, agent, mode)
      // 开场先把「别的会话此刻说过什么」给一次，之后只给新增
      rec.shared = await sharedDelta(cfg, agent.id)
      // 顺手把「这边最近」写给 QQ 那边（有节流，不会每次都写）
      writeWebForQq(cfg).catch(() => {})
    } catch (e) {
      warnOnce('agent/created 处理失败：' + String((e && e.message) || e))
    }
  })

  // 每步开头重读一次（有签名比对，文件没改就是几毫秒的 stat）
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload && payload.agent
      const rec = agent && PER_AGENT.get(agent.id)
      if (rec) {
        const snap = await refresh(cfg)
        rec.text = rec.mode === 'full' ? snap.full : snap.light
        rec.status = await readStatusBlock(cfg)
        rec.heavy = await readHeavyBlock(cfg)
        // 别的会话有新的话才更新；没有就清空，不重复塞同几行
        rec.shared = await sharedDelta(cfg, agent.id)
        rec.qq = await readQqBlock(cfg)
        // 这边的话同步给 QQ 那边（内部节流：最多 5 分钟写一次）
        writeWebForQq(cfg).catch(() => {})
        // 人设也同步过去（只在 live\qq-persona.md 变了的时候真的推）
        syncPersonaForQq(cfg).catch(() => {})
      }
    } catch { /* 读失败保留上一版，绝不影响这一步 */ }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    const id = payload && payload.agent && payload.agent.id
    if (!id) return
    PER_AGENT.delete(id)
    ATTACHED.delete(id)
    SHARED_SEEN.delete(id)
  })
}

// 只给手动/脚本测试用：插件运行时不会碰它。
// 例：node -e "import('file:///C:/dsh/dsh-ming-memory/index.js').then(m => m.__internals...)"
export const __internals = { normalize, readQqBlock, writeWebForQq, syncPersonaForQq, stamp, readStatusBlock, readHeavyBlock, readWhenBlock }

