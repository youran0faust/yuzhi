// 鱼知 / Yuzhi · 悬案表的读法（命令行和检索共用这一份）
// 一行一条；状态变更另写一行，不改旧行。
// 坏行要被数出来，不能静默丢掉：读不出来和「没有这条」是两件事。
import fs from 'node:fs';
import path from 'node:path';

export function readRaw(f) {
  if (!fs.existsSync(f)) return { ok: true, lines: [] };
  const text = fs.readFileSync(f, 'utf8');
  const out = [];
  for (const s of text.split(/\r?\n/)) {
    if (!s.trim()) continue;
    try { out.push(JSON.parse(s)); } catch { out.push({ k: 'bad', raw: s }); }
  }
  return { ok: true, lines: out };
}

export function load(f) {
  const { lines } = readRaw(f);
  const cases = new Map();
  const bad = [];
  const orphans = [];
  for (const l of lines) {
    if (l.k === 'bad') { bad.push(l.raw); continue; }
    if (l.k === 'case') {
      cases.set(l.id, {
        id: l.id, open: l.open, synth: l.synth || '', opened: l.opened,
        ref: l.ref || '', fp: l.fp || '', source: l.source || '', state: l.state || 'unresolved',
        last: l.opened, lastWhy: '', moves: 0
      });
    } else if (l.k === 'move') {
      const c = cases.get(l.id);
      if (!c) { orphans.push(l); continue; }
      c.state = l.to; c.last = l.t; c.lastWhy = l.why || ''; c.moves++;
    }
  }
  return { cases, bad, orphans, total: lines.length };
}

// 检索要的形状：问题句当匹配文本，状态带出去（abandoned 不等于不存在）。
export function hookCases(f) {
  const { cases, bad } = load(f);
  const out = [];
  for (const c of cases.values()) out.push({ id: c.id, q: c.open, state: c.state, subjects: [] });
  return { cases: out, bad: bad.length };
}

// 公开仓库里的默认值走相对路径；自己用的时候由 CASE_FILE 指过去。
export function defaultCaseFile() {
  return process.env.CASE_FILE || path.join(process.cwd(), 'data', 'cases.jsonl');
}
