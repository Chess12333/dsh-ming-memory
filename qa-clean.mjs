// qa-clean.mjs —— 验证「只留用户真的打的字」，以及双向记录/折叠的边界。
//
// 2026-10-24 重写：旧版断言 tail/digest 两个字段，可 2026-10-20 之后数据模型换成了
// items 数组（最近 20 条原话，溢出的压进 digest），tail 再也没人写。结果旧版两条
// 永远报 false——它测的不是插件，是自己记忆里的旧结构。
import { tempRoot, emptyDir, mount, sessionFor, check, summary, sleep, readFeed } from './qa-lib.mjs'

// ---------- 一、该留的留，该丢的丢 ----------
const ROOT = tempRoot('ming-clean-')
const m = mount({
  root: ROOT,
  personaFiles: ['persona/人设.md'],
  diaryDir: 'diary',
  diaryCount: 3,
  maxChars: 12000,
  qq: { dir: emptyDir() }, // 别读本机真 QQ 消息
})
const s = sessionFor('web-1', ROOT)

const cases = [
  ['正常的用户消息', true],
  ['<system-reminder>\nUpdated instructions from: AGENTS.md\n</system-reminder>', false],
  ['Background subagent abc finished and will do no further work', false],
  ['Background job pwsh-123 finished [status: completed, exit code: 1]. Read its output', false],
  ['Time sampled while preparing turn 1, step 1: 2026-10-24T21:24:34+08:00', false],
  ['<user_message qq="0" nickname="用户"> 我刚才在电脑上说了什么？ </user_message>', true],
]
for (const [text] of cases) m.user(s, text)
m.user(s, '插件自己塞的话', 'plugin')
m.assistant(s, '助手回了一句。')

await sleep(1300)
const entry = readFeed(ROOT)['web-1'] || {}
const items = Array.isArray(entry.items) ? entry.items : []
const said = items.filter((i) => i.r === '用户').map((i) => i.t).join('\n')
const mine = items.filter((i) => i.r === '助手').map((i) => i.t).join('\n')

check('保留正常消息', said.includes('正常的用户消息'))
check('剥掉 QQ 外壳、留下正文', said.includes('我刚才在电脑上说了什么') && !said.includes('<user_message'))
check('不含 system-reminder', !said.includes('system-reminder'))
check('不含 job 通知', !said.includes('finished [status'))
check('不含 Background subagent', !said.includes('Background subagent'))
check('不含 harness 的时间戳注脚', !said.includes('Time sampled'))
check('插件自己注入的不算她说的', !said.includes('插件自己塞的话'))
check('助手自己回的那句也记（她说不能连自己说的话都不记得）', mine.includes('助手回了一句'))
check('最近 20 条以内不折叠', items.length === 3 && (entry.digest || '') === '', `items=${items.length} digest=${JSON.stringify(entry.digest || '')}`)

// ---------- 二、溢出的压进 digest ----------
const ROOT2 = tempRoot('ming-fold-')
const m2 = mount({
  root: ROOT2,
  personaFiles: ['persona/人设.md'],
  diaryDir: 'diary',
  diaryCount: 3,
  maxChars: 12000,
  qq: { dir: emptyDir() },
})
const s2 = sessionFor('web-fold', ROOT2)
for (let i = 1; i <= 25; i++) m2.user(s2, '第' + i + '句')
await sleep(1300)
const e2 = readFeed(ROOT2)['web-fold'] || {}
const it2 = Array.isArray(e2.items) ? e2.items : []
check('25 句之后只留最近 20 条', it2.length === 20, `items=${it2.length}`)
check('最早那句进了 digest', typeof e2.digest === 'string' && e2.digest.includes('第1句'), JSON.stringify(e2.digest).slice(0, 80))
check('窗口头是第 6 句', it2[0] && it2[0].t === '第6句', it2[0] && it2[0].t)

summary('qa-clean')
