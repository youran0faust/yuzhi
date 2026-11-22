// 鱼知 / Yuzhi · 悬案表
// 一行一条悬案，状态变更另写一行（不改旧行）。
// 零依赖。node case.mjs <list|add|touch|stale|show> [参数]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './cases.mjs';

const FILE = process.env.CASE_FILE || 'E:/AIGC/闲聊/信息生命与虚拟灵魂/悬案表.jsonl';
const STATES = ['unresolved', 'resolved', 'dissolved', 'abandoned'];
const NEEDS_WHY = new Set(['resolved', 'dissolved', 'abandoned']);
const today = () => new Date().toISOString().slice(0, 10);

// ---- 读写 ----------------------------------------------------------------
// 读法在 cases.mjs：命令行、检索、服务端共用一份，别各存一份（改一处要改三处）。

function append(f, obj) {
  fs.appendFileSync(f, JSON.stringify(obj, null, 0) + '\n', 'utf8');
}

const byNum = (a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2));
const isOpen = (c) => c.state === 'unresolved' || c.state === 'abandoned';

// ---- 命令 ----------------------------------------------------------------
function cmdAdd(f, opt) {
  if (!opt.open || !opt.open.trim()) return { err: '缺 --open（悬置的问题本身，一句话）' };
  if (!opt.synth || !opt.synth.trim()) return { err: '缺 --synth（它被收掉时会是什么样；这是给未来搜的钥匙）' };
  const { cases } = load(f);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  for (const c of cases.values()) {
    if (isOpen(c) && norm(c.open) === norm(opt.open)) {
      return { err: `已有同类悬案 ${c.id}（同指纹不重开；真有新证据用 touch）` };
    }
  }
  const n = Math.max(0, ...[...cases.keys()].map((id) => Number(id.slice(2)))) + 1;
  const id = 'X-' + String(n).padStart(3, '0');
  const rec = { k: 'case', id, open: opt.open.trim(), synth: opt.synth.trim(), opened: today() };
  if (opt.ref) rec.ref = opt.ref;
  append(f, rec);
  return { id };
}

function cmdTouch(f, opt) {
  const id = opt._[0];
  if (!id) return { err: '缺 id（例：touch X-003 --state=resolved --why="..."）' };
  if (!STATES.includes(opt.state)) return { err: `state 必须是 ${STATES.join(' / ')}` };
  const { cases } = load(f);
  const c = cases.get(id);
  if (!c) return { err: `没有这个 id：${id}` };
  if (NEEDS_WHY.has(opt.state) && !(opt.why || '').trim()) {
    return { err: `${opt.state} 必须写 --why：这事是解决了，还是不再成立了，还是搁下了——三句话不一样` };
  }
  if (c.state === opt.state && c.state === 'unresolved') return { err: `${id} 已经是 unresolved` };
  append(f, { k: 'move', id, from: c.state, to: opt.state, why: (opt.why || '').trim(), t: today() });
  return { id, from: c.state, to: opt.state };
}

function cmdList(f, opt) {
  const { cases, bad } = load(f);
  let all = [...cases.values()].sort(byNum);
  if (!opt.all) all = all.filter(isOpen);
  return { rows: all, bad };
}

function cmdStale(f, opt) {
  const days = Number(opt.days || 21);
  const { cases } = load(f);
  const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const rows = [...cases.values()].filter((c) => c.state === 'unresolved' && c.last <= cut);
  if (opt.apply) for (const c of rows) append(f, { k: 'move', id: c.id, from: c.state, to: 'abandoned', why: `${days} 天无推进，降一级（不进死档）`, t: today() });
  return { rows, days, applied: !!opt.apply };
}

// ---- 自测 ----------------------------------------------------------------
// 导入线索层的候选：候选不是账，这一步是「人看过之后才收编」的那一下。
// 同一指纹（或同一句话）已经在账上开着的，跳过——不许因为扫了两遍就多出两条。
function cmdImport(f, opt) {
  const file = opt.from;
  if (!file) return { err: '缺 --from（threads.mjs 导出的候选文件）' };
  if (!fs.existsSync(file)) return { err: '没有这个文件：' + file };
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((s) => s.trim());
  const { cases } = load(f);
  const seenFp = new Set();
  const seenOpen = new Set();
  for (const c of cases.values()) {
    if (isOpen(c)) seenOpen.add(c.open.replace(/\s+/g, ' ').trim());
    if (c.fp) seenFp.add(c.fp);
  }
  const created = [];
  const skipped = [];
  const bad = [];
  let n = Math.max(0, ...[...cases.keys()].map((id) => Number(id.slice(2)))) + 1;
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { bad.push(line.slice(0, 48)); continue; }
    if (!o || !o.q) { bad.push(line.slice(0, 48)); continue; }
    const fp = o.fp || '';
    const norm = String(o.q).replace(/\s+/g, ' ').trim();
    if (fp && seenFp.has(fp)) { skipped.push({ why: '同指纹已在账上', q: norm }); continue; }
    if (seenOpen.has(norm)) { skipped.push({ why: '同一句话已开着', q: norm }); continue; }
    if (opt.limit && created.length >= Number(opt.limit)) { skipped.push({ why: '超 --limit', q: norm }); continue; }
    const id = 'X-' + String(n).padStart(3, '0');
    n += 1;
    const rec = {
      k: 'case', id, open: norm,
      synth: o.synth || '当这件事有了可复现的结果时闭合。',
      opened: today(), source: 'threads',
    };
    if (o.seg_id) rec.ref = 'seg:' + o.seg_id;
    if (fp) rec.fp = fp;
    if (!opt.dry) append(f, rec);
    seenFp.add(fp);
    seenOpen.add(norm);
    created.push({ id, q: norm, seg: o.seg_id || '' });
  }
  return { created, skipped, bad, dry: !!opt.dry };
}

function selftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuzhi-'));
  const f = path.join(dir, 'cases.jsonl');
  let pass = 0, fail = 0; const bad = [];
  const ok = (cond, name) => { if (cond) pass++; else { fail++; bad.push(name); } };

  const a = cmdAdd(f, { open: '硬盘够不够用', synth: '换了设备，不再抱怨卡' });
  ok(a.id === 'X-001', 'add 给 X-001');
  const dup = cmdAdd(f, { open: '硬盘够不够用 ', synth: 'x' });
  ok(!!dup.err, '同指纹拒绝重开');
  const noSynth = cmdAdd(f, { open: '另一个', synth: '' });
  ok(!!noSynth.err, '缺 synth 拒绝');

  const b = cmdAdd(f, { open: '配音能不能接进工程', synth: '对白行直接出配音', ref: 'MEMORY:VoiceStudio' });
  ok(b.id === 'X-002', 'add 递增');

  ok(!!cmdTouch(f, { _: ['X-001'], state: 'resolved' }).err, 'resolved 缺 why 拒绝');
  ok(!!cmdTouch(f, { _: ['X-999'], state: 'resolved', why: 'x' }).err, '不存在的 id 拒绝');
  ok(!!cmdTouch(f, { _: ['X-001'], state: 'merged' }).err, '非法状态拒绝');

  const t1 = cmdTouch(f, { _: ['X-001'], state: 'resolved', why: '新硬盘到了，不再提卡' });
  ok(t1.from === 'unresolved' && t1.to === 'resolved', 'touch 记录 from/to');

  const l1 = cmdList(f, {});
  ok(l1.rows.length === 1 && l1.rows[0].id === 'X-002', '默认只列未结');
  const l2 = cmdList(f, { all: true });
  ok(l2.rows.length === 2 && l2.rows.length > l1.rows.length, '--all 列出全部');
  const x1 = l2.rows.find((r) => r.id === 'X-001');
  ok(x1.state === 'resolved' && x1.lastWhy.includes('新硬盘'), '状态投影带 why');
  ok(x1.moves === 1, 'move 计数');

  const raw = fs.readFileSync(f, 'utf8').trim().split('\n');
  ok(raw.length === 3, '原始行数=2 case + 1 move，没就地改写');

  const c3 = cmdAdd(f, { open: '第三个', synth: 'x' });
  ok(c3.id === 'X-003', 'add 后 id 继续递增');
  const c4 = cmdAdd(f, { open: '第四个', synth: 'x' });
  ok(c4.id === 'X-004', 'X-001 已闭环也不回填它的号');

  // 过期扫描：把 last 拨回 40 天
  fs.appendFileSync(f, JSON.stringify({ k: 'move', id: 'X-002', from: 'unresolved', to: 'unresolved', why: '', t: '2026-01-01' }) + '\n');
  const st = cmdStale(f, { days: 21 });
  ok(st.rows.some((r) => r.id === 'X-002'), 'stale 检出过期');
  cmdStale(f, { days: 21, apply: true });
  const after = cmdList(f, { all: true }).rows.find((r) => r.id === 'X-002');
  ok(after.state === 'abandoned', 'stale --apply 转 abandoned（不进死档）');
  cmdTouch(f, { _: ['X-002'], state: 'unresolved', why: '又有动静了' });
  ok(cmdList(f, { all: true }).rows.find((r) => r.id === 'X-002').state === 'unresolved', 'abandoned 可重激活');

  fs.appendFileSync(f, '{坏行\n');
  const l3 = cmdList(f, { all: true });
  ok(l3.bad.length === 1, '坏行计数而不是静默丢弃');

  const d = cmdAdd(f, { open: '要解散的', synth: 'x' });
  cmdTouch(f, { _: [d.id], state: 'dissolved', why: '前提没了，云盘解决了' });
  ok(cmdList(f, { all: true }).rows.find((r) => r.id === d.id).state === 'dissolved', 'dissolved 与 resolved 分开');

  // 导入候选：干跑不写盘；真导一次只收没见过的指纹；再导一次不重复
  const candFile = path.join(dir, 'cands.jsonl');
  const c1 = { k: 'cand', q: '「重采样」到底结了没有？', synth: '接上就闭合', seg_id: 's#9.1', fp: 'fp-new-1' };
  const c2 = { k: 'cand', q: '「钩子」到底结了没有？', synth: 'x', seg_id: 's#9.2', fp: 'fp-new-2' };
  fs.writeFileSync(candFile, JSON.stringify(c1) + '\n' + JSON.stringify(c2) + '\n{坏行\n', 'utf8');
  const beforeAll = cmdList(f, { all: true }).rows.length;
  const dry = cmdImport(f, { from: candFile, dry: true });
  ok(dry.created.length === 2, '干跑列出 2 条待收编');
  ok(dry.bad.length === 1, '坏行数出来而不是丢掉');
  ok(cmdList(f, { all: true }).rows.length === beforeAll, '干跑不写盘');
  const imp = cmdImport(f, { from: candFile });
  ok(imp.created.length === 2, '真收编 2 条');
  ok(imp.created[0].id.startsWith('X-'), '收编时给正式 id');
  ok(cmdList(f, { all: true }).rows.find((r) => r.open.includes('重采样')).ref === 'seg:s#9.1', 'ref 指回原话段');
  const again = cmdImport(f, { from: candFile });
  ok(again.created.length === 0 && again.skipped.length === 2, '再导一次不重复');

  fs.rmSync(dir, { recursive: true, force: true });
  return { pass, fail, bad, total: pass + fail };
}

// ---- CLI ----------------------------------------------------------------
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const opt = { _: [] };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v === undefined) { const nx = argv[i + 1]; if (nx && !nx.startsWith('-')) { opt[k] = nx; i++; } else opt[k] = true; }
    else opt[k] = v;
  } else opt._.push(a);
}

if (opt.selftest || cmd === '--selftest') {
  const r = selftest();
  console.log(`悬案表自测：${r.pass}/${r.total} PASS`);
  if (r.fail) { console.log('失败项：'); for (const b of r.bad) console.log('  - ' + b); process.exit(1); }
  process.exit(0);
}

if (cmd === 'add') {
  const r = cmdAdd(FILE, opt);
  if (r.err) { console.error('拒绝：' + r.err); process.exit(2); }
  console.log(`已登记 ${r.id}`);
} else if (cmd === 'import') {
  const r = cmdImport(FILE, opt);
  if (r.err) { console.error('拒绝：' + r.err); process.exit(2); }
  let head = '收编 ' + r.created.length + ' 条，跳过 ' + r.skipped.length + ' 条';
  if (r.dry) head = '（干跑，没写盘）' + head;
  if (r.bad.length) head += '，读不出 ' + r.bad.length + ' 行';
  console.log(head);
  for (const c of r.created) console.log('  + ' + c.id + '  ' + c.seg + '  ' + c.q);
  for (const s of r.skipped) console.log('  · ' + s.why + '：' + s.q);
} else if (cmd === 'touch') {
  const r = cmdTouch(FILE, opt);
  if (r.err) { console.error('拒绝：' + r.err); process.exit(2); }
  console.log(`${r.id}：${r.from} → ${r.to}`);
} else if (cmd === 'stale') {
  const r = cmdStale(FILE, opt);
  console.log(`超过 ${r.days} 天没动静、还挂着的 ${r.rows.length} 条${r.applied ? '（已降为 abandoned）' : '（只看，没改）'}：`);
  for (const c of r.rows) console.log(`  ${c.id}  ${c.last}  ${c.open}`);
} else if (cmd === 'show') {
  const { cases } = load(FILE);
  const c = cases.get(opt._[0]);
  if (!c) { console.error('没有这个 id'); process.exit(2); }
  console.log(`${c.id}  [${c.state}]  开于 ${c.opened}  最近 ${c.last}`);
  console.log('问题：' + c.open);
  console.log('收掉时长什么样：' + c.synth);
  if (c.ref) console.log('指向：' + c.ref);
  if (c.lastWhy) console.log('上次动静：' + c.lastWhy);
} else {
  const { rows, bad } = cmdList(FILE, opt);
  if (!rows.length) console.log('没有挂着的事。');
  for (const c of rows) {
    const mark = c.state === 'abandoned' ? '·' : '○';
    console.log(`${mark} ${c.id}  ${c.last}  ${c.open}`);
  }
  if (bad.length) console.log(`\n注意：表里有 ${bad.length} 行读不出来（不是没有，是坏了）`);
}
