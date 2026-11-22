// 鱼知 · 段向量补算
// 写入路径不碰向量：/add 是同步的、零依赖的，不该因为一个外部服务挂了就写不进去。
// 向量是派生数据，事后补算——这个脚本扫一遍用户的段，缺哪段补哪段。
// 可重入、可断点续跑：算完的会写明白，下次跳过；中途挂掉再跑一次就行。
//
// 用法：
//   node src/embed.mjs --user u-imp                       # 用环境变量里的 embedding 服务
//   node src/embed.mjs --user u-imp --base http://127.0.0.1:9997/v1 --model bge-m3
//   node src/embed.mjs --user u-imp --dry                 # 只说会算几条，不写
//   node src/embed.mjs --user u-imp --limit 50 --batch 8
//
// 补算完不用重启 server：它按文件 mtime 判断要不要重建索引。
import { DATA_DIR, readUser, appendVecs } from './store.mjs';
import { makeHttpEmbedder, encodeVec, embedderFromEnv, DEFAULT_EMBED_MODEL } from './embedding.mjs';

function parseArgs(argv) {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      out.set(key, next);
      i += 1;
    } else {
      out.set(key, true);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const user = args.get('user');
if (!user || user === true) {
  console.error('要 --user <user_id>');
  process.exit(2);
}
const dir = args.get('dir') || DATA_DIR;
const dry = Boolean(args.get('dry'));
const limit = Number(args.get('limit') || 0) || 0;
const batch = Number(args.get('batch') || 0) || 16;
// 改名（2026-11-22 未结 → 鱼知）：新名 YUZHI_* 先认，旧名 UNCLOSED_* 兜底。
const model = String(args.get('model') || process.env.YUZHI_EMBED_MODEL || process.env.UNCLOSED_EMBED_MODEL || DEFAULT_EMBED_MODEL);

const base = String(args.get('base') || process.env.YUZHI_EMBED_URL || process.env.UNCLOSED_EMBED_URL || '');
if (!base) {
  console.error('没有 embedding 服务地址：设 YUZHI_EMBED_URL（旧名 UNCLOSED_EMBED_URL 也认），或传 --base <url>');
  console.error('bge 的接法见 README 的「接向量」一节。');
  process.exit(2);
}

const envEmbedder = embedderFromEnv();
const embedder = makeHttpEmbedder({
  baseUrl: base,
  apiKey: String(args.get('key') || process.env.YUZHI_EMBED_KEY || process.env.UNCLOSED_EMBED_KEY || ''),
  model,
  dim: Number(args.get('dim') || process.env.YUZHI_EMBED_DIM || process.env.UNCLOSED_EMBED_DIM || 0) || 0,
  batchSize: batch,
});

const { segs, vecs } = readUser(dir, String(user));
if (!segs.length) {
  console.error('这个 user 没有任何段（' + String(user) + '），先 /add 再补向量');
  process.exit(1);
}

const need = segs.filter((s) => {
  const rec = vecs.get(s.id);
  return !rec || rec.model !== model;
});

console.log('段 ' + segs.length + ' 条；要算 ' + need.length + ' 条；已有同模型向量 ' + (segs.length - need.length) + ' 条（' + model + '）');
if (envEmbedder) console.log('提示：环境变量里还配了 YUZHI_EMBED_URL（旧名 UNCLOSED_EMBED_URL），这次以命令行参数为准。');
if (dry) {
  console.log('--dry：一条没写。');
  process.exit(0);
}

const list = limit > 0 ? need.slice(0, limit) : need;
let done = 0;
let failed = 0;
const t0 = Date.now();

for (let i = 0; i < list.length; i += batch) {
  const slice = list.slice(i, i + batch);
  let out;
  try {
    out = await embedder.embed(slice.map((s) => s.text));
  } catch (e) {
    failed += slice.length;
    console.error('这批挂了（从 ' + slice[0].id + ' 起 ' + slice.length + ' 条）：' + String((e && e.message) || e));
    continue;
  }
  const rows = [];
  for (let j = 0; j < slice.length; j += 1) {
    const v = out[j];
    if (!Array.isArray(v) || !v.length) {
      failed += 1;
      continue;
    }
    rows.push({ id: slice[j].id, model, dim: v.length, v: encodeVec(v) });
  }
  appendVecs(dir, String(user), rows);
  done += rows.length;
  console.log('[' + Math.min(i + batch, list.length) + '/' + list.length + '] 写了 ' + rows.length + ' 条');
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('完成：写入 ' + done + ' 条，失败 ' + failed + ' 条，耗时 ' + secs + ' 秒。模型 ' + model + '。');
if (failed) process.exit(1);
