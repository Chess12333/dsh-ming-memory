/**
 * qa-cache.mjs —— 验「前缀缓存」这条契约（2026-11-05 加）
 *
 * 请求的排布是：系统提示 → 整段历史 → 这一轮的新消息。
 * 前缀缓存按字节比，所以系统提示里只要有一个会变的字，后面整段历史全部按全价重读。
 *
 * 这个自检验的就是那一条：
 *   1. 系统提示那一段里，不许出现时间感 / 刚做过 / 门牌这些会变的块；
 *   2. 它在两次取值之间必须逐字节相同（中间还真的跑了一步 pre-step）；
 *   3. 会变的那几块确实跑到「每步那条」里去了 —— 不是删掉，是搬家。
 *
 *   node qa-cache.mjs
 */
import { agentFor, check, summary, sleep } from './qa-lib.mjs'

const { apply } = await import('file:///C:/dsh/dsh-ming-memory/index.js')

const handlers = {}
const ctx = { on: (type, fn) => { handlers[type] = fn } }
apply(ctx, {})

const a = agentFor('qa-cache-1', 'C:\\dsh\\hers_workplace')
await handlers['agent/created']({ agent: a.agent })

const p1 = a.prompt()
const l1 = a.live()

check('系统提示里有人设（不是空壳）', /一、你叫什么/.test(p1), String(p1.length) + ' 字')
check('系统提示里没有时间感', !/【时间感】/.test(p1))
check('系统提示里没有刚做过', !/【刚做过/.test(p1))
check('系统提示里没有门牌', !/【压缩门牌】/.test(p1))

check('每步那条里有时间感', /【时间感】/.test(l1))
check('每步那条里有人设以外的活东西', /【刚做过|【本机在跑的重活】/.test(l1))
check('每步那条里没有人设', !/一、你叫什么/.test(l1), String(l1.length) + ' 字')

// 真跑一步：中间会重读那些会变的文件
await sleep(1100)
await handlers['agent/pre-step'](
  { agent: a.agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
  async () => ({ kind: 'enter', messages: [] }),
)

const p2 = a.prompt()
const l2 = a.live()

check('跑过一步之后系统提示逐字节没变', p1 === p2, `${p1.length} 字 vs ${p2.length} 字`)
check('每步那条还在（没被清空）', l2.length > 0)

// summary() 返回的是「是否全过」，不是失败数
const ok = summary('qa-cache')
if (!ok) process.exit(1)
