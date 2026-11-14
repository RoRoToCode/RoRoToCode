# vramfit

**Before you download a model, take two seconds to see whether it will run on your machine.**

<sub>by [RoRoToCode](https://www.roroto.com) · MIT · the CLI and the web page share one estimator</sub>

[![CI](https://github.com/RoRoToCode/vramfit/actions/workflows/ci.yml/badge.svg)](https://github.com/RoRoToCode/vramfit/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/vramfit.svg)](https://www.npmjs.com/package/vramfit) [![npm downloads](https://img.shields.io/npm/dm/vramfit.svg)](https://www.npmjs.com/package/vramfit) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node](https://img.shields.io/badge/node-18%2B-brightgreen)

> **Try it online: <https://www.roroto.com/tools/vramfit/>**
> Nothing to install — paste a Hugging Face link or drop in a `.gguf` and read the answer. The model file never leaves your browser.
> Use the CLI for batch runs, scanning a folder, or reading real VRAM.

中文文档: [README.md](README.md)

It reads the few dozen KB of metadata in a GGUF header and works out three things against your GPU: **does it fit, how much context can you open, and roughly how many tokens per second**. Plus whether it can drive a coding agent.

No download, no writes to disk, no changes to your setup. A 15 GB file: only the first few dozen KB is read.

## Try it online

<https://www.roroto.com/tools/vramfit/>

- Paste an HF link or drop a local `.gguf` — instant report, the file stays in your browser
- Paste a model page and compare every quant in one table
- GPU looked up by model, already-used VRAM editable (default 0.8 GB)
- Turn a result into a shareable link

Three things the web version can't do: scan folders, read measured VRAM, or emit `--json` for CI. That's what the CLI is for.

`vram` here means whatever memory the model gets — discrete VRAM, Apple Silicon unified memory, or an iGPU's shared memory. Same arithmetic. On a Mac the report says "usable as VRAM 21.33 GB" instead of pretending there's a graphics card.

## Usage

Node 18+, pure JS, zero dependencies. No Node? On Windows: `winget install OpenJS.NodeJS.LTS`, or grab the LTS installer at <https://nodejs.org/>. Or just use the web version.

```bash
node --version                  # needs v18.0.0+
npm i -g vramfit                # gives you a `vramfit` command
# no install: npx vramfit model.gguf
```

Everything below uses `node check.mjs`; `vramfit` and `npx vramfit` take the same arguments, and running from a clone works too.

### 1. Interactive mode (easiest)

On Windows double-click `check.cmd`, or run `node check.mjs`. Paste a link, hit Enter:

```
  检查 > https://hf-mirror.com/unsloth/Qwen3-8B-GGUF
  检查 > D:\models\qwen3-8b-q4_k_m.gguf
  检查 > unsloth/Qwen3-8B-GGUF
  检查 > q
```

`Ctrl+V` or right-click to paste; several inputs at once work (space or newline separated). Zero-width characters, curly quotes and trailing periods copied from browsers, WeChat or Lark get cleaned automatically. If an old console or a security tool blocks pasting, type `paste` to read the clipboard directly.

Other commands: `help`, `cls`, `lang en`, `q`.

### 2. Drag and drop

Drop `.gguf` files (multi-select works) or their folder onto the `check.cmd` icon.

**Don't drop URLs containing `&`**: `cmd.exe` treats it as a command separator and splits the link. Paste into the window instead, or quote it:

```cmd
check.cmd "https://host/x.gguf?download=true&rev=1"
```

### 3. One command

```bash
node check.mjs model.gguf                       # one file
node check.mjs models/                          # recursive (6 levels, .gguf only)
node check.mjs models/*.gguf                    # batch
node check.mjs --json models/                   # machine-readable, CI-ready
node check.mjs --repo unsloth/Qwen3-8B-GGUF    # list and check every quant in a repo
```

**Checking a remote model needs no download** — only the header is read (about 10–25 MB):

```bash
node check.mjs https://hf-mirror.com/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
node check.mjs https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
```

| What you pass | What happens |
|---|---|
| `.gguf` direct link / local path / folder | check that file / scan the folder |
| Model page, `owner/repo`, `tree/main` | turned into a quant comparison |
| `blob` URL | rewritten to a `resolve` link |
| `huggingface.co` link | rewritten to a mirror, falls back to the official host |
| `hf-mirror.com` link | used as-is |

Recursive scanning matches LM Studio's `models/<publisher>/<repo>/x.gguf` layout — pass the top folder.

### Flags

| Flag | Purpose |
|---|---|
| `--json` | machine-readable array; an `error` field affects only that file |
| `--repo owner/name` | list every quant in an HF repo and check them remotely |
| `-i, --interactive` | kept for compatibility; no arguments already starts interactive mode |
| `--kv <type>` | KV cache precision: `f16` (default) / `q8_0` (halves it) / `q4_0` |
| `--vram 12` | pretend you have 12 GB (keeps GPU name and bandwidth) to price an upgrade |
| `--gpu N` | evaluate the Nth GPU; required on multi-GPU machines, no tensor parallelism |
| `--mirror <url>` | default `hf-mirror.com`; `https://huggingface.co` goes direct |
| `--lang zh\|en` | UI language, defaults to the system; `VRAMFIT_LANG` also works |
| `--no-color` / `--ascii` | colour off / ASCII glyphs, for redirects and old terminals |
| `--about` | print every parameter and assumption behind the report |
| `-v, --version` | version + repo URL |

A bad flag errors out with exit code 1 instead of quietly using a default; `--kv=q8_0` works too. Set `VRAMFIT_MIRROR` to change the host for good.

**Language**: follows the system locale, `--lang` pins it, and `lang en` / `en` / `cn` switch it live without clearing the screen. GGUF, KV cache, Q4_K_M, tok/s stay untranslated, and numbers aren't localised. `verdict` and friends in `--json` are stable identifiers that **don't follow the language** — same input, same bytes, any machine.

**Exit codes**: 1 if any file couldn't be read (or no quant in a repo could be), otherwise 0. With `--json` that drops straight into CI.

### Sample report

Real output, abridged: RTX 3050 (8 GB) checking a 7B Q4_K_M.

```
  GGUF fit report
  ═══════════════════════════════════════════════════════

  ✓ Ready as a coding agent
    32K context fits and the template supports tool calls
    ⚠ Static estimate only — load the model for a real answer

  Model     4.36 GB · qwen2 · 7.00B · Q4_K_M · native 128K
            28 layers · 28 heads / 4 KV heads (GQA)
  Hardware  RTX 3050 · CUDA · bandwidth 224 GB/s
            VRAM 8.00 GB total / 1.15 GB used / 6.85 GB free
  Budget    weights 4.36 GB + overhead 200 MiB → ceiling 7.52 GB

  Context      need       of ceiling
      4K     4.78 GB  █████████████░░░░░░░ ✓
     32K     6.31 GB  █████████████████░░░ ✓
     64K     8.06 GB  ████████████████████ ✗
    128K    11.56 GB  ████████████████████ ✗

  Recommended  32K (6.31 GB / ceiling 7.52 GB)
     native 128K is supported, VRAM runs out first
  Agent     template 2.5 KB · ✓ tools branch · ✓ tool_call format
            supported at template level; real runs decide reliability
  Speed     ~33 tok/s (224 GB/s ÷ 4.68 GB × 0.7)
```

The number that matters isn't "it runs" — it's **"native 128K, but this machine tops out at 32K"**. Every report ends with a parameters block; `--about` is the full version.

## How the web version relates

The web source lives in this repo's `site/` and is deployed at <https://www.roroto.com/tools/vramfit/>. At build time it **reads these directories straight from the repo root** — no copying, no rewriting:

| Directory | Contents | Used by |
|---|---|---|
| `core/` | GGUF parsing, KV estimate, VRAM budget, quant grading; pure computation, no IO | CLI + web |
| `net/` | HTTP Range reads + HF repo listing, `fetch` only | CLI + web |
| `cli/` | local hardware probing (`nvidia-smi` / `rocm-smi` / `sysctl`) | CLI only |

Same metadata in, same numbers out on both sides; only the hardware input and the presentation differ.

Two constraints: `site/` must be a direct child of the repo root or `node site/build.mjs` can't find `core/`; and `core/` / `net/` must not import `node:` modules, because the browser imports them directly (tests and CI enforce it). The npm package has no `site/` — CLI users don't download a web app.

| | Web | CLI |
|---|---|---|
| Install | none | Node 18+ |
| Link / dropped file | ✅ file stays in the browser | ✅ |
| Folder scan, batch, `--json` | ❌ | ✅ |
| VRAM / used | look-up (editable) | measured |
| Share a result | one link | screenshot |

## Speed estimate (tok/s)

One token reads the entire weight set from memory, so the bottleneck is **bandwidth**, not compute. One formula:

```
tok/s ≈ bandwidth(GB/s) × efficiency ÷ weight size(GB)
```

Calibrated on an RTX 2080 (448 GB/s) with a 9B Q4_K_M (5.78 GB): `448 × 0.7 ÷ 5.78 = 54.3`, **measured 53.9**. That's where 0.7 comes from. All four tiers were actually loaded with llama.cpp on that machine:

| Context | Predicted | Measured VRAM | Error | Measured speed |
|---|---|---|---|---|
| 8K | 5969 MiB | 5875 MiB | +1.6% | 52.7 tok/s |
| 16K | 6226 MiB | 6119 MiB | +1.7% | 51.1 tok/s |
| 32K | 6738 MiB | 6676 MiB | +0.9% | 53.9 tok/s |
| 64K | 7762 MiB | 7737 MiB | +0.3% | 57.1 tok/s |

Predictions run slightly high (conservative), all within 2%. 64K is marked ✗ on purpose: it did load, but with 251 MiB left — one browser tab and you're OOM. It recommends what you can safely use, not the largest thing that barely fits.

A few trade-offs:

- **Weights don't fit** → it switches to RAM bandwidth (~60 GB/s), so you'll see `~6 tok/s`. That's what partial offload feels like.
- **Under 2 GB of weights it only gives a ceiling**: a 0.6B Q4 computes to 395 on a 3050 but measures 70–120. Kernel launches, sampling and transfers dominate; the formula is meaningless there.
- **MoE reads low**: total size is used, but only some experts activate, so real speed is higher. The report says so.
- **GPUs outside the built-in table get no speed number** rather than a guess.

Don't confuse two `--json` fields: `genTokPerSec` is the theoretical peak at zero context, batch=1; `genTokPerSecAtCtx` is that value after KV read cost at the recommended context. Neither is measured, neither includes first-token latency or tool execution; `speedBasis` records the rule used.

In one line: **VRAM decides how many tokens of context fit, bandwidth decides how many tokens per second come out.**

## Reading the result

| Field | Meaning |
|---|---|
| `verdict` | `agent-ready` / `runs-only` / `not-recommended` / `unknown` (incomplete metadata, not "won't run") |
| `recommendedCtx` | largest tier that fits within the native context; `null` means none, `tiers[]` shows each boundary |
| `budget.limitBytes` / `basis` | the ceiling and which rule produced it |
| `gpu` / `cpuOnly` | detected GPU, and whether it fell back to CPU |
| `tools` | `strong/partial/weak/none`, a template string feature, not a measured capability |

## Supported

| Platform | VRAM from | Ceiling |
|---|---|---|
| Windows | `nvidia-smi` / `rocm-smi`, registry fallback | `max(free×0.92, total×0.94)`, WDDM can evict |
| Linux | `nvidia-smi` / `rocm-smi`, `/sys/class/drm` fallback | free × 0.92, not evictable |
| macOS | `sysctl hw.memsize`, Metal working set | working set × 0.9 |
| No dGPU | physical RAM | × 0.8, CPU inference |

iGPUs count as half of shared memory and are skipped when a discrete GPU exists. The report states which rule was used.

| Format | Status |
|---|---|
| **GGUF** | supported: shards as `first × count`, `mmproj` skipped, quant and template read from metadata |
| safetensors / MLX | not supported: a bf16 file isn't what you'd actually run. It says so instead of guessing |

## How the numbers are derived

All constants live in [`core/assumptions.mjs`](core/assumptions.mjs) — the report footer, `--about` and the web panel read that one file.

| Part | Formula |
|---|---|
| Weights | file bytes, shards scaled by count |
| KV cache | `ctx × layers × n_kv_head × (k+v) × bytes per element`; f16=2 B, q8_0=1.0625 B, q4_0=0.5625 B |
| Runtime overhead | fixed 200 MiB |
| Speed | `bandwidth × 0.7 ÷ weightGB`, ±15% |
| Thresholds | need > ceiling×0.85 → "close"; < 3B → runs only; < 8K → too short; 1–2 bit → "avoid" (empirical) |

Hybrid linear attention (Qwen3-Next et al), sliding-window attention (Gemma 3/4), MTP layers, sharding and the native context boundary are handled automatically, and the report distinguishes what was read from what was inferred. One GPU only, no tensor parallelism.

## Disclaimer

**Every number is computed, not measured.** It doesn't load models, run inference, benchmark throughput or measure first-token latency — it reads GGUF header metadata and does arithmetic against a hardware spec table.

So:

- VRAM predictions were calibrated on real hardware (within 2%), but that was four tiers on one RTX 2080. Other platforms and architectures will drift.
- Speed is estimated from bandwidth, ±15%; small models and large MoE drift further.
- `agent-ready` only means "it fits and the template has a tools branch" — **not that the model reliably calls tools**. `unknown` means metadata was incomplete, **not that it won't run**.
- Results are a reference, not a promise about performance, compatibility or what to buy. The real answer is loading the model once on your machine.

**License-wise**: MIT, provided "as is", without warranty of any kind. If you buy hardware on its advice and the model still won't run, that's not on the authors (see [`LICENSE`](LICENSE)).

## FAQ

- **No discrete GPU?** Works, using 80% of RAM and memory bandwidth; the report says "CPU inference". Too slow for an agent, but fit and template conclusions still hold.
- **AMD / Intel?** VRAM comes from the registry, so capacity is usable; llama.cpp goes through Vulkan/ROCm, so real free VRAM and speed differ, and the backend is labeled Vulkan.
- **Why is the recommended context so much smaller than advertised?** KV cache grows with context: 64K on a 9B needs over 4 GB of KV alone, which an 8 GB card can't hold. "256K supported" usually assumes 24 GB+.
- **Paste does nothing / dropped URL fails?** The old raw-mode bug is fixed (cooked mode keeps `ENABLE_QUICK_EDIT_MODE`). If it still fails, type `paste`; quote URLs with `&` or paste them into the window.
- **"Not recognized as a link or file"?** Only `huggingface.co` / `hf-mirror.com` / `hf-mirror.net` are accepted. Zero-width characters, curly quotes and `&amp;` are cleaned; otherwise look for stray text or spaces in the link.
- **"Network unreachable / no file size"?** Either it isn't a `.gguf` direct link (use a direct link or the model page), or the mirror is rate-limiting (wait 1–2 minutes; it retries and falls back).
- **Sharded models?** Point at the first shard; size is scaled by count. Later shards have no metadata and will tell you to go back.
- **A 0.6B passes everything but is still rejected as an agent?** Hard threshold: under 3B is "runs, but too small". Not a capability benchmark — it just rules out what obviously can't work.

## Feedback and license

| Case | Where |
|---|---|
| Wrong result / crash / unrecognized model | [GitHub Issues](https://github.com/RoRoToCode/vramfit/issues) |
| Security / commercial use | <su@roroto.com> (please don't file a security issue) |
| Want to contribute | [CONTRIBUTING.md](CONTRIBUTING.md) |

Include three things: the model link, your GPU and VRAM, and the output of `node check.mjs --about`.

If it saved you a wasted download, give the repo a **star** ⭐.

**MIT**: commercial use, closed source, renaming, bundling into your own product — all fine, no obligation to publish anything. But when you copy code or redistribute, keep [`LICENSE`](LICENSE) and say "based on vramfit"; don't call it an official build. When citing results, credit "data from vramfit" with a link — the repo's **Cite** button generates BibTeX / APA from [CITATION.cff](CITATION.cff).
