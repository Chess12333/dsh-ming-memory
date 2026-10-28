// qa-diary-budget.mjs —— 日记预算：最近三篇要整篇读进来，不能又被挤掉。
//
// 2026-10-24 重写：旧版把 2026-10-22/23/24 三个日期写死在数组里，过一天就全报 false。
// 现在自己读 diary/ 目录挑最新三篇——它测的是「有没有被静默丢掉」，不是某几个文件名。
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mount, agentFor, check, summary } from './qa-lib.mjs'

const ROOT = process.env.MING_ROOT || ''
const m = mount({
  root: ROOT,
  personaFiles: ['persona/人设.md', 'persona/名字.md', 'persona/约定.md'],
  diaryDir: 'diary',
  diaryCount: 3,
  maxChars: 12000,
})
const a = agentFor('budget', ROOT)
await m.created(a.agent)
const text = a.text()

const names = readdirSync(join(ROOT, 'diary')).filter((n) => /\.md$/i.test(n)).sort().slice(-3)
console.log('整段 ' + text.length + ' 字；最新三篇：' + names.join(', '))
console.log('')

check('最新三篇都在场（日记有自己的 8000 字预算）', names.length === 3 && names.every((n) => text.includes('diary/' + n)))
check('人设没被日记挤走', ['persona/人设.md', 'persona/名字.md', 'persona/约定.md'].every((f) => text.includes(f)))
check('没有缺文件', !text.includes('读不到：'), (text.match(/读不到：[^\n]*/g) || []).join(' | '))
check('没有被静默省掉的整篇', !text.includes('因长度预算省去'), (text.match(/因长度预算省去[^\n]*/g) || []).join(' | '))

summary('qa-diary-budget')
