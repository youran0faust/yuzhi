// 鱼知 · 向量门接口层
// 这一层只做四件事：把向量编码成能进 JSONL 的形式、给外部 embedding 服务一个统一入口、
// 用余弦算相似度、从环境变量读配置。它不装模型、不联网、不碰文件系统。
//
// 为什么是「可选」而不是「默认」：项目的门槛是 clone 下来 node 一跑就通，不依赖外部服务。
// 所以向量门默认关着；配了 YUZHI_EMBED_URL（旧名 UNCLOSED_EMBED_URL 也认）才开。关着时如实标 skipped，并说清缺哪一样。
// 接 bge 这类中文模型走 OpenAI 兼容的 /v1/embeddings，本机 Xinference / TEI / ollama / LM Studio 都行。
//
// Embedder 的统一形状：{ embed(texts) -> number[][], model, dim }
// 只认这个形状，不认具体是谁家的模型——换 bge 换 m3e 换云服务，都只是换一个 baseUrl。

// —— 编码 ——
// JSONL 里放 float 数组会把文件撑大：1024 维 * 每条 6 个字符。存 float32 + base64 大约省一半。
// 精度损失对余弦排序没有实际影响（第 7 位小数），而且这一段只用于检索，不用于还原原文。
export function encodeVec(arr) {
  const f = Float32Array.from(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

export function decodeVec(str, dim = 0) {
  const buf = Buffer.from(String(str), 'base64');
  if (!buf.length || buf.length % 4 !== 0) throw new Error('向量字节数不是 4 的倍数');
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const out = Array.from(f);
  if (dim && out.length !== dim) throw new Error(`维度对不上：配置 ${dim}，实际 ${out.length}`);
  return out;
}

// 把 readUser 带出来的原始 vec 记录（v 是 base64）解成能算的数组。
// 坏记录不抛，收进 bad 里报数——一个坏段不该让整库用不了，但必须让人知道它坏了。
export function decodeVecs(raw) {
  const out = new Map();
  const bad = [];
  for (const [id, rec] of raw || []) {
    try {
      const v = decodeVec(rec.v, rec.dim || 0);
      out.set(id, { model: rec.model || '', dim: v.length, v });
    } catch (e) {
      bad.push({ id, error: String((e && e.message) || e) });
    }
  }
  return { vecs: out, bad };
}

// —— 相似度 ——
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) throw new Error('cosine 要两个数组');
  if (a.length !== b.length) throw new Error(`维度不一致：${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// —— 外部服务 ——
export const DEFAULT_EMBED_MODEL = 'bge-m3';

export function makeHttpEmbedder({
  baseUrl, apiKey = '', model = DEFAULT_EMBED_MODEL, dim = 0, batchSize = 16, timeoutMs = 30000,
  queryPrefix = '',
} = {}) {
  if (!baseUrl) throw new Error('makeHttpEmbedder 要 baseUrl');
  const endpoint = String(baseUrl).replace(/\/+$/, '') + '/embeddings';
  let resolvedDim = dim || 0;

  const embed = async function embed(texts) {
    const input = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
    const out = [];
    for (let i = 0; i < input.length; i += batchSize) {
      const slice = input.slice(i, i + batchSize);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({ model, input: slice, encoding_format: 'float' }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embedding 服务回 ${res.status}：${body.slice(0, 200)}`);
      }
      const payload = await res.json();
      const items = Array.isArray(payload.data) ? payload.data : [];
      if (items.length !== slice.length) throw new Error(`向量数量不对：要 ${slice.length}，回 ${items.length}`);
      for (const it of items) {
        const v = it && (it.embedding || it.vector);
        if (!Array.isArray(v) || !v.length) throw new Error('返回里没有向量');
        if (resolvedDim && v.length !== resolvedDim) throw new Error(`维度不对：配置 ${resolvedDim}，回 ${v.length}`);
        resolvedDim = v.length;
        out.push(v);
      }
    }
    return out;
  };

  // bge 这类模型：query 与 doc 不对称 —— query 要加前缀、doc 不加。
  // 服务只做编码、不猜调用方拿它当什么，所以前缀放在这里由调用方选。
  const embedQuery = async function embedQuery(texts) {
    const list = (Array.isArray(texts) ? texts : [texts]).map((t) => queryPrefix + String(t == null ? '' : t));
    return embed(list);
  };

  return { embed, embedQuery, model, dim: dim || 0, baseUrl: endpoint, queryPrefix };
}

// 没配 YUZHI_EMBED_URL（旧名 UNCLOSED_EMBED_URL 也认）就返回 null——「没配」和「配错」必须分开：
// 一个是正常默认，一个是故障，混在一起就永远查不出是哪种。
export function embedderFromEnv(env = process.env) {
  // 改名（2026-11-22 未结 → 鱼知）：新名优先，旧名兜底。
  const pick = (name) => env['YUZHI_' + name] ?? env['UNCLOSED_' + name];
  const baseUrl = pick('EMBED_URL') || '';
  if (!baseUrl) return null;
  return makeHttpEmbedder({
    baseUrl,
    apiKey: pick('EMBED_KEY') || '',
    model: pick('EMBED_MODEL') || DEFAULT_EMBED_MODEL,
    dim: Number(pick('EMBED_DIM') || 0) || 0,
    batchSize: Number(pick('EMBED_BATCH') || 16) || 16,
    // 默认空：不是所有 embedding 模型都要前缀。用 bge 系时显式设这组（本机设的就是它）。
    queryPrefix: pick('EMBED_QUERY_PREFIX') || '',
  });
}

// 只给自测和「没有模型也想把流程跑通」用。它按字符码哈希出维度，**不是语义向量**：
// 换一个说法它就完全对不上，拿它跑出来的排序不能当「向量门好不好使」的证据。
export function makeHashEmbedder(dim = 64) {
  const size = Math.max(8, Number(dim) || 64);
  const embed = async function embed(texts) {
    return (Array.isArray(texts) ? texts : [texts]).map((t) => {
      const v = new Array(size).fill(0);
      const s = String(t == null ? '' : t);
      for (let i = 0; i < s.length; i += 1) {
        const code = s.charCodeAt(i);
        v[code % size] += 1;
        v[(code * 31 + i) % size] += 0.5;
      }
      return v;
    });
  };
  return { embed, model: 'hash-selftest', dim: size };
}
