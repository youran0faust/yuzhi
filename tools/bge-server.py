#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
鱼知 · 本地 bge 向量服务（可选门的外部依赖）

为什么要有这个文件：鱼知本体是零依赖的，向量门只在配了 YUZHI_EMBED_URL（旧名 UNCLOSED_EMBED_URL 也认）时才开。
这个服务就是那个「外部」。它不碰鱼知的数据，只回答一个问题：这段文字 → 这串数。

模型：仓库自带 models/bge-small-zh（bge-small-zh-v1.5 int8，约 24 MB，512 维）。
运行时：python + numpy + onnxruntime + tokenizers（一条 pip 命令见 tools/requirements-bge.txt），不联网、不去 HF 拉东西。

用法：
  python tools/bge-server.py                     # 起在 127.0.0.1:8898
  python tools/bge-server.py --selftest          # 只测一遍，不起服务
  BGE_MODEL_DIR=... BGE_PORT=8898 python tools/bge-server.py

接口（OpenAI 兼容的子集）：
  GET  /health            → {"ok":true,"model":...,"dim":...}
  POST /v1/embeddings     {input: "文本" | ["文本", ...]} → {data:[{embedding:[...]}],...}

★ 这里刻意**不加** bge 的 query 前缀：服务只做编码，不猜调用方要拿它当 query 还是当文档。
  query 前缀（"为这个句子生成表示以用于检索相关文章："）由调用方加 —— 鱼知是在 server 算 query 向量时加。
  理由：doc 加前缀会整体抬高相似度、反而降低区分度（echo 那边实测过）。
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_LIBS = os.environ.get('BGE_PYLIBS')
if _LIBS and os.path.isdir(_LIBS):
    sys.path.insert(0, _LIBS)
try:
    import numpy as np
    from tokenizers import Tokenizer
    import onnxruntime as ort
except ImportError as e:
    sys.stderr.write(
        '缺 Python 依赖: ' + str(e) + '\n'
        '  → pip install -r tools/requirements-bge.txt\n'
        '  → 依赖装在别处了？设 BGE_PYLIBS 指到那个目录（前置到 sys.path）\n')
    sys.exit(3)

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass

_HERE = os.path.dirname(os.path.abspath(__file__))
_LOCAL_MODEL = os.path.normpath(os.path.join(_HERE, '..', 'models', 'bge-small-zh'))
# 模型目录：先看 BGE_MODEL_DIR，再看仓库自带的 models/bge-small-zh
MODEL_DIR = os.environ.get('BGE_MODEL_DIR') or _LOCAL_MODEL
PORT = int(os.environ.get('BGE_PORT', '8898'))
HOST = os.environ.get('BGE_HOST', '127.0.0.1')

if not os.path.isdir(MODEL_DIR):
    sys.stderr.write('模型目录不存在: ' + MODEL_DIR + '\n'
                     '  → 仓库自带 models/bge-small-zh；被清掉了就把它放回去，或设 BGE_MODEL_DIR 指到别处\n')
    sys.exit(2)

tok_path = os.path.join(MODEL_DIR, 'tokenizer.json')
_ONNX_CANDIDATES = [
    os.path.join(MODEL_DIR, 'onnx', 'model_quantized.onnx'),
    os.path.join(MODEL_DIR, 'onnx', 'model.onnx'),
    os.path.join(MODEL_DIR, 'model_quantized.onnx'),
    os.path.join(MODEL_DIR, 'model.onnx'),
]
onnx_path = next((p for p in _ONNX_CANDIDATES if os.path.isfile(p)), None)
if not os.path.isfile(tok_path) or onnx_path is None:
    sys.stderr.write('模型文件不全: ' + MODEL_DIR + '\n'
                     '  → 需要 tokenizer.json，以及 onnx/model_quantized.onnx（换成 fp32 时是 onnx/model.onnx）\n')
    sys.exit(2)

tok = Tokenizer.from_file(tok_path)
try:
    if tok.truncation is None:
        tok.enable_truncation(max_length=512)
except Exception:
    try:
        tok.enable_truncation(max_length=512)
    except Exception:
        pass

sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
IN_NAMES = [i.name for i in sess.get_inputs()]
OUT_NAMES = [o.name for o in sess.get_outputs()]
LOCK = threading.Lock()

def embed(texts):
    encs = [tok.encode(t) for t in texts]
    maxlen = max(len(e.ids) for e in encs)
    n = len(encs)
    ids = np.zeros((n, maxlen), dtype=np.int64)
    mask = np.zeros((n, maxlen), dtype=np.int64)
    for i, e in enumerate(encs):
        L = len(e.ids)
        ids[i, :L] = e.ids
        mask[i, :L] = 1
    feed = {}
    if 'input_ids' in IN_NAMES:
        feed['input_ids'] = ids
    if 'attention_mask' in IN_NAMES:
        feed['attention_mask'] = mask
    if 'token_type_ids' in IN_NAMES:
        feed['token_type_ids'] = np.zeros_like(ids)
    out = sess.run(OUT_NAMES, feed)
    h = np.asarray(out[0], dtype=np.float32)
    if h.ndim == 3:
        m = mask[:, :, None].astype(np.float32)
        h = (h * m).sum(axis=1) / np.maximum(m.sum(axis=1), 1e-9)
    h = h / np.maximum(np.linalg.norm(h, axis=1, keepdims=True), 1e-9)
    return h

def cosine(a, b):
    return float(np.dot(a, b))

if '--selftest' in sys.argv:
    t0 = time.time()
    e = tok.encode('这是一句测试文本')
    print('样例 token 首尾: ' + str(e.tokens[:3]) + ' ... ' + str(e.tokens[-2:]))
    V = embed(['这是一句测试文本', '记忆召回与上下文压缩', '换气压缩机制', '今天天气不错'])
    print('维度 ' + str(V.shape[1]) + '，4 条耗时 ' + str(round((time.time() - t0) * 1000)) + 'ms')
    print('「记忆召回」vs「换气压缩」 ' + str(round(cosine(V[1], V[2]), 4)) + '  ← 应该偏低')
    print('「测试文本」vs「今天天气」   ' + str(round(cosine(V[0], V[3]), 4)) + '  ← 应该偏低')
    print('「测试文本」vs「记忆召回」   ' + str(round(cosine(V[0], V[1]), 4)))
    sys.exit(0)

DIM = int(embed(['初始化']).shape[1])
print('bge 服务：' + MODEL_DIR)
print('维度 ' + str(DIM) + '；输入 ' + str(IN_NAMES) + '；输出 ' + str(OUT_NAMES))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        try:
            self.wfile.write(b)
        except Exception:
            pass

    def do_GET(self):
        if self.path == '/health':
            return self._json(200, {'ok': True, 'model': 'bge-small-zh-v1.5-int8', 'dim': DIM})
        return self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/v1/embeddings':
            return self._json(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('content-length') or 0)
            body = json.loads(self.rfile.read(n).decode('utf-8') or '{}')
        except Exception as e:
            return self._json(400, {'error': 'bad json: ' + str(e)})
        inp = body.get('input')
        if isinstance(inp, str):
            inp = [inp]
        if not isinstance(inp, list) or not inp:
            return self._json(400, {'error': 'input 必须是字符串或非空数组'})
        texts = [str(t) for t in inp]
        try:
            with LOCK:
                V = embed(texts)
        except Exception as e:
            return self._json(500, {'error': str(e)})
        data = [{'embedding': [float(x) for x in v]} for v in V]
        return self._json(200, {'data': data, 'model': 'bge-small-zh-v1.5-int8', 'dim': int(V.shape[1])})

srv = ThreadingHTTPServer((HOST, PORT), Handler)
print('listening http://' + HOST + ':' + str(PORT) + '  (POST /v1/embeddings, GET /health)')
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
