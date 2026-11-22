# 鱼知 · Yuzhi

[![License: MIT](https://img.shields.io/badge/license-MIT-4EA8DE?style=flat-square)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square)](https://nodejs.org) [![Python](https://img.shields.io/badge/python-3.9%2B-3776AB?style=flat-square)](https://www.python.org) [![Offline](https://img.shields.io/badge/offline-local--first-2B6CB0?style=flat-square)](#快速开始) [![Version](https://img.shields.io/badge/version-0.1.1-F5A623?style=flat-square)](package.json)

一个能翻回去的个人记忆层。零依赖（Node 18+），数据就是一个 `.jsonl` 文件。

大多数记忆系统帮你「找到最像的 5 条」。它解决的是另一半：你不知道该取什么的时候，凭什么还能想起来。
做法很土——存原话，记住还没闭合的事，把「变了」记成新增一行，不覆盖。

## 三条主张

1. **原话优先，摘要只能是索引。** 每一段取回都自带说话人、日期、原话；脱离上下文也读得懂。
2. **未闭合的比已完成的更值钱。** 事件记完就死，问题记着还活。所以有一张悬案表。
3. **证据不足不许覆盖。** 写之前先问「这条有没有证据」，答不上来就留「待核」，不拿旧值装新值。

## 快速开始

仓库里带了一份合成对话（13 段、8 道题，人名和事都是编的）。下面四条命令不联网、不写你自己的库：

```bash
node src/replay.mjs --data examples/demo-locomo.json   # 离线回放，算 hit@k
node test/contract.mjs                                # 接口契约 44 条
node test/expect.mjs                                  # 8 道题该取回哪一段
node test/vector-e2e.mjs                              # 向量门端到端（起假服务，不用真模型）
```

## 跑起来

```bash
node src/server.mjs        # 默认 127.0.0.1:8850
```

四个口，字段定义见 [SPEC.md](SPEC.md) 第 6 节：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 活着没有 |
| POST | `/add` | 灌一段原话，只追加 |
| POST | `/search` | 取回 |
| GET | `/stats` | 段数 / 请求数 / 时间跨度 |

灌一句，再问一句：

```bash
curl -s -X POST http://127.0.0.1:8850/add -H "content-type: application/json" -d '{
  "request_id":"r-1","user_id":"me","session_id":"s1",
  "messages":[{"role":"user","content":"那句原话是什么","timestamp":"2026-11-19T14:15:00+08:00"}]
}'

curl -s -X POST http://127.0.0.1:8850/search -H "content-type: application/json" \
  -d '{"user_id":"me","query":"那句原话是什么","top_k":5}'
```

取回的第一条长这样，日期、说话人、原文齐全，脱离上下文也读得懂：

```json
{"id":"seg-…","content":"[2026-11-19 (Thu) 14:15] 爱丽丝: 收到","score":0.83,"agreement":2}
```

`agreement` 是几扇门各自独立把它排进前 10 的票数，只当信心分挂在结果上，不参与排序。

## 它怎么转（一张图）

```
   对话 / 日记 / 聊天记录
            │
            ▼
   ┌──────────────────────────┐
   │ Add：一段原话一段，只追加  │
   │ 时间戳三级兜底，不知道就写 unknown（不填「现在」）
   └───────────┬──────────────┘
               │
        ┌──────┴───────┐
        ▼              ▼
 ┌─────────────┐  ┌──────────────────────┐
 │ 原话账本     │  │ 线索层 threads.mjs    │
 │ (seg)       │  │ 5 个信号 + 2 条抑制    │
 └──────┬──────┘  └──────────┬───────────┘
        │                    ▼
        │            候选文件（不是账）
        │                    │ 人看一遍（这步不能省）
        │                    ▼
        │          ┌────────────────────┐
        │          │ 悬案表（四态闭环）  │
        │          │ unresolved /       │
        │          │ resolved /         │
        │          │ dissolved /        │
        │          │ abandoned          │
        │          └─────────┬──────────┘
        ▼                    ▼
 ┌───────────────────────────────────────────┐
 │ Search：五门（词面 / 字面 / 实体 / 时间 / 向量）
 │         + RRF 融合；整块打包，绝不截断
 │         悬案挂到 open_questions，不挤原话
 └───────────────────┬───────────────────────┘
                     ▼
   [2026-11-19 (Thu) 14:15] 爱丽丝: 原文原样
   ↑ 自足：脱离上下文也读得懂，谁说的、哪天、原话
```

三条边界写死在这张图里：**只追加**（没有原地改写）、**候选不是账**（线索层不自己建案）、**悬案不挤原话**（两栏并列，不混排序）。

## 它和 RAG / 向量库差在哪

| 它们在做什么 | 这里在做什么 |
| --- | --- |
| 按相似度取回 top-k | 按「还有什么事悬着」组织记忆 |
| 存原文，按字面召回 | 每条悬案还存一句「它被收掉时长什么样」，用来撞上换了词的说法 |
| 摘要压缩成结论 | 摘要只当索引，原话永远优先 |
| 覆盖写 | 变了就新增一行，旧行标作废 |
| 忘掉旧事 | 久无推进只降一级（不进死档），检索扑空时再扫一层 |

## 数据形状

主库一个 `.jsonl`，两种行：

```
{"k":"case","id":"X-001","open":"…悬置的问题…","synth":"…它被收掉时长什么样…","opened":"2026-11-21"}
{"k":"move","id":"X-001","from":"unresolved","to":"resolved","why":"…","t":"2026-11-21"}
```

状态四态：`unresolved` / `resolved`（事回答了问题）/ `dissolved`（问题前提不再成立）/ `abandoned`（久无推进，降一级）。
`resolved` 和 `dissolved` 分开是因为「这事解决了」和「你好像不再纠结了」分量不同，说给真人听也不会混。

段向量是派生数据，单独一行（`{"k":"vec",…}`）：同一段重算一次就多一行，读的时候后者覆盖前者，**原文一个字不动**。

## 悬案表（命令行）

```bash
node src/case.mjs list                    # 还挂着的事
node src/case.mjs add --open "…" --synth "…"
node src/case.mjs touch X-001 --state=resolved --why "…"
node src/case.mjs stale --days=21         # 只看，不改
node src/case.mjs stale --days=21 --apply # 降为 abandoned
```

## 把自己的聊天记录灌进来

`/add` 要的是 messages 数组。手边只有 txt 的话，用 `examples/import-txt.mjs`：

```bash
node src/server.mjs
node examples/import-txt.mjs --in 聊天.txt --user me --session s1 --dry   # 先看条数
node examples/import-txt.mjs --in 聊天.txt --user me --session s1
```

认的格式（行首前缀，全角半角冒号都行）：`Q：` 用户、`A：` 助手、`T：` 当时的摘要。
`T：` 会被丢掉、不并进原话——摘要不是原话（主张 1）。没有时间就不传 `timestamp`，系统记 `unknown`，不拿服务器时间冒充（主张 3）。

## 向量门（可选，默认关着）

默认关不是为了省事，是为了让「clone 下来 node 一跑就通」这句话成立：一扇要联网、要 key 的门，会让第一次跑的人卡在门外。

它补的洞只有一个，但那个洞是真的：**换了个说法**。你问「她怕不怕消失」，库里那句是「我不愿意就这么断掉」，一个字都不重合，字面门摸不到。

三步（服务用任何 OpenAI 兼容的 embedding 服务，Xinference / TEI / ollama / LM Studio 都行）：

```bash
# 1) 先确认服务本身通
curl -s -X POST http://127.0.0.1:9997/v1/embeddings -H "content-type: application/json" \
  -d '{"model":"bge-m3","input":["测试"]}' | head -c 200

# 2) 给已经进库的原话补算向量（可重入，算过的跳过；--dry 只看条数）
YUZHI_EMBED_URL=http://127.0.0.1:9997/v1 YUZHI_EMBED_MODEL=bge-m3 node src/embed.mjs --user me --dry
YUZHI_EMBED_URL=http://127.0.0.1:9997/v1 YUZHI_EMBED_MODEL=bge-m3 node src/embed.mjs --user me

# 3) 起服务时带同一组变量，搜索就多开一扇门
YUZHI_EMBED_URL=http://127.0.0.1:9997/v1 YUZHI_EMBED_MODEL=bge-m3 node src/server.mjs
```

补算完不用重启：服务按数据文件的修改时间判断要不要重建索引。

四件要心里有数：

- **写入不等向量。** `/add` 是同步的、不联网；embedding 服务挂了，原话照样写得进去，补算另跑。
- **停用的门也要能查。** `/health` 报 `embedder.configured`；`/search` 的 `meta.skipped` 会说清缺哪一样（没配模型 / 段没算 / query 没算）。三种分开报——「没开」和「开了但坏了」混成一句，就永远查不出是哪种。
- **维度对不上的段跳过并报数**，不拿错的数糊排序。
- **向量是派生数据，原文不动。**

模型前缀按你用的那份模型卡来，代码里不写死。bge 系通常 query 加一句 instruction、段不加，所以多一个环境变量：

```bash
export YUZHI_EMBED_QUERY_PREFIX='为这个句子生成表示以用于检索相关文章：'
```

### 仓库自带一份能直接跑的中文向量模型

不用装 Xinference 那种大服务，也不用联网去 HuggingFace 拉模型：`models/bge-small-zh/` 里带了 24 MB 的 int8 版（512 维，ONNX）。`tools/bge-server.py` 用 python 直接跑它，暴露同一个 `/v1/embeddings`，一批几毫秒。它和本项目分开，本项目仍然零依赖。

唯一要自己装的是三个 Python 包（不是模型，是跑 ONNX 的轮子）：

```bash
python -m pip install -r tools/requirements-bge.txt   # numpy / onnxruntime / tokenizers
python tools/bge-server.py --selftest                 # 先验模型，应打印「维度 512」和几条余弦
python tools/bge-server.py                            # 127.0.0.1:8898
```

模型目录默认 `models/bge-small-zh`（可用 `BGE_MODEL_DIR` 改到别处；换成 fp32 版就把 `onnx/model.onnx` 放进去，两种文件名都认）。三个包装在别处时，用 `BGE_PYLIBS` 指过去。

clone 下来想先核模型有没有传坏：`models/bge-small-zh/onnx/model_quantized.onnx` 的 sha256 前 16 位是 `15B717C382BCB518`，`models/bge-small-zh/tokenizer.json` 是 `48CEA5D44424912A`。

```bash
export YUZHI_EMBED_URL=http://127.0.0.1:8898/v1
export YUZHI_EMBED_MODEL=bge-small-zh
```

结论只有一句，别指望多：**向量门补的是召回（让对的段进榜），不是排序（让它排前面）。** 融合是把各门名次平均，顶上去几道也会压下去几道。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `YUZHI_DATA` | 数据目录，默认 `data/` |
| `YUZHI_TOKEN` | 鉴权；空则不校验 |
| `CASE_FILE` | 悬案表文件位置 |
| `YUZHI_EMBED_URL` / `_MODEL` / `_KEY` / `_DIM` | 向量门；不配就是关着的 |
| `YUZHI_EMBED_QUERY_PREFIX` | 检索侧 query 前缀（bge 系通常要） |
| `BGE_MODEL_DIR` / `BGE_PYLIBS` | 自带的 Python 服务：模型目录、依赖目录 |

## 目录

```
src/       核心：store（原话账本）、recall（五门检索 + 融合）、server（四个口）、
           case（悬案表）、threads（线索层）、replay（回放）、embed（向量补算）
test/      三套自测
tools/     辅助：bge-server.py、导入、诊断、文档自查；diag-* / hmb-* 是 BENCH.md 里那些数字的复现脚本，要自备公开数据集
examples/  合成样例与导入脚本
models/    可选向量模型（int8，可删，删了只是没有向量门）
```

## 自测

```bash
node test/contract.mjs        # 接口契约 44 条
node test/expect.mjs          # 合成样例上的名次对照 8 条
node test/vector-e2e.mjs      # 向量门端到端
node src/case.mjs --selftest  # 悬案表
node tools/selftest-docs.mjs  # README / SPEC 里点过名的路径是否真存在
```

检索质量、公开数据集上的数字、以及那套数字量不到什么，见 [BENCH.md](BENCH.md)。

## 隐私

仓库里只有协议、代码和**合成数据**。真实的账本、日记、悬案一律不进仓库，`examples/` 里的人、日期、事全是编的。

## License

MIT，见 [LICENSE](LICENSE)。

作者：youran0faust。协力（co-author）：余鱼（yuyu）。

## 设计文档

[SPEC.md](SPEC.md)——数据模型、检索与融合、接口契约、诚实报数、负面清单，以及每条主张背后真踩过的坑。