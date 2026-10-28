// qa-lib.mjs —— 四个 qa-*.mjs 共用的测试脚手架。
//
// 为什么有这个文件（2026-10-24 助手）：原来每个 qa 脚本都自己拼一遍 ctx、
// 自己 console.log('xxx:', true/false)。结果 2026-10-24 一跑，四个里有三个
// 在报 false——而且都是「断言还停在上一个版本的数据结构」这种假失败。
// 假失败比没测试更糟：真的坏了也看不出来。
//
// 所以：断言统一走 check()（带 PASS/FAIL 和汇总），失败让进程 exit 1，
// 谁跑都能一眼看见；事件形状统一在这里构造，改形状只改一处。
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

let failures = 0
let total = 0

export function tempRoot(prefix = 'ming-qa-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 空目录：把 cfg.qq.dir 指过去，测试才不会读到本机真的 QQ 消息 */
export function emptyDir(prefix = 'ming-noqq-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 起一份插件实例，返回驱动事件的小工具 */
export function mount(config) {
  const handlers = new Map()
  const ctx = {
    on(ev, fn) {
      handlers.set(ev, [...(handlers.get(ev) || []), fn])
      return () => {}
    },
  }
  apply(ctx, config)
  const fire = (ev, ...args) => (handlers.get(ev) || []).map((h) => h(...args))
  return {
    handlers,
    user(session, text, kind = 'user') {
      const e = { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } }
      fire('session/event', session, e)
    },
    assistant(session, text) {
      const e = { type: 'assistant/message', data: { content: [{ type: 'text', text }] } }
      fire('session/event', session, e)
    },
    async created(agent) {
      for (const h of handlers.get('agent/created') || []) await h({ agent })
    },
    async preStep(agent) {
      for (const h of handlers.get('agent/pre-step') || []) {
        await h({ agent, messages: [] }, async () => ({ kind: 'enter' }))
      }
    },
  }
}

export function sessionFor(id, cwd) {
  return { id, header: { cwd } }
}

/** 一个会注册 systemPrompt 段的假 agent；text() 每调一次都重新取，跟真的一样 */
export function agentFor(id, cwd) {
  const sections = []
  const agent = {
    id,
    session: { id, header: { cwd } },
    ctx: { systemPrompt: { section: (s) => sections.push(s) } },
  }
  return {
    agent,
    section: () => sections[0],
    text: () => (sections[0] ? sections[0].text({}) : ''),
  }
}

export function check(label, ok, detail) {
  total++
  if (!ok) failures++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  —— ' + detail : ''))
  return !!ok
}

export function summary(title) {
  console.log('')
  console.log((failures === 0 ? '★ 全过' : '✗ 没过 ' + failures + ' 项') + `（${title}：${total - failures}/${total}）`)
  if (failures) process.exitCode = 1
  return failures === 0
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读落盘的 live/feed.json；没有就是 {} */
export function readFeed(root) {
  const f = join(root, 'live', 'feed.json')
  if (!existsSync(f)) return {}
  try {
    return JSON.parse(readFileSync(f, 'utf8'))
  } catch {
    return {}
  }
}
