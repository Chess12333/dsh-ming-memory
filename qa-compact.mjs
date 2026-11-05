/**
 * 自测压缩门牌：假 ctx + 假 agent，走真插件注册的那条路。
 *   node qa-compact.mjs
 * 只读（不写任何文件），十秒内跑完。
 *
 * 验的是三件事：
 *   1. 没压缩过的会话，系统提示里一个字都不多；
 *   2. compaction/summary 进来之后，那一块出现在系统提示里，且带区间 + 取原文的路；
 *   3. 压在别的会话上不会串到这个会话。
 */
const { apply } = await import('./index.js');

const handlers = {};
const ctx = {
  on: (type, fn) => { handlers[type] = fn; },
};

const ROOT = process.env.MING_ROOT || (await import('./index.js')).loadLocalConfig().root
if (!ROOT) { console.error('没有工作区：设 MING_ROOT 或写 ~/.dsh/ming-memory.json 的 root'); process.exit(2) }
apply(ctx, { root: ROOT });

const sections = [];
const contexts = [];
const agent = {
  id: 'qa-agent-1',
  session: { header: { id: 'qa-sess-1', cwd: ROOT } },
  ctx: { systemPrompt: { section: (def) => sections.push(def), context: (def) => contexts.push(def) } },
};

const fail = [];
const check = (label, ok, extra = '') => {
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : ''));
  if (!ok) fail.push(label);
};

if (!handlers['agent/created'] || !handlers['session/event']) {
  console.error('FAIL: 插件没注册 agent/created 或 session/event');
  process.exit(1);
}

await handlers['agent/created']({ agent });
check('注册了开场段', sections.length === 1);

// 系统提示那一段 + 每步末尾那条（2026-11-05 起动态块在 context 里）
const text = () => (sections[0] ? sections[0].text() : '') + (contexts[0] ? contexts[0].text() : '');
const before = text();
check('开场段有内容（人设在里面）', before.length > 2000, String(before.length) + ' 字');
check('没压缩时没有门牌', !before.includes('【压缩门牌】'));

const session = agent.session;
handlers['session/event'](session, {
  type: 'compaction/summary',
  seq: 900,
  time: Date.UTC(2026, 10, 3, 6, 12) - 8 * 3600 * 1000,
  data: {
    compactionId: 'c1',
    summary: [],
    shadowedRange: { start: 41, end: 318 },
    shadowedSeqs: Array.from({ length: 96 }, (_, i) => 41 + i),
    shadowedTokenCount: 87400,
    model: 'deepseek-chat',
    provider: 'deepseek',
  },
});

const after = text();
console.log('\n--- 门牌 ---');
console.log(after.slice(after.indexOf('【压缩门牌】')));
check('压缩后门牌出现', after.includes('【压缩门牌】'));
check('门牌写了次数', after.includes('压缩过 1 次'));
check('门牌写了区间', after.includes('seq 41–318'));
check('门牌写了规模', after.includes('96 个节点') && after.includes('8.7 万'));
check('门牌写了取原文的路', after.includes('session_event_read(seq=41)'));
check('门牌说的是「压缩」不是「失忆」', after.includes('不是失忆') === false && after.includes('别把「摘要里没有」当成「没发生过」'));
check('门牌不覆盖人设', after.indexOf('【压缩门牌】') > after.indexOf('## 一、你叫什么'));

// 第二次压缩：次数累加，区间换成最新那次
handlers['session/event'](session, {
  type: 'compaction/summary',
  time: Date.now(),
  data: { shadowedRange: { start: 400, end: 512 }, shadowedSeqs: [400, 512], shadowedTokenCount: 120000, model: 'deepseek-chat' },
});
const twice = text();
check('第二次压完次数变 2', twice.includes('压缩过 2 次'));
check('只显示最新那次的区间', twice.includes('seq 400–512') && !twice.includes('seq 41–318'));

// 别的会话不受影响
const other = { header: { id: 'qa-sess-2', cwd: ROOT } };
const otherSections = [];
const otherContexts = [];
const otherAgent = { id: 'qa-agent-2', session: other, ctx: { systemPrompt: { section: (d) => otherSections.push(d), context: (d) => otherContexts.push(d) } } };
await handlers['agent/created']({ agent: otherAgent });
check('另一个会话没有门牌', !((otherSections[0] ? otherSections[0].text() : '') + (otherContexts[0] ? otherContexts[0].text() : '')).includes('【压缩门牌】'));

// compaction 以外的日志事件不该被当成压缩
handlers['session/event'](session, { type: 'compaction/start', time: Date.now(), data: { compactionId: 'c3', turn: 1 } });
handlers['session/event'](session, { type: 'compaction/end', time: Date.now(), data: { compactionId: 'c3', turn: 1 } });
check('start/end 不算一次压缩', text().includes('压缩过 2 次'));

console.log('\n' + (fail.length ? '失败 ' + fail.length + ' 项：' + fail.join(' / ') : '全过'));
process.exit(fail.length ? 1 : 0);
