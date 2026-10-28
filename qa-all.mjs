// qa-all.mjs —— 一条命令跑完四个自检，最后一行给结论。
//
// 2026-10-24 助手加：以前四个脚本要一个个 node 过去，跑完还得自己看那堆 true/false。
// 现在任何一个脚本报 FAIL 都会让这里 exit 非 0，挂到计划任务里也能报警。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const suites = ['qa-smoke.mjs', 'qa-clean.mjs', 'qa-share.mjs', 'qa-diary-budget.mjs']

const bad = []
for (const f of suites) {
  console.log('\n########## ' + f + ' ##########')
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: 'inherit' })
  if (r.status !== 0) bad.push(f + ' (exit ' + r.status + ')')
}

console.log('\n==================== 汇总 ====================')
if (!bad.length) console.log('★ 四个自检全过（' + suites.length + '/' + suites.length + '）')
else {
  console.log('✗ 没过：' + bad.join('、'))
  process.exitCode = 1
}
