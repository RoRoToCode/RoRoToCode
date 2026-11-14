/**
 * 界面文案：一份词条表，两种语言，命令行和网页共用。
 *
 * 为什么不做「双语并排」：
 *   报告是栅格排版的，标签列 12 个显示宽。中英并排（"文件 File"）会把它撑到
 *   20 列以上，窄终端直接折行，整张表歪掉。所以只显示一种语言，由用户选。
 *
 * 为什么语言是模块级状态而不是参数：
 *   文案散在 core/assess、core/quant、check.mjs、site/web 各处，逐层传 locale
 *   会把每个函数的签名都污染一遍。CLI 是单进程、网页是单页面，一个进程只服务
 *   一种语言，用状态最省事。要测另一种语言就 setLocale() 再跑。
 *
 * 三条硬规则：
 *   1. 术语不翻。GGUF / KV cache / Q4_K_M / tok/s / Metal 翻成中文反而看不懂。
 *   2. 数字和单位不本地化。全局统一 `12.34 GB`，不做 GB/GiB 之分。
 *   3. JSON 输出不翻。`--json` 里的 verdict 是稳定标识（agent-ready 等），
 *      翻译会直接破坏下游脚本。
 */

/** 支持的语言。第一个是兜底。 */
export const LOCALES = ['zh', 'en']

/**
 * 词条表。[中文, English]，顺序固定，缺一条就是 undefined —— 测试能抓到。
 * key 用「区域.用途」，区域跟报告的小节对齐，找文案时不用满文件翻。
 */
const DICT = {
  // ── 结论（core/assess.mjs headlineOf）
  'hl.unknown.title': ['算不出来', "Can't estimate"],
  'hl.unknown.short': ['算不出', "can't estimate"],
  'hl.unknown.why': ['模型里缺 block_count / head_count / embedding_length，只剩权重体积可信',
    'block_count / head_count / embedding_length are missing, so only the weight size is trustworthy'],
  'hl.nofit.title': ['这台机器跑不动', "Won't run on this machine"],
  'hl.nofit.short': ['装不下', "won't fit"],
  'hl.nofit.why.gpu': ['光权重就要 {w}，超过可用上限 {limit}', 'The weights alone need {w}, above the {limit} ceiling'],
  'hl.nofit.why.cpu': ['没有可用显存，权重也超过内存能腾出来的空间', 'No usable VRAM, and the weights exceed what RAM can free up'],
  'hl.notpl.title': ['能跑，但只会接着往下写', 'Runs, but it only continues your text'],
  'hl.notpl.short': ['无模板', 'no template'],
  'hl.notpl.why': ['模型里没有 chat_template，不会按一问一答的格式回复', 'No chat_template in the model, so it will not answer in a turn-by-turn format'],
  'hl.lowq.title': ['量化太低，不建议干活', 'Too lossy for real work'],
  'hl.lowq.short': ['别用', 'avoid'],
  'hl.lowq.why': ['1–2 bit 的输出不稳定，省下的显存会以工具调用反复失败的形式还回来',
    'At 1–2 bit the output is unstable; the VRAM you save comes back as repeated tool-call failures'],
  'hl.small.title': ['能跑，但干不了活', "Runs, but can't do the job"],
  'hl.small.short': ['太小', 'too small'],
  'hl.small.why': ['{p} 的模型，写代码和调用工具都撑不住', 'A {p} model cannot hold up for coding or tool calls'],
  'hl.notool.title': ['能聊天，但驱动不了 agent', "Chats fine, but can't drive an agent"],
  'hl.notool.short': ['不支持工具', 'no tools'],
  'hl.notool.why': ['模板里没有 tools 分支，工具定义塞不进 prompt', 'The template has no tools branch, so tool definitions cannot reach the prompt'],
  'hl.shortctx.title': ['能跑，但上下文太短', 'Runs, but the context is too short'],
  'hl.shortctx.short': ['上下文小', 'small ctx'],
  'hl.shortctx.why': ['最多 {ctx}，塞不下一个代码文件', 'At most {ctx} — not enough for one source file'],
  'hl.tight.title': ['能跑，量化勉强', 'Runs, but the quantization is borderline'],
  'hl.tight.short': ['勉强', 'borderline'],
  'hl.tight.why': ['{ctx} 装得下、模板也支持工具，但这个档位的工具调用会偶发不稳',
    '{ctx} fits and the template supports tools, but tool calls at this tier are occasionally flaky'],
  'hl.good.title': ['可以当 coding agent 用', 'Good to go as a coding agent'],
  'hl.good.short': ['推荐', 'recommended'],
  'hl.good.why': ['{ctx} 上下文装得下，模板也能驱动工具调用', '{ctx} of context fits, and the template can drive tool calls'],

  // ── 对话模板分析（core/assess.mjs analyzeTemplate）
  'tpl.none': ['模型内没有 chat_template', 'No chat_template in the model'],
  'tpl.tools.yes': ['模板含 tools 分支，支持注入工具定义', 'Template has a tools branch; tool definitions can be injected'],
  'tpl.tools.no': ['模板没有 tools 分支 → 工具定义无法注入 prompt', 'No tools branch → tool definitions cannot reach the prompt'],
  'tpl.call.yes': ['模板含工具调用输出格式（tool_call）', 'Template defines a tool-call output format (tool_call)'],
  'tpl.call.no': ['模板未定义工具调用输出格式', 'Template defines no tool-call output format'],

  // ── 量化分级（core/quant.mjs）
  'q.t0.label': ['严重有损', 'severely lossy'],
  'q.t0.note1': ['1-bit 级别，输出不稳定', '1-bit range, unstable output'],
  'q.t0.note2': ['2-bit 以下，长输出容易跑偏', 'Below 2-bit, long outputs drift'],
  'q.t1.label': ['明显有损', 'clearly lossy'],
  'q.t1.note': ['能对话，复杂推理明显退化', 'Chats fine, complex reasoning degrades'],
  'q.t2.label': ['有损', 'lossy'],
  'q.t2.note': ['日常可用，工具调用偶发不稳', 'Fine day to day, tool calls occasionally flaky'],
  'q.t3.label': ['轻微损失', 'slightly lossy'],
  'q.t3.note': ['主流选择，性价比最好', 'The mainstream pick, best value'],
  'q.t4.label': ['几乎无损', 'near lossless'],
  'q.t4.note1': ['质量接近原始', 'Quality close to the original'],
  'q.t4.note2': ['接近原始质量', 'Close to original quality'],
  'q.t5.label': ['无损', 'lossless'],
  'q.t5.note': ['原始精度', 'Original precision'],
  'q.unknown.label': ['未知', 'unknown'],
  'q.unknown.note1': ['文件名里没有量化标记', 'No quantization marker in the filename'],
  'q.unknown.note2': ['不在已知量化表里', 'Not in the known quantization table'],

  // ── 仓库对比的结论列（core/quant.mjs repoVerdict）
  'rv.noTemplate': ['无模板', 'no template'],
  'rv.cantEstimate': ['算不出', "can't estimate"],
  'rv.noFit': ['装不下', "won't fit"],
  'rv.avoid': ['别用', 'avoid'],
  'rv.noTools': ['不支持工具', 'no tools'],
  'rv.borderline': ['勉强', 'borderline'],
  'rv.smallCtx': ['上下文太小', 'small ctx'],
  'rv.ok': ['推荐', 'recommended'],

  // ── 通用
  'common.unknown': ['未知', 'unknown'],
  'common.by': ['by', 'by'],

  // ── 报告骨架
  'r.title': ['GGUF 体检报告', 'GGUF check report'],
  'r.disclaimer': ['⚠ 静态推算，仅供参考；实际加载运行一次才算数',
    '⚠ Static estimate only — load the model once to be certain'],

  // ── 模型小节
  's.model': ['模型', 'Model'],
  'f.file': ['文件', 'File'],
  'f.size': ['体积', 'Size'],
  'f.tensors': ['（{n} 个张量）', ' ({n} tensors)'],
  'f.shard': ['分片 {i}/{t}，全模型约 {size}', 'Shard {i}/{t}, full model ≈ {size}'],
  'f.arch': ['架构', 'Arch'],
  'f.params': [' · {p} 参数', ' · {p} params'],
  'f.quant': ['量化', 'Quant'],
  'f.ftype': ['（元数据写的是 {t}）', ' (metadata says {t})'],
  'f.nativeCtx': ['原生上下文', 'Native ctx'],
  'f.sliding': [' · 滑窗 {n}', ' · sliding window {n}'],
  'f.structure': ['结构', 'Structure'],
  'f.layers': ['{n} 层', '{n} layers'],
  'f.mtp': ['（含 {m} 层 MTP）', ' (incl. {m} MTP layers)'],
  'f.heads': ['{h} head / {kv} KV head', '{h} heads / {kv} KV heads'],
  'f.hidden': ['隐层 {n}', 'hidden {n}'],
  'f.gqa': ['（GQA，省显存）', ' (GQA, saves VRAM)'],
  'f.attention': ['注意力', 'Attention'],
  'f.kvLayers': ['{kl}/{rl} 层带 KV cache', '{kl}/{rl} layers carry KV cache'],
  'f.mixedInferred': ['元数据未声明 full_attention_interval，按 {i} 层 1 层 full attention 推断',
    'full_attention_interval not declared; assuming 1 full-attention layer per {i}'],
  'f.mixedExplicit': ['每 {i} 层 1 层 full attention', '1 full-attention layer per {i}'],
  'f.mixedNote': ['混合架构 · {how} · KV 增长远小于同规模纯注意力模型',
    'Hybrid arch · {how} · KV grows far slower than a pure-attention model of the same size'],

  // ── 硬件小节
  's.hw': ['硬件', 'Hardware'],
  'f.gpu': ['显卡', 'GPU'],
  'f.gpuNone': ['未检测到可用显卡', 'No usable GPU detected'],
  'f.gpuNoneNote': ['按 CPU 推理估算：只吃内存，速度慢 5–20 倍', 'Estimating CPU inference: uses RAM only, 5–20× slower'],
  'f.backendPending': ['待确认', 'unconfirmed'],
  'f.driver': ['驱动 {v}', 'driver {v}'],
  'f.bw': ['带宽 {n} GB/s', '{n} GB/s bandwidth'],
  'f.bwUnknown': ['带宽未收录', 'bandwidth not on file'],
  'f.vramAsGpu': ['可用作显存', 'Usable as VRAM'],
  'f.physRam': ['物理内存 {size}，与系统和所有程序共享', 'Physical RAM {size}, shared with the OS and every app'],
  'f.vram': ['显存', 'VRAM'],
  'f.vramUsable': ['可用显存', 'Usable VRAM'],
  'f.sharedNote': ['（无独立显存，按共享内存一半估）', ' (no dedicated VRAM; half of shared memory)'],
  'f.used': ['{size} 已用', '{size} used'],
  'f.usedPct': ['{p}% 已用', '{p}% used'],
  'f.totalSuffix': ['总量', 'total'],
  'f.freeSuffix': ['可用', 'free'],
  'f.ram': ['内存', 'RAM'],
  'f.cpu': ['CPU', 'CPU'],

  // ── 预算小节
  's.budgetVram': ['显存预算', 'VRAM budget'],
  's.budgetRam': ['内存预算', 'RAM budget'],
  'f.weights': ['权重', 'Weights'],
  'f.weightsShard': ['（第 1 片 × 片数）', ' (shard 1 × shard count)'],
  'f.overhead': ['运行时开销', 'Overhead'],
  'f.overheadNote': ['（推理上下文 + 计算缓冲）', ' (inference context + compute buffers)'],
  'f.vision': ['看图开销', 'Vision'],
  'f.visionNote': ['（投影器 {f} + 激活 384 MiB）', ' (projector {f} + 384 MiB activation)'],
  'f.visionCtx': ['带图时建议 {c}', 'with images: {c} recommended'],
  'f.visionNoFit': ['带图时一档都装不下（会退到分层或纯文本）',
    'with images no tier fits (falls back to layer split or text-only)'],
  'f.ceiling': ['可用上限', 'Ceiling'],
  'f.basis.wddmReclaim': ['其中 {n} 需靠关闭其他占显存的程序释放', '{n} of it needs other VRAM-hungry apps closed'],
  'f.basis.wddm': ['已扣除 {p}% 系统余量', 'after a {p}% system reserve'],
  'f.basis.wddmUnknown': ['读不到这张卡当前的已用显存（A 卡 / 核显驱动不给），按总显存的 {p}% 保守估',
    'current VRAM usage is unreadable on this adapter (AMD / iGPU drivers do not expose it); assuming {p}% of total'],
  'f.basis.free': ['已扣除 {p}% 余量；Linux 上显存不可驱逐', 'after a {p}% margin; VRAM is not evictable on Linux'],
  'f.basis.unified': ['按 macOS 建议的 GPU 可用上限再留 {p}% 给系统', 'macOS recommended GPU working set minus {p}% for the system'],
  'f.basis.ram': ['按物理内存的 {p}% 计，要给系统和页面缓存留空间', '{p}% of physical RAM, leaving room for the OS and page cache'],
  'f.usedWarn': ['⚠ 有 {n} 被其他程序占用（LM Studio / Ollama / 浏览器都可能）',
    '⚠ {n} is held by other apps (LM Studio / Ollama / a browser)'],
  'f.swaLine': ['滑窗架构：{full} 层全注意力 + {swa} 层滑窗（窗口 {w}）',
    'Sliding-window arch: {full} full-attention layers + {swa} SWA layers (window {w})'],
  'f.swaNote': ['层分配比例由架构规则推断，不同层规模组合可能有 ±25% 偏差',
    'Layer split is inferred from architecture rules; ±25% off for unusual layer mixes'],
  'f.swaNote2': ['；元数据未给滑窗 head_dim，按 key_length 顶替', '; no SWA head_dim in metadata, using key_length'],
  'f.slidingOnly': ['该模型用滑窗注意力（{w}），KV 估算偏保守', 'This model uses sliding-window attention ({w}); the KV estimate is conservative'],

  // ── 装不下 / 算不出
  'b.cantEstimate': ["? 算不出来", "? Can't estimate"],
  'b.cantEstimate1': ['缺 block_count / head_count / embedding_length', 'Missing block_count / head_count / embedding_length'],
  'b.cantEstimate2': ['权重体积仍然有效，但 KV cache 无法推算，所以给不出上下文建议',
    'The weight size is still valid, but KV cache cannot be derived, so there is no context advice'],
  'b.cantEstimate3': ['这通常是转换脚本写坏了，换一个上传者/仓库的文件再试',
    'Usually a broken conversion script — try a file from another uploader or repo'],
  'b.noFit': ['✗ 装不下', "✗ Won't fit"],
  'b.noFitLine': ['权重 {w} + 开销 {o} = {sum}，超过上限 {limit}', 'Weights {w} + overhead {o} = {sum}, above the {limit} ceiling'],
  'b.noFitVramFull': ['显卡显存已被其他程序占满（LM Studio / Ollama / 游戏 / 浏览器都可能），先关掉再查',
    'VRAM is held by other apps (LM Studio / Ollama / a game / a browser) — close them and retry'],
  'b.noFitRam': ['内存装不下，需要更小的量化；或关掉其他程序腾内存', "Won't fit in RAM: use a smaller quantization, or close other apps"],
  'b.noFitUnified': ['统一内存里没有「offload 到别处」这回事：换更小的量化，或关掉占内存的程序',
    'On unified memory there is nowhere to offload to: use a smaller quantization, or free memory'],
  'b.noFitDiscrete': ['只能部分 offload（--n-gpu-layers 减半），能跑但会慢 3–10 倍',
    'Partial offload only (halve --n-gpu-layers): it runs, 3–10× slower'],

  // ── 上下文档位表
  't.ctx': ['上下文', 'Context'],
  't.need': ['需要', 'Needs'],
  't.share': ['占上限', 'of ceiling'],
  't.cantEst': ['无法估算（缺层数/head 元数据）', 'cannot estimate (no layer/head metadata)'],
  't.beyond': ['  超出原生上下文', '  beyond native context'],
  't.tight': ['  接近上限', '  near ceiling'],
  't.bestCtx': ['建议上下文', 'Suggested ctx'],
  't.bestCtxNote': ['（{need} / 上限 {limit}）', ' ({need} / ceiling {limit})'],
  't.canGoHigher': ['原生支持 {n}，还能往上开，但显存不够', 'Native context is {n}, so you could go higher — but VRAM will not stretch'],
  't.nativeShort': ['⚠ 原生上下文太短', '⚠ Native context too short'],
  't.nativeShortNote': ['只有 {n}，长文件塞不进去，只能当玩具或做微调基座', 'Only {n} — long files will not fit; a toy, or a base for fine-tuning'],
  't.minNoFit': ['✗ 最小上下文也装不下', "✗ Even the smallest context won't fit"],
  't.minNoFitRam': ['需要更小的量化或更大的内存', 'Needs a smaller quantization or more RAM'],
  't.minNoFitVram': ['需要更小的量化或更大的显卡', 'Needs a smaller quantization or a bigger GPU'],

  // ── Agent 可用性
  's.agent': ['Agent 可用性', 'Agent readiness'],
  'a.noTpl': ['✗ 没有对话模板', '✗ No chat template'],
  'a.noTpl1': ['模型会退化成「接着往下写」，而不是一问一答 —— 本地小模型最常见的坑',
    'The model will keep writing instead of answering — the most common local-LLM trap'],
  'a.noTpl2': ['修法：用 --chat-template 指定，或写进 Ollama Modelfile 的 TEMPLATE',
    'Fix: pass --chat-template, or set TEMPLATE in an Ollama Modelfile'],
  'a.tpl': ['对话模板', 'Chat template'],
  'a.tplVariants': ['（另有 {list}）', ' (also: {list})'],
  'a.toolUse': ['工具调用', 'Tool use'],
  'a.strong': ['可直接驱动（模板级支持）', 'Directly drivable (template-level support)'],
  'a.strongNote': ['但能否稳定调用，仍需实跑一次确认', 'whether it calls tools reliably still needs one real run'],
  'a.partial': ['模板部分支持', 'Partial template support'],
  'a.partialNote': ['建议同时启用文本工具协议兜底', 'also enable a text tool protocol as a fallback'],
  'a.weak': ['支持较弱', 'Weak support'],
  'a.weakNote': ['小模型基本只会输出文字，别指望自主调用工具', 'small models mostly emit text — do not expect autonomous tool calls'],
  'a.none': ['不支持', 'Not supported'],
  'a.noneNote': ['只能纯对话，做不了 agent', 'plain chat only; it cannot act as an agent'],

  // ── 速度
  's.speed': ['预估速度', 'Estimated speed'],
  'v.cpu': ['CPU 推理', 'CPU inference'],
  'v.about': ['约 {n} tok/s', '≈ {n} tok/s'],
  'v.unknown': ['未知', 'unknown'],
  'v.formula': ['{bw} GB/s ÷ {gb} GB × {eff}', '{bw} GB/s ÷ {gb} GB × {eff}'],
  'v.buyGpu': ['装一块能全放下权重的显卡，速度大约是这里的 5–20 倍',
    'A GPU that holds all the weights would be roughly 5–20× faster'],
  'v.unified': ['统一内存', 'Unified memory'],
  'v.under': ['约 {n} tok/s 以内', 'under {n} tok/s'],
  'v.capNote': ['（公式值不可信：小模型受每 token 固定开销压制）', ' (the formula is unreliable here: per-token overhead dominates small models)'],
  'v.unifiedNote': ['GPU 和 CPU 用同一块内存，放不下时没有「offload 到内存」这种补救',
    'GPU and CPU share one memory pool; there is no offloading to RAM as a fallback'],
  'v.allVram': ['全程显存', 'All in VRAM'],
  'v.afterOffload': ['offload 后', 'After offload'],
  'v.muchSlower': ['明显变慢', 'much slower'],
  'v.offloadNote': ['权重能全放显存，但加上上下文就超了，被赶到内存的层按 {bw} GB/s 读',
    'The weights fit, but context pushes past the ceiling; offloaded layers read at {bw} GB/s'],
  'v.offloadNote2': ['如果能全放显存可达约 {n} tok/s，但要缩短上下文', 'About {n} tok/s if fully in VRAM, but you must shorten the context'],
  'v.partial': ['部分 offload', 'Partial offload'],
  'v.partialNote': ['权重本身就超出显存，剩余层走系统内存（约 {bw} GB/s）', 'The weights alone exceed VRAM; the rest runs from system RAM (≈ {bw} GB/s)'],
  'v.partialNote2': ['若全放显存可达约 {n} tok/s，但装不下', '≈ {n} tok/s if fully in VRAM, but it does not fit'],
  'v.moe': ['MoE 架构（{n} 专家），实际只激活一部分，真实速度会高于此值', 'MoE ({n} experts): only some activate per token, so real speed is higher'],
  'v.bottleneck': ['每吐一个 token 要把权重读一遍，瓶颈是带宽；误差约 ±{p}%',
    'Every token re-reads all the weights, so bandwidth is the bottleneck; ±{p}% error'],

  // ── 参数与假设（行内摘要）
  's.params': ['参数与假设', 'Parameters & assumptions'],
  'p.weights': ['权重', 'Weights'],
  'p.weightsVal': ['文件体积', 'File size'],
  'p.weightsValShard': ['文件体积，分片按第 1 片 × 片数', 'File size; shards = shard 1 × count'],
  'p.overhead': ['开销', 'Overhead'],
  'p.overheadVal': ['固定 {n}', 'fixed {n}'],
  'p.kv': ['KV', 'KV'],
  'p.kvVal': ['ctx × 层数 × n_kv_head × (k+v) × 每元素 {n} B', 'ctx × layers × n_kv_head × (k+v) × {n} B per element'],
  'p.ceiling': ['上限', 'Ceiling'],
  'p.speed': ['速度', 'Speed'],
  'p.speedVal': ['带宽 × {e} ÷ 权重GB，误差 ±{p}%', 'bandwidth × {e} ÷ weight GB, ±{p}%'],
  'p.threshold': ['门槛', 'Thresholds'],
  'p.thresholdVal': ['需要量 > 上限×{r} 算「接近」；< {p} 只算能跑；< {c} 算太短',
    'need > ceiling×{r} = "near"; < {p} = "runs only"; < {c} = "too short"'],
  'p.fullList': ['完整清单', 'Full list'],

  // ── 显存上限用的是哪套规则
  'lb.wddm': ['Windows WDDM：min(可用×{f}, 总显存×{t})，只按当前可用算', 'Windows WDDM: min(free×{f}, total×{t}), current free only'],
  'lb.free': ['Linux：可用×{f}（显存不可驱逐）', 'Linux: free×{f} (VRAM is not evictable)'],
  'lb.wddmUnknown': ['Windows：读不到已用显存，按总显存×{f} 保守估', 'Windows: usage unknown, assuming total×{f}'],
  'lb.unified': ['macOS 统一内存：Metal 建议工作集×{r}', 'macOS unified memory: Metal working set×{r}'],
  'lb.ram': ['无独显：物理内存×{r}', 'No dGPU: physical RAM×{r}'],
  'lb.other': ['未识别平台，按可用显存×0.92 估', 'Unknown platform; assuming free VRAM×0.92'],

  // ── --help
  'u.tagline': ['判断一个 GGUF 在你机器上能不能被 coding agent 用起来',
    'Will this GGUF actually work as a coding agent on your machine?'],
  'u.interactive': ['交互模式：粘贴链接或路径，回车即查（输入 lang 换语言）',
    'interactive: paste a link or path, press Enter (lang switches language)'],
  'u.repoCmd': ['对比一个仓库里所有量化', 'compare every quantization in one repo'],
  'u.options': ['选项', 'Options'],
  'u.optRepo': ['列出一个 HF 仓库的全部量化并逐个远程体检（不下载模型）',
    'list every quantization in a HF repo and check each remotely (no download)'],
  'u.optInteractive': ['兼容保留：不带任何参数时已经自动进入交互模式', 'kept for compatibility: no arguments already enters interactive mode'],
  'u.optJson': ['输出 JSON（便于脚本消费）', 'emit JSON (for scripts)'],
  'u.optNoColor': ['关闭颜色', 'disable color'],
  'u.optAscii': ['用纯 ASCII 符号（老终端/日志里更安全）', 'pure-ASCII glyphs (safer in old terminals and logs)'],
  'u.optKv': ['KV cache 精度：f16（默认）/ q8_0（省一半显存）/ q4_0',
    'KV cache precision: f16 (default) / q8_0 (half the VRAM) / q4_0'],
  'u.optVram': ['手动指定显存 GB（跳过硬件探测）', 'set VRAM in GB manually (skips detection)'],
  'u.optGpu': ['按第 N 块显卡评估（双卡机器上第二个模型用）', 'evaluate against GPU N (second model on a dual-GPU box)'],
  'u.optMmproj': ['连带视觉投影器一起算（看图模型必须传，否则少算 300~700 MiB）',
    'also count the vision projector (required for VL models; otherwise 300–700 MiB is missed)'],
  'u.optMirror': ['换模型站点：默认 hf-mirror.com，写 https://huggingface.co 即直连官方',
    'model host: hf-mirror.com by default; pass https://huggingface.co for the official site'],
  'u.optLang': ['界面语言：zh / en（默认跟随系统）', 'interface language: zh / en (follows the system by default)'],
  'u.optAbout': ['打印全部参数与假设（这份报告到底是怎么算出来的）', 'print every parameter and assumption (how the report is computed)'],
  'u.optHelp': ['显示本帮助', 'show this help'],
  'u.optVersion': ['显示版本（含仓库地址，方便二次分发时溯源）', 'show the version (with the repo URL, so redistributions can be traced)'],
  'u.fileUsage': ['vramfit <model.gguf | URL> [更多…]', 'vramfit <model.gguf | URL> [more…]'],
  'u.repoUsage': ['vramfit --repo <owner/name | 模型主页链接>', 'vramfit --repo <owner/name>'],
  'u.eqForm': ['也接受 --kv=q8_0 这种等号写法。', 'The --kv=q8_0 form works too.'],
  'u.exitCode': ['退出码：有文件读不到（或仓库里一个变体都读不到）时返回 1，--json 可直接进 CI。',
    'Exit code: 1 when a file cannot be read (or no variant in a repo can) — usable directly in CI with --json.'],
  'u.linkHead': ['链接可以直接贴 hf-mirror.com 或 huggingface.co：', 'Paste links from hf-mirror.com or huggingface.co:'],
  'u.link1': ['  文件直链 → 体检这一个文件', '  direct file link → checks that one file'],
  'u.link2': ['  模型主页 → 自动改成「量化对比」，列全部变体', '  model page → switches to a quantization comparison over all variants'],
  'u.link3': ['  blob 页面 → 自动换成文件直链', '  blob page → rewritten to the direct file link'],
  'u.shardHint': ['分片模型请指第 1 片（…-00001-of-00004.gguf），体积会按片数自动折算。',
    'For sharded models point at shard 1 (…-00001-of-00004.gguf); the size is scaled by shard count.'],
  'u.winHint': ['Windows 下双击 check.cmd 进入交互模式，Ctrl+V 或右键粘贴；粘不进来就输入 paste。',
    'On Windows double-click check.cmd for interactive mode; Ctrl+V or right-click to paste, or type paste.'],
  'u.npmHint': ['从 npm 装的是 vramfit 命令；直接跑源码的写法见 README，参数完全一致。',
    'Installed from npm the command is vramfit; running the source directly is documented in the README with identical flags.'],
  'u.dragHint': ['也可以把 .gguf 拖到 check.cmd 上。命令行里的链接要加引号（& 会被 cmd 截断）。',
    'You can also drop a .gguf onto check.cmd. Quote links on the command line (& gets cut by cmd).'],
  'u.aboutHint': ['所有结果都是静态推算，仅供参考，需实际加载测试。算式和参数见 ',
    'Everything here is a static estimate — load the model to be sure. Formulas and constants: '],
  'u.langHint': ['界面语言', 'Language'],

  // ── --about
  'ab.sub': ['结论是怎么算出来的', 'how the verdict is computed'],
  'ab.disclaimer1': ['免责：本工具不加载模型、不跑推理，所有数字都是静态推算。',
    'Disclaimer: this tool loads no model and runs no inference; every number is a static estimate.'],
  'ab.disclaimer2': ['  它的职责是排掉「根本不可能」的选项，不是给合格证。',
    '  Its job is to rule out the impossible, not to certify.'],
  'ab.foot1': ['改这些数字等于改结论。它们都在 core/assumptions.mjs 里，',
    'Changing these numbers changes the verdict. They live in core/assumptions.mjs;'],
  'ab.foot2': ['报告、网页、README 三处显示的是同一份，不会各说各话。',
    'the report, the web page and the README all render the same list, so they cannot disagree.'],
  'ab.contact': ['算错了、有问题、想提建议：', 'Wrong numbers, problems, suggestions:'],

  // ── 仓库对比表
  'rt.title': ['量化对比', 'Quantization comparison'],
  'rt.variants': ['{n} 个变体', '{n} variants'],
  'rt.q': ['量化', 'Quant'],
  'rt.size': ['体积', 'Size'],
  'rt.ctx': ['上下文', 'Context'],
  'rt.speed': ['速度', 'Speed'],
  'rt.quality': ['质量', 'Quality'],
  'rt.result': ['结论', 'Verdict'],
  'rt.netErr': ['读取失败（网络）', 'read failed (network)'],
  'rt.rec': ['推荐', 'Recommended'],
  'rt.recNote': ['{ctx} 上下文{spd} · {q}', '{ctx} context{spd} · {q}'],
  'rt.lowNote': ['低于 Q4 的量化能省显存，但输出不稳定，驱动 agent 会反复失败',
    'Below Q4 you save VRAM but lose stability; driving an agent will fail repeatedly'],
  'rt.none': ['没有适合 agent 的变体。最好的 {q}：{why}', 'No variant is agent-ready. Best is {q}: {why}'],
  'rt.whyNoTpl': ['缺少对话模板，模型只会续写', 'no chat template, so it only continues text'],
  'rt.whyNoTools': ['有模板但不含 tools 分支，只能对话、不能被 agent 驱动', 'a template exists but has no tools branch — chat only, no agent'],
  'rt.whyShortCtx': ['上下文不足 8K，塞不下代码文件', 'under 8K of context, too small for a source file'],
  'rt.allFailed': ['全部读取失败，这是网络问题，不是显存装不下', 'Every read failed — that is a network problem, not a VRAM problem'],
  'rt.allFailed2': ['镜像这会儿不稳定，稍后重试；或先下载到本地再检查', 'The mirror is unstable right now; retry later, or download the file and check it locally'],
  'rt.noneFit': ['这一整个仓库里没有能装进这台机器的变体', 'Not one variant in this repo fits this machine'],
  'rt.foot': ['⚠ 以上为静态推算，仅供参考；下载后请实际加载验证。参数与假设见 --about',
    '⚠ Static estimates only; load the model after downloading. Constants: --about'],
  'rt.shardNote': ['注意：有 {n} 个分片模型，体积按「第 1 片 × 片数」估算，实际以磁盘为准',
    'Note: {n} sharded models — size is estimated as shard 1 × count; trust the disk'],

  // ── 输入处理 / 错误
  'x.envRepo': ['本地没有这个路径，按 HF 仓库处理：{t}', 'No such local path; treating it as a HF repo: {t}'],
  'x.invalid': ['✗ {reason}：{t}', '✗ {reason}: {t}'],
  'x.noGguf': ['✗ 目录里没有 .gguf 文件：{t}', '✗ No .gguf files in this directory: {t}'],
  'x.foundN': ['在 {t} 下找到 {n} 个 gguf', 'Found {n} gguf files under {t}'],
  'x.shardTail': ['这是 {n} 片分片模型里的第 {i} 片，元数据只在第 1 片（…-00001-of-{p}.gguf）里，请检查那一片',
    'This is shard {i} of {n}; metadata lives only in shard 1 (…-00001-of-{p}.gguf) — check that one'],
  'x.remote': ['远程读取 {name} … 只读文件头部，镜像慢时可能要几十秒',
    'Reading {name} remotely … header only; a slow mirror can take tens of seconds'],
  'x.remoteFail1': ['    链接本身已经认出来了，卡在取文件头部这一步。', '    The link was parsed fine; it failed while fetching the header.'],
  'x.remoteFail2': ['    过 1–2 分钟再试一次，或先把 .gguf 下载到本地再查。', '    Retry in a minute or two, or download the .gguf and check it locally.'],
  'x.repoCount': ['{repo} 有 {n} 个量化，远程体检中（不下载模型）…', '{repo} has {n} quantizations; checking remotely (no download) …'],
  'x.progress': ['已读 {d}/{t} 个变体…', 'read {d}/{t} variants …'],
  'x.retrying': ['{n} 个变体没读到，稍等重试…', '{n} variants failed to read; retrying shortly …'],
  'x.retryN': ['重试 {k}/{n}…', 'retry {k}/{n} …'],
  'x.mirrorOn': ['模型站点：{url}', 'Model host: {url}'],
  'x.repoIgnore': ['注意：--repo 是整仓库对比模式，已忽略 {n} 个文件参数', 'Note: --repo compares a whole repo; ignored {n} file arguments'],
  'x.helpHint': ['用 --help 看全部参数', 'Run --help for every option'],
  'x.bye': ['已退出', 'Bye'],
  'x.prompt': ['检查 > ', 'check > '],
  'x.clipEmpty': ['剪贴板里没有文本（或者读不到剪贴板）', 'The clipboard has no text (or cannot be read)'],
  'x.clipGot': ['从剪贴板取到：{t}', 'Read from clipboard: {t}'],
  'x.unrecognized': ['没认出这是链接还是文件。', 'That is neither a link nor a file I recognise.'],
  'x.unrec1': ['· 链接只认 huggingface.co / hf-mirror.com 的模型页或 .gguf 直链', '· links must be a huggingface.co / hf-mirror.com model page or a .gguf direct link'],
  'x.unrec2': ['· 本地文件要给完整路径，或直接把文件拖进这个窗口', '· for local files give the full path, or drag the file into this window'],
  'x.unrec3': ['· 输入 help 看全部用法', '· type help for all usage'],
  'x.nodeOld': ['需要 Node.js 18 或更新版本，当前是 {ver}。', 'Node.js 18 or newer is required; this is {ver}.'],
  'x.nodeOldWhy': ['Node 16 及更早没有内置 fetch，本工具连不上 HuggingFace。',
    'Node 16 and earlier have no built-in fetch, so this tool cannot reach HuggingFace.'],
  'x.nodeOldFix': ['升级：winget install OpenJS.NodeJS.LTS   或   https://nodejs.org/',
    'Upgrade: winget install OpenJS.NodeJS.LTS   or   https://nodejs.org/'],

  // ── 交互模式抬头
  'i.mode': ['交互模式', 'interactive'],
  'i.pasteHead': ['把链接或路径粘贴进来，回车即体检：', 'Paste a link or a path and press Enter:'],
  'i.paste1': ['· hf-mirror / HuggingFace 的 {gguf}', '· a {gguf} from hf-mirror / HuggingFace'],
  'i.paste2': ['· 模型主页链接 → 自动列出 {all} 并对比', '· a model page → lists {all} and compares them'],
  'i.paste3': ['· 本地 .gguf 文件，或它所在的目录', '· a local .gguf file, or the directory holding it'],
  'i.paste4': ['· {repo}（如 unsloth/Qwen3-8B-GGUF）', '· {repo} (e.g. unsloth/Qwen3-8B-GGUF)'],
  'i.ggufLink': ['.gguf 直链', '.gguf direct link'],
  'i.allQuant': ['全部量化', 'every quantization'],
  'i.cmds': ['命令：', 'Commands: '],
  'i.cmdHelp': ['help', 'help'],
  'i.cmdHelpDesc': ['查看参数', '(options)'],
  'i.cmdCls': ['cls', 'cls'],
  'i.cmdClsDesc': ['清屏', '(clear)'],
  'i.cmdQ': ['q', 'q'],
  'i.cmdQDesc': ['退出', '(quit)'],
  'i.cmdLang': ['lang', 'lang'],
  'i.cmdLangDesc': ['切换语言', '(language)'],
  'i.pasteKey': ['粘贴：', 'Paste: '],
  'i.pasteMore': ['；一次粘多条，用空格或换行隔开。', '; several at once, separated by spaces or newlines.'],
  'i.pasteFallback1': ['如果怎么粘都粘不进来，输入 ', 'If pasting will not work at all, type '],
  'i.pasteFallback2': [' 直接从剪贴板读取（绕开终端）。', ' to read the clipboard directly (bypassing the terminal).'],
  'i.footNote': ['提示：结果均为静态推算，仅供参考，需实际加载测试。',
    'Note: every result is a static estimate — load the model to be sure.'],
  'i.langName': ['中文', 'English'],
  'i.langNow': ['当前界面语言：{name}', 'Current language: {name}'],
  'i.langSet': ['已切换为{name}，之后的结果都用{name}', 'Switched to {name}; later results are in {name}'],
  'i.langUsage': ['用法：lang zh  /  lang en（也可以直接敲 zh、en、cn）',
    'Usage: lang zh  /  lang en  (or just type zh, en, cn)'],
  'i.langBad': ['没有「{v}」这个语言，可选 zh / en', 'No such language "{v}"; pick zh or en'],
  'i.pasteWin': ['Ctrl+V 或右键', 'Ctrl+V or right-click'],
  'i.pasteMac': ['Cmd+V', 'Cmd+V'],
  'i.pasteLinux': ['Ctrl+Shift+V 或鼠标中键', 'Ctrl+Shift+V or middle-click'],

  // ── 输入解析（core/input.mjs）
  'in.modelscope': ['ModelScope 暂不支持，请在 hf-mirror.com 上找同一个仓库',
    'ModelScope is not supported; find the same repo on hf-mirror.com'],
  'in.noRepo': ['链接里没有仓库名', 'No repo name in the link'],
  'in.noRepo2': ['链接里缺少仓库名，正确的模型页长这样：/owner/repo',
    'Missing repo name; a valid model page looks like /owner/repo'],
  'in.repoNote': ['这是仓库地址，自动改为「量化对比」模式', 'That is a repo address; switching to comparison mode'],
  'in.blobNote': ['已把网页地址（blob）换成文件直链（resolve）', 'Rewrote the web page (blob) address to the direct file link (resolve)'],
  'in.notGguf': ['这个直链不是 .gguf 文件（{file}）', 'That direct link is not a .gguf file ({file})'],
  'in.modelPageNote': ['这是模型主页，自动改为「量化对比」模式（列全部量化，不用逐个点进去）',
    'That is a model page; switching to comparison mode (lists every quantization)'],

  // ── 参数校验（core/input.mjs parseOptions）
  'in.p.kvNeeds': ['--kv 后面要跟类型：f16 / q8_0 / q4_0', '--kv needs a type: f16 / q8_0 / q4_0'],
  'in.p.kvBad': ['不支持的 KV 类型「{v}」，可选：f16 / q8_0 / q4_0', 'Unsupported KV type "{v}"; choose f16 / q8_0 / q4_0'],
  'in.p.vramNeeds': ['--vram 后面要跟显存容量，单位 GB，例如 --vram 12', '--vram needs a capacity in GB, e.g. --vram 12'],
  'in.p.vramBad': ['--vram 要写正数 GB，收到「{v}」', '--vram must be a positive number of GB, got "{v}"'],
  'in.p.vramHuge': ['--vram {n} 看起来不是 GB，单卡显存不会超过 1024 GB', '--vram {n} does not look like GB; a single GPU stays under 1024 GB'],
  'in.p.gpuNeeds': ['--gpu 后面要跟显卡序号（从 0 开始），例如 --gpu 1', '--gpu needs a device index starting at 0, e.g. --gpu 1'],
  'in.p.gpuBad': ['--gpu 要写非负整数，收到「{v}」', '--gpu must be a non-negative integer, got "{v}"'],
  'in.p.repoNeeds': ['--repo 后面要跟仓库名，例如 unsloth/Qwen3-8B-GGUF', '--repo needs a repo name, e.g. unsloth/Qwen3-8B-GGUF'],
  'in.p.mirrorNeeds': ['--mirror 后面要跟地址，例如 --mirror https://huggingface.co（写官方地址＝不走镜像）',
    '--mirror needs a URL, e.g. --mirror https://huggingface.co (the official host means no mirror)'],
  'in.p.mirrorBad': ['--mirror 要以 http:// 或 https:// 开头，收到「{v}」', '--mirror must start with http:// or https://, got "{v}"'],
  'in.p.langNeeds': ['--lang 后面要跟语言：zh / en', '--lang needs a language: zh / en'],
  'in.p.langBad': ['不支持的语言「{v}」，可选：zh / en', 'Unsupported language "{v}"; choose zh / en'],
  'in.p.mmprojNeeds': ['--mmproj 后面要跟视觉投影器文件路径，例如 --mmproj mmproj-model.gguf',
    '--mmproj needs a projector file path, e.g. --mmproj mmproj-model.gguf'],
  'in.p.mmprojBad': ['读不到投影器「{v}」，已忽略它的开销（结论会偏乐观）',
    'Projector "{v}" is unreadable; its cost was ignored (the result is optimistic)']
}

/**
 * 把用户嘴里的语言名翻成 zh / en。
 *
 * 和 setLocale 分工不同：setLocale 只认 zh* / en*，因为它是给 `--lang` 用的——
 * 脚本里拼错了就该当场报错，猜只会把 bug 藏起来。这个函数是给交互模式用的，
 * 人会说 cn、中文、English，甚至跟着直觉敲 -cn，都得认。
 * 认不出来返回 null，由调用方决定怎么提示。
 */
export function localeOf(word) {
  // 允许前导横线：`-cn`、`--en`、`/en` 都能用，命令行里看着像参数，交互里像命令
  const s = String(word ?? '').trim().toLowerCase().replace(/^[-/]+/, '')
  if (!s) return null
  if (/^(?:en|eng|english|英文|英语)$/.test(s) || /^en[-_]/.test(s)) return 'en'
  if (/^(?:zh|cn|chs|cht|chinese|中文|简体|简体中文|汉语)$/.test(s) || /^(?:zh|cn)[-_]/.test(s)) return 'zh'
  return null
}

/** 当前语言 */
let current = LOCALES[0]

/** 显式设定语言。非法值抛错 —— 静默退回中文会让 --lang en 的用户以为翻译没生效。 */
export function setLocale(v) {
  const s = String(v ?? '').toLowerCase()
  const hit = s.startsWith('zh') ? 'zh' : s.startsWith('en') ? 'en' : null
  if (!hit) throw new Error(`unsupported locale: ${v} (use zh or en)`)
  current = hit
  return current
}

export function getLocale() {
  return current
}

/**
 * 猜一个语言。优先级：显式参数 > 环境变量 > 系统 locale > 浏览器/运行时。
 *
 * LANG=C / POSIX 当作「没表态」而不是英文：容器和 CI 里常这么设，
 * 但用户本机 Intl 往往还是中文。真判断不出来时兜底中文（项目和受众都在中文社区）。
 */
export function detectLocale({ env = {}, arg } = {}) {
  const norm = (v) => {
    const s = String(v ?? '').trim().toLowerCase()
    if (!s) return null
    if (s === 'c' || s === 'posix') return null
    if (/^zh\b|^zh[-_]/.test(s)) return 'zh'
    if (/^en\b|^en[-_]/.test(s)) return 'en'
    return null
  }
  const explicit = norm(arg) ?? norm(env.VRAMFIT_LANG) ?? norm(env.VRAMFIT_LOCALE)
  if (explicit) return explicit

  const sys = norm(env.LC_ALL) ?? norm(env.LC_MESSAGES) ?? norm(env.LANG) ?? norm(env.LANGUAGE)
  if (sys) return sys

  try {
    const l = norm(Intl.DateTimeFormat().resolvedOptions().locale)
    if (l) return l
  } catch { /* 老运行时不带 Intl，直接兜底 */ }
  return LOCALES[0]
}

/**
 * 取词条。占位符写成 {name}，多余变量忽略、缺失变量原样保留 ——
 * 这样漏传参数时看见的是 `{n}` 而不是 `undefined`，一眼能找到。
 */
export function t(key, vars) {
  const e = DICT[key]
  if (!e) return `⟪${key}⟫`
  let s = e[current === 'en' ? 1 : 0]
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
  }
  return s
}

/**
 * 标签列宽（显示宽度）。中文 6 个字 = 12 列，英文单词更长，得放到 14。
 * 这个数决定了「值从第几列开始」，写死 12 的话英文标签会把值挤歪。
 */
export function labelWidth() {
  return current === 'en' ? 14 : 12
}

/** 词条清单与完整性检查，测试用 */
export function dictStats() {
  const keys = Object.keys(DICT)
  const broken = keys.filter((k) => !Array.isArray(DICT[k]) || DICT[k].length !== 2 || DICT[k].some((s) => typeof s !== 'string' || !s))
  return { count: keys.length, keys, broken }
}

/** 只给测试和调试用：拿某条词条的两种语言 */
export function bothLangs(key) {
  const e = DICT[key]
  return e ? { zh: e[0], en: e[1] } : null
}
