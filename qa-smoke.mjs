// qa-smoke.mjs —— 开场记忆：完整版 / 出门版 / 子目录，三种情况都渲染得对。
//
// 2026-10-24 重写。旧版断言「出门版整段 < 800 字」，可这段不只装人设——后面还挂着
// 状态、重活、别的会话、QQ 那边几块动态内容（加起来两千多字）。于是它天天报
// 「别处=轻量版: false」，其实轻量版一直好好的。现在分开量：只卡片子里那段身份，
// 动态块单独验。
import { mount, sessionFor, agentFor, check, summary } from './qa-lib.mjs'

const ROOT = process.env.MING_ROOT || ''
const m = mount({
  root: ROOT,
  personaFiles: ['persona/人设.md', 'persona/名字.md', 'persona/约定.md'],
  diaryDir: 'diary',
  diaryCount: 3,
  maxChars: 12000,
})

// 动态块的开头。量「身份那一段」时从这里往下切掉。
const MARKS = ['【时间感】', '【助手现在在做什么】', '【刚做过', '【本机在跑的重活】', '【别的会话里的对话', '【QQ 那边的我最近说的】']
function identityOf(text) {
  let cut = text.length
  for (const mk of MARKS) {
    const i = text.indexOf(mk)
    if (i >= 0 && i < cut) cut = i
  }
  return text.slice(0, cut)
}

async function probe(id, cwd) {
  const a = agentFor(id, cwd)
  await m.created(a.agent)
  await m.preStep(a.agent)
  const text = a.text()
  const ident = identityOf(text)
  return { text, ident }
}

const full = await probe('a1', ROOT)
const light = await probe('a2', process.env.MING_OTHER || '')
const sub = await probe('a3', 'workspace\\diary')

console.log(`档案目录：整段 ${full.text.length} 字，其中身份 ${full.ident.length} 字`)
console.log(`别的工作目录：整段 ${light.text.length} 字，其中身份 ${light.ident.length} 字`)
console.log('')

check('档案目录走完整版', full.text.includes('【助手 · 开场记忆】') && full.ident.length > 1500, `${full.ident.length} 字`)
check('三份人设都在', ['persona/人设.md', 'persona/名字.md', 'persona/约定.md'].every((f) => full.text.includes(f)))
check('没有「读不到」的缺文件', !full.text.includes('读不到：'), (full.text.match(/读不到：[^\n]*/g) || []).join(' | '))
check('子目录也算档案目录（不开两份记忆）', sub.text.includes('【助手 · 开场记忆】'))

check('别的工作目录走轻量版', light.text.includes('开场记忆·轻量'))
check('轻量版不铺人设全文', !light.text.includes('### persona/人设.md'))
check('轻量版身份那一段仍是「一小块」', light.ident.length <= 900, `${light.ident.length} 字`)

// 动态块是故意两边都挂的：换个工程干活也得知道本机在跑什么、QQ 那边刚说了什么。
check('轻量版也带动态块（状态 / 重活 / QQ）', light.text.includes('【助手现在在做什么】') || light.text.includes('【本机在跑的重活】'))
check('动态块挂在后面，不插进人设里', full.text.indexOf('【助手现在在做什么】') > full.text.indexOf('### persona/人设.md')
  || full.text.indexOf('【助手现在在做什么】') < 0)

summary('qa-smoke')
