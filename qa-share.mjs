// qa-share.mjs —— 跨会话共享：谁能看见谁。
//
// 2026-10-24 重写。旧版两处假失败：
//   ① 它断言 feed 里的 tail（旧字段，现在恒空）；
//   ② 它在 agent/created 之后才发消息，然后直接读开场段——可「别的会话在说什么」
//      是 agent/pre-step 每步重算的，不跑 pre-step 当然什么都看不到。
// 现在按真实时序驱动：先建两个会话，再发消息，再走一步 pre-step。
import { tempRoot, emptyDir, mount, sessionFor, agentFor, check, summary, sleep, readFeed } from './qa-lib.mjs'

const ROOT = tempRoot('ming-share-')
const cfg = {
  root: ROOT,
  personaFiles: ['persona/人设.md'],
  diaryDir: 'diary',
  diaryCount: 3,
  maxChars: 12000,
  qq: { dir: emptyDir() }, // 本机真 QQ 消息目录不参与测试
}
const m = mount(cfg)

const qqS = sessionFor('onebot-private-0', ROOT)
const webS = sessionFor('web-abc', ROOT)
const grpS = sessionFor('onebot-group-123456789', ROOT)
const otherS = sessionFor('trpg', process.env.MING_OTHER || '')

const qqA = agentFor('onebot-private-0', ROOT)
const webA = agentFor('web-abc', ROOT)
await m.created(qqA.agent)
await m.created(webA.agent)

m.user(qqS, '用户在 QQ 说的第一句话。')
m.assistant(qqS, '助手在 QQ 回的第一句。')
m.user(grpS, '群里别人说的话，不该进私聊视角。')
m.user(otherS, '这句来自 trpg_web，绝对不该被记录')

await m.preStep(webA.agent)
const t1 = webA.text()
check('Web 看得见 QQ 那边说了什么', t1.includes('别的会话里的对话') && t1.includes('用户在 QQ 说的第一句话'))
check('也看得见我在那边回的那句', t1.includes('助手在 QQ 回的第一句'))
check('群里的话不进私聊视角', !t1.includes('群里别人说的话'))
check('别的工程目录一条不读', !t1.includes('trpg_web'))

await m.preStep(webA.agent)
const t2 = webA.text()
check('同一段不重复塞第二步（读完就划掉）', !t2.includes('用户在 QQ 说的第一句话'))

check('QQ 那边看不到自己的话（只给别人的）', !qqA.text().includes('别的会话里的对话'))

await sleep(1300)
const feed = readFeed(ROOT)
const qqEntry = feed['onebot-private-0'] || {}
const qqItems = Array.isArray(qqEntry.items) ? qqEntry.items : []
check('feed.json 落盘', !!feed['onebot-private-0'])
check('feed 里两边原话都在', qqItems.some((i) => i.r === '用户') && qqItems.some((i) => i.r === '助手'))
check('别的工程目录没进 feed', !feed['trpg'])
check('群是单独一间房（scope）', feed['onebot-group-123456789'] && feed['onebot-group-123456789'].scope === 'group:123456789',
  JSON.stringify(feed['onebot-group-123456789'] && feed['onebot-group-123456789'].scope))
check('私聊归 dm 那间房', (qqEntry.scope || '') === 'dm', JSON.stringify(qqEntry.scope))

summary('qa-share')
