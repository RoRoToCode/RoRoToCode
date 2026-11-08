# vramfit

**Before you download a model, take two seconds to see whether it will run on your machine.**

<sub>by [RoRoToCode](https://www.roroto.com) · MIT · the CLI and the web page share one estimator</sub>

> **Try it online**: <https://www.roroto.com/tools/vramfit/> — nothing to install, paste a link and read
> the answer. The model file never leaves your browser. Use the CLI below for batch runs and
> scanning a local folder.

Drop in a `.gguf` file, or paste a Hugging Face link. It reads the few dozen KB of metadata
in the file header (layer count, attention heads, quantisation, chat template), works it out
against your GPU, and tells you:

- whether it fits, and how much context you can open
- roughly how many tokens per second you'll get
- whether it can drive a coding agent as-is

No download, no writes to disk, no changes to your setup. For a 15 GB file it reads the first few dozen KB.

```bash
npx vramfit unsloth/Qwen3-8B-GGUF
```

(Cloned instead? `node check.mjs ...` takes the same arguments.)

Run it with `--lang en` for an English report (the default follows your system locale).
The first two lines are the whole answer:

```
  ═══════════════════════════════════════════════════════
  GGUF 体检报告
  ═══════════════════════════════════════════════════════

  ✓ 可以当 coding agent 用
    32K 上下文装得下，模板也能驱动工具调用

    ⚠ 静态推算，仅供参考，请以实际加载运行为准
```

## What it deliberately does not do

- **It is not a downloader.** Check first, download later — it won't eat your bandwidth.
- **It is not a benchmark.** Speed is estimated from memory bandwidth, not measured; being 20–30% off is normal.
- **It does not decide for you.** It rules out what definitely won't run; picking between the rest is your call.
- **Every conclusion is a reference.** The real answer only arrives after you load the model once.
- **It reads GGUF only, for now.** safetensors / MLX are not supported — it says so instead of
  inventing a number. See "Format support" below.

**About the name**: `vram` here means "whatever memory the model gets to use" — discrete VRAM,
Apple Silicon unified memory, or an iGPU's shared memory. The arithmetic is the same. On a Mac
the report says "usable as VRAM 21.33 GB" rather than pretending it has a graphics card.

**This is a command-line tool**, Node 18+, no dependencies.
On Windows, double-click `check.cmd` — no flags to remember.

**No Node?** Use the web version: <https://www.roroto.com/tools/vramfit/> — paste a link and get an answer,
your file never leaves the browser. Its source lives in `site/` in this same repo and reuses
`core/` and `net/` from the root; it is not part of the npm package.

中文文档: [README.md](README.md)

## Quick start

### First, check that you have Node

This is plain JavaScript — **Node.js 18+ is required**, there is no other way to run it:

```bash
node --version        # v18.0.0 or newer
```

On Windows, one line installs it:

```bash
winget install OpenJS.NodeJS.LTS
```

Otherwise grab the LTS installer from <https://nodejs.org/>. An older Node exits on
startup with an upgrade message, rather than failing mid-run on `fetch is not defined`.

**Don't want to install anything?** Use the web version: <https://www.roroto.com/tools/vramfit/>.
You lose directory scanning, real VRAM readings and `--json`.

### 0. Install it as a command (optional)

```bash
npm i -g vramfit      # then just: vramfit <link-or-file>
```

Installing is optional — cloning the repo and running the entry file with Node works
exactly the same, the command is just longer. The examples below use `vramfit`.

### 1. Interactive mode (easiest)

On Windows, **double-click `check.cmd`**, then paste a link or a path at the prompt:

```
  检查 > https://hf-mirror.com/unsloth/Qwen3-8B-GGUF
  检查 > D:\models\qwen3-8b-q4_k_m.gguf
  检查 > unsloth/Qwen3-8B-GGUF
  检查 > q
```

(With `--lang en` the prompt reads `check >` instead.)

Paste with **`Ctrl+V` or right-click** (the default in a Windows console). You can paste several targets at once, separated by spaces or newlines. Invisible junk that comes with links copied from a browser address bar — zero-width spaces, curly quotes, trailing punctuation — is stripped automatically.

If a particular window refuses to paste at all (old conhost, security software hooking the keyboard), type `paste` and hit Enter: it reads the clipboard directly, bypassing the terminal.

Command-line equivalent:

```bash
node check.mjs
```

With no arguments the tool always enters interactive mode, whether it was double-clicked, run from a terminal, or fed through a pipe.

| You paste | What happens |
|---|---|
| A `.gguf` direct link | Checks that one file |
| A model page (`/owner/repo`) | Switches to quant comparison and lists every variant |
| A `blob` page URL | Rewritten to the `resolve` direct link |
| A local `.gguf` path or folder | Checks it, or recursively scans the folder |
| `owner/repo` | Same as a model page |

Commands: `help`, `cls` (clear), `q` (quit).

### 2. Drag and drop

Drag `.gguf` files (multiple selection works) or their parent folder onto `check.cmd`.

**Links cannot be dragged this way**, and it has nothing to do with the link itself: `cmd.exe` treats `&` as a command separator, so `https://host/x.gguf?a=1&b=2` gets cut at the `&` and the remainder is executed as a separate command. For links containing `&`, double-click `check.cmd` and paste, or quote the whole thing:

```cmd
check.cmd "https://host/x.gguf?download=true&rev=1"
```

### 3. One command

```bash
node check.mjs model.gguf
node check.mjs models/              # recursively scan a folder for .gguf files
node check.mjs models/*.gguf        # batch
node check.mjs --json models/       # machine readable, good for CI
```

**No download required** — point it at a URL and it reads only the file header (roughly 10–25 MB), never the whole model:

```bash
node check.mjs https://hf-mirror.com/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
node check.mjs https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf
```

Both `huggingface.co` and `hf-mirror.com` are recognised:

- `huggingface.co` links are rewritten to the China-friendly mirror, with a fallback to the official host
- `hf-mirror.com` links are used as-is
- Model page links become a quant comparison automatically — no need to hand-build a `resolve/main/xxx.gguf` URL

**Compare every quant in a repo** and get a straight answer to "which one should I download":

```bash
node check.mjs --repo unsloth/Qwen3-8B-GGUF
node check.mjs https://hf-mirror.com/unsloth/Qwen3-8B-GGUF    # same thing
```

| Flag | Effect |
|---|---|
| `--repo owner/name` | List every quant in a HF repo and check each one remotely |
| `-i, --interactive` | Kept for compatibility; no arguments already enters interactive mode |
| `--kv <type>` | KV cache precision: `f16` (default) / `q8_0` / `q4_0` |
| `--vram 12` | Assume 12 GB of VRAM while keeping the detected card name and bandwidth (useful for "what if I upgrade") |
| `--mirror <url>` | Switch model host. Default `hf-mirror.com`; pass `https://huggingface.co` to go direct |
| `--json` | Machine-readable output |
| `--no-color` | Disable colors (auto-off when redirected) |

Invalid values used to fall back silently; they now fail loudly with exit code 1. `--kv=q8_0` and other `=` forms work too.

**Exit code**: 1 when any file can't be read (or every variant in a repo fails), 0 otherwise. Combined with `--json` this is CI-friendly.

## Language

The interface follows your system locale. Pin one explicitly with `--lang`:

```bash
vramfit --lang zh model.gguf     # Chinese
vramfit --lang en model.gguf     # English
```

```bash
VRAMFIT_LANG=en vramfit model.gguf     # once per shell session
```

**Switch mid-session.** No need to quit — type it at the `check >` prompt:

```text
check > lang            -> shows the current language and the syntax
check > lang zh         -> switches to Chinese immediately (prompt becomes 检查 >)
check > lang en         -> back to English
check > zh  /  cn  /  -en   -> also works; two letters is enough
```

Switching prints one line and **does not clear the screen**. When you type `lang`, the
report you just ran is usually still on screen — wiping it to change a word would punish
you for the wrong thing. Clearing is what `cls` is for. The prompt itself turns into
`check >`, which is confirmation enough. `lang` accepts `zh` / `en` plus `cn`, `中文`,
`english` and so on; anything else leaves the language alone and says so.

On the command line `--lang` is strict — only `zh*` / `en*`. A script with a typo should
fail loudly, not silently pick a language it guessed. The interactive prompt is for
humans, so it is lenient.

**No side-by-side bilingual output.** The report is laid out on a grid with a fixed label
column; printing "文件 File" doubles its width, pushes every value past column 20, and narrow
terminals wrap the table into confetti. One language at a time, chosen by you.

The boundaries:

- **Terms stay untranslated.** GGUF, KV cache, Q4_K_M, tok/s, Metal.
- **Numbers and units are not localised.** Always `12.34 GB`, no GB / GiB split.
- **`--json` ignores `--lang`.** `verdict` values (`agent-ready` etc.) are stable identifiers;
  translating them would break every downstream script. Same input, byte-identical output.
- **`--ascii`** swaps `✓ △ ✗ █ ░ ═` for `+ ~ x # - =` for old consoles and log files.

The web page ships in Chinese and English, following the language of the page itself:
interface copy lives in `site/src/web/strings.mjs`, the verdict text in `core/i18n.mjs`,
and both read the same decision from the page's `<html lang>`. Spanish is not done yet.

## Platform support

Works on Windows, Linux and macOS — but "how much VRAM is available" is a different question on each:

| Platform | Where the number comes from | How the ceiling is computed |
|---|---|---|
| Windows + NVIDIA | `nvidia-smi`, registry as fallback | total x 94% (WDDM can evict other processes) |
| Windows + AMD | `rocm-smi`, registry as fallback | same |
| Linux + NVIDIA | `nvidia-smi` | **free x 92%** (VRAM can't be evicted) |
| Linux + AMD | `rocm-smi`, then `/sys/class/drm/*/mem_info_vram_*` (no ROCm install needed) | same |
| macOS (Apple Silicon) | `sysctl hw.memsize`, Metal recommended working set | working set x 90% (unified memory, shared with the OS) |
| Nothing detected / no driver | falls back to CPU inference | physical RAM x 80% |

Integrated GPUs are estimated at half the shared RAM and are never picked while a discrete card is present. The budget line in the report states which rule was used.

## Format support

| Format | Status | Notes |
|---|---|---|
| **GGUF** | supported | including shards (first shard x count), `mmproj` vision projectors skipped, quant level and chat template read from metadata |
| safetensors | not yet | hyper-parameters live in `config.json`, not in the weights — and the size only means something after choosing a target quant |
| MLX | not yet | safetensors plus `quantization.bits` in `config.json` |

The last two aren't hard to parse; the **accounting is different**. A GGUF file's size is what
it occupies when running. A safetensors file is the bf16 original, so the honest answer is
"15.2 GB bf16 → about 4.6 GB as Q4_K_M", and that mapping has to be right before the numbers
mean anything. Putting that off beats printing a precise number that answers the wrong question.

Anything else you paste is rejected with "this link is not a .gguf file" rather than guessed at.

## Why it is worth checking first

Failures with small local models driving a coding agent almost all look the same: **the model runs, but the agent can't use it.**

- No `chat_template` → a Q&A prompt turns into "keep writing the document"
- A template without a `tools` branch → Claude Code / Cline sends tool definitions and the model has no idea what they are
- "256K context" on the box, but 32K is the most an 8 GB card can hold
- It finally loads, then KV cache eats all the VRAM and your desktop starts stuttering

None of this is visible before downloading. `vramfit` reads a few dozen KB of metadata and tells you, instead of waiting for a 5 GB download to fail.

## Sample report

Real run: a 7B Q4_K_M model on an RTX 3050 (8 GB), with `--lang en`.

```
  ═══════════════════════════════════════════════════════
  GGUF check report
  ═══════════════════════════════════════════════════════

  ✓ Good to go as a coding agent
    32K of context fits, and the template can drive tool calls
    ⚠ Static estimate only — load the model once to be certain

  Model
    File          qwen2.5-coder-7b-instruct-q4_k_m.gguf
    Size          4.36 GB (339 tensors)
    Arch          qwen2 · 7.00B params
    Quant         Q4_K_M
    Native ctx    128K tokens
    Structure     28 layers · 28 heads / 4 KV heads · hidden 3584 (GQA, saves VRAM)

  Hardware
    GPU           NVIDIA GeForce RTX 3050
                  CUDA · driver 581.80 · 224 GB/s bandwidth
    VRAM          8.00 GB total · 1.17 GB used · 6.83 GB free
                  ████░░░░░░░░░░░░░░░░░░░░  15% used
    RAM           15.80 GB
    CPU           12th Gen Intel(R) Core(TM) i7-12700

  VRAM budget
    Weights       4.36 GB
    Overhead      200 MiB (inference context + compute buffers)
    Ceiling       7.52 GB
                  0.69 GB of it needs other VRAM-hungry apps closed

     Context       Needs  of ceiling
          4K     4.77 GB  █████████████░░░░░░░ ✓
          8K     4.99 GB  █████████████░░░░░░░ ✓
         16K     5.43 GB  ██████████████░░░░░░ ✓
         32K     6.31 GB  █████████████████░░░ ✓
         64K     8.06 GB  ████████████████████ ✗
        128K    11.56 GB  ████████████████████ ✗

    Suggested ctx 32K (6.31 GB / ceiling 7.52 GB)
      Native context is 128K, so you could go higher — but VRAM will not stretch

  Agent readiness
    Chat template 0.4 KB
                  ✓ Template has a tools branch; tool definitions can be injected
                  ✓ Template defines a tool-call output format (tool_call)
    Tool use      Directly drivable (template-level support)
                  whether it calls tools reliably still needs one real run

  Estimated speed
    All in VRAM   ≈ 33 tok/s
                  Every token re-reads all the weights, so bandwidth is the bottleneck; ±15% error

  ── Parameters & assumptions ───────────────────────────
    Weights       File size
    Overhead      fixed 200 MiB
    KV            ctx × layers × n_kv_head × (k+v) × 2 B per element
    Ceiling       Windows WDDM: max(free×0.92, total×0.94)
    Speed         bandwidth × 0.7 ÷ weight GB, ±15%
    Thresholds    need > ceiling×0.85 = "near"; < 3.00B = "runs only"; < 8K = "too short"
    Full list     --about
```

The rest is the same shape every time: a context table (4K … 128K, showing how much of the
budget each one takes), then the template / tool-call check and the speed estimate.
Full output: [README.md](README.md#报告长什么样).

The number that matters is not "it fits" but **"128K native, 32K is all you get"**.

## Calibration

The VRAM model was calibrated against llama.cpp on real hardware (RTX 2080 8 GB, `Ornith-1.5-9B-Q4_K_M`, `-ngl 99`), with all four tiers actually served and timed:

| Context | Predicted | Measured VRAM | Error | Measured speed |
|---|---|---|---|---|
| 8K | 5969 MiB | 5875 MiB | +1.6% | 52.7 tok/s |
| 16K | 6226 MiB | 6119 MiB | +1.7% | 51.1 tok/s |
| 32K | 6738 MiB | 6676 MiB | +0.9% | 53.9 tok/s |
| 64K | 7762 MiB | 7737 MiB | +0.3% | 57.1 tok/s |

Predictions always land slightly above the measurement — conservative on purpose — and every one is within 2%.

**64K is marked ✗ deliberately.** It does run (7737 MiB), but with 251 MiB to spare, opening a browser OOMs it. The tool recommends what you can comfortably use, not the largest thing that barely fits.

## Read vs computed

The report keeps these apart and never blurs them:

| Item | Source | Confidence |
|---|---|---|
| Architecture, params, quant, layers, heads, native context | GGUF metadata | **Measured** |
| Whether `chat_template` exists and has a `tools` branch | Raw template string | **Measured** |
| Weight VRAM | File size (sharded: first shard x count) | **Measured** (weights dominate a GGUF) |
| Whether 4K–256K fits | layers x KV heads x head_dim x dtype | **Computed**, <2% error against real hardware |
| Hybrid linear attention interval | `full_attention_interval`, or inferred 1/4 from `ssm.*` when absent | **Inferred**, flagged in the report |
| Sliding-window layer split | llama.cpp architecture rules (gemma3: 1 global per 6) | **Inferred**, ±25% |
| Generation speed | bandwidth / weights x efficiency | **Computed**, ~1% error above 2 GB; smaller models get a ceiling only |
| Memory bandwidth | built-in GPU table matched by name | **Static data** — no table entry, no speed number |
| Quant quality tier (avoid / marginal / recommended) | field experience, not math | **Judgement**, thresholds tuned for agents |
| Whether tool calling actually works | template only | **Inferred** — must be verified by running |
| Whether the model is big enough for an agent | one hard gate: under 3B is rejected | **Judgement** |

## Speed estimate

Each generated token re-reads every weight, so the bottleneck is **memory bandwidth**, not compute. One line:

```
tok/s ≈ bandwidth (GB/s) × efficiency ÷ weights (GB)
```

Calibrated on RTX 2080 (448 GB/s) with a 9B Q4_K_M (5.78 GB): `448 × 0.7 ÷ 5.78 = 54.3`, **measured 53.9**. That's where the 0.7 efficiency comes from.

Deliberate choices:

- **If the weights don't fit, bandwidth switches to system RAM** (~60 GB/s), so you'll see "~6 tok/s" — that's real, partial offload feels exactly like that.
- **Models under 2 GB get a 200 tok/s ceiling instead of a number.** The formula would claim 395 for a 0.6B Q4 on an RTX 3050 while the real figure is 70–120: kernel launch, sampling and transfer are fixed per-token costs that no formula captures.
- **MoE models are underestimated.** The formula uses total size while only some experts activate; the report flags this.
- **No speed number when the GPU isn't in the table**, rather than inventing one.

## Architecture quirks handled automatically

- **Hybrid linear attention** (Mamba / Gated DeltaNet, e.g. qwen3next / Qwen3-Next): only 1 in N layers carries KV. The tool reads `full_attention_interval`; **when the metadata omits it (Qwen3-Next does), it falls back to the presence of `ssm.*` keys** and assumes 3 linear + 1 full layer, flagged as *inferred*. Skipping this overestimates KV by 4x.
- **Sliding window** (`sliding_window`, e.g. Gemma 3/4): windowed layers only keep recent tokens. Any `sliding_window` triggers the windowed branch, using `key_length` as head_dim when `key_length_swa` is absent. Relying on `key_length_swa` alone meant Gemma 3 never hit the branch and 128K was computed as 19 GB instead of 5.6 GB.
- **MTP layers** (`nextn_predict_layers`): ignored by llama.cpp, excluded from the layer count.
- **Sharded models** (`…-00001-of-00004.gguf`): weights are scaled as *first shard x count*; pointing at a later shard tells you to use shard 1 instead.
- **Native context is a hard boundary**: tiers beyond it are flagged ⚠ and excluded from the suggestion — RoPE extension looks fine in short chats and falls apart on long tasks.

Two known biases are printed in the report: sliding-window layer allocation is inferred from architecture rules (±25%), and on Windows the ceiling includes evictable VRAM (closing LM Studio or a browser frees it) — on Linux and macOS it does not, and the wording follows the platform.

## Tests

57 cases here, **no network, no GPU**:

```bash
npm test        # same as: node --test test.mjs
```

- Pure functions: hybrid interval inference, sliding-window KV, sharded weight scaling, quant-name suffix truncation, template grading, the three platform ceiling rules, argument parsing (including `--kv=`), terminal escape stripping.
- Parser: a synthetic GGUF is assembled byte by byte (header + kv section + `chat_template` array + per-layer KV-head array) and fed through the real `readGguf` — covering truncation, bad magic and array skipping.
- Remote: a local HTTP server serves the same file twice, once honouring Range (206) and once ignoring it (200). The first must read only the header, the second must fail immediately instead of pulling the whole file into memory.
- Report: incomplete metadata says "cannot be estimated" rather than "won't fit"; `--json` never reports `0 tok/s` for CPU inference.
- Verdict: all four outcomes (usable as an agent / chat only / won't run / cannot be estimated) must explain themselves, with no empty text and no `undefined`.
- Host switching: `--mirror` pointed at the official host must stop rewriting links; empty or non-http values fall back safely.
- Parameter consistency: the 200 MiB / 0.92 / 0.94 / 0.85 figures printed in the report must match the constants in `core/assumptions.mjs` — split them in two and they will drift.
- Architecture: `node:` imports in `core/` or `net/` fail the build (the web build imports both layers directly).

The web build has its own 22 cases (rendering, GPU lookup, stale `dist/`) in `site/`:

```bash
cd site && npm test          # build, then node --test test.mjs
```

## Disclaimer and parameters

**Every number here is a static estimate, not a measurement.** The tool never loads a
model, never runs inference and never benchmarks throughput. It reads the GGUF header
and does arithmetic against your hardware spec. It rules out what definitely won't
work; it does not certify what will.

All constants live in [`core/assumptions.mjs`](core/assumptions.mjs). The CLI report,
`--about`, the collapsible panel on the web page and the table below are all rendered
from that one file, so they cannot disagree.

| Step | How it is computed | Caveats |
|---|---|---|
| **Weights** | file size on disk | Sharded models: first shard × shard count; includes embedding / lm_head |
| **KV cache** | `ctx × layers × n_kv_head × (k_dim + v_dim) × bytes per element` | f16 = 2 B, q8_0 = 1.0625 B, q4_0 = 0.5625 B (the latter two carry per-block scales) |
| **Hybrid linear layers** | only 1/N layers hold KV | N from `full_attention_interval`; falls back to inferring 4 from `ssm.*`, and the report says so |
| **Sliding window** | full layers use ctx, the rest keep one window | layer split is inferred from architecture rules — **±25%** |
| **Runtime overhead** | fixed 200 MiB | batch + compute buffers; measured ~80 MiB on RTX 2080 + 9B Q4_K_M |
| **Ceiling (Windows)** | `max(free × 0.92, total × 0.94)` | WDDM can evict other processes |
| **Ceiling (Linux)** | `free × 0.92` | VRAM is not evictable |
| **Ceiling (macOS)** | Metal working set × 0.9 | falls back to 75% of physical RAM |
| **No dGPU** | physical RAM × 0.8 | CPU inference |
| **Speed** | `bandwidth × 0.7 ÷ GB of weights` | **±15%**, excludes time-to-first-token; below 2 GB the fixed per-token cost dominates, capped at 400 tok/s |
| **MoE** | activation ratio not modelled | real speed is **higher** than the estimate |

Thresholds: over 85% of the ceiling is marked "close"; under 3B parameters counts as
"runs but no agent"; under 8K context is "too short"; 1–2 bit quants are "avoid"
(an empirical grade, not a measurement).

Explicitly out of scope: real throughput, time-to-first-token, concurrency,
actual VRAM usage (browsers don't expose it), multi-GPU splitting, and any claim that
a `tools` branch in the template means the model will reliably call tools.

## What it does not do

- **It does not download models.** Local files: header only. Remote URLs: HTTP Range on the few segments it needs (usually 10–25 MB), never the full 5 GB. Nothing is uploaded, no account, no telemetry.
- **It does not manage models.** No server, no switching, no ports. That's Ollama / LM Studio / llama-swap territory.
- **It does not replace a real run.** A `tools` branch in the template doesn't prove the model can use tools.
- **It does not judge how smart a model is.** IQ1 is marked "avoid" because low-bit quantisation output is unstable, not because the model is weak. The one exception is the hard "under 3B = too small for an agent" gate, which only filters obviously hopeless options.

## FAQ

**Q: No discrete GPU?**
It estimates CPU inference instead: physical RAM (80%), speed from memory bandwidth, and the report says "CPU inference". That's usually too slow for an agent, but "does it fit" and "does the template support tools" are still answered.

**Q: AMD / Intel GPUs?**
AMD is read via `rocm-smi`, or from `/sys/class/drm` on Linux (no ROCm install needed); Intel/AMD integrated GPUs are estimated at half the shared RAM. The backend is labelled (ROCm / Vulkan / Metal), and bandwidth only appears if the model is in the built-in table.

**Q: Why is the suggested context so much smaller than advertised?**
KV cache grows with context. A 9B pure-attention model at 64K needs 4 GB+ of KV alone, which an 8 GB card can't hold. The advertised "256K" assumes a 24 GB+ card.

**Q: Does it conflict with my model manager?**
No, it only reads. But if LM Studio or Ollama is holding a few GB, the report will show it — close them and re-run for a higher available number.

**Q: Mojibake when redirecting output in PowerShell?**
PowerShell 5.1 decodes as GBK by default. Run `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` first.

**Q: Ctrl+V / right-click does nothing after double-clicking `check.cmd`?**
Fixed. Interactive mode used Node's `readline` in raw mode, and on Windows raw mode rewrites the console input mode to `ENABLE_WINDOW_INPUT|ENABLE_VIRTUAL_TERMINAL_INPUT` (measured: `0x0208`), which clears `ENABLE_QUICK_EDIT_MODE` — the flag conhost's paste depends on. Result: a classic console window that refused every paste (Windows Terminal was unaffected, since the terminal handles paste itself). Windows now uses cooked mode, letting the console do the echoing and pasting; `ENABLE_QUICK_EDIT_MODE` stays on.

If you're on an older build, or a window still won't paste, type `paste` and press Enter to read the clipboard directly.

**Q: "Not recognised as a link or a file" when pasting a URL?**
Three things to check:
- Only `huggingface.co`, `hf-mirror.com` and `hf-mirror.net` are supported. ModelScope, GitHub and cloud-drive links are rejected with an explicit message.
- Zero-width characters, curly quotes, trailing full-width punctuation and `&amp;` are stripped automatically. If it still fails, look for stray Chinese text or spaces inside the link.
- If the message is "network unreachable / request timed out" instead, the link *was* recognised — the mirror is just down. Wait a minute and retry.

**Q: Dragging a URL onto `check.cmd` does nothing, or errors with "xxx is not recognized as an internal or external command"?**
`cmd.exe` splits the link at `&`. Double-click `check.cmd` and paste, or quote the link.

**Q: Can it check models on hf-mirror.com?**
Yes, paste the link unchanged.

| Pasted URL | Handling |
|---|---|
| `.../resolve/main/xxx.gguf` | Checks that file |
| `.../blob/main/xxx.gguf` | Rewritten to the `resolve` link |
| `.../owner/repo` (model page) | Lists every quant in one comparison table |
| `.../tree/main` and similar | Same, treated as a repo |
| `owner/repo` | Same |

HTML pages can't be checked (they return a web page, not a model), so the tool converts page links into usable ones instead of failing.

**Q: "Network unreachable" or "can't get file size"?**
Two different causes, reported separately:
- **Not a direct file link** (a README, a safetensors file) → use a `.gguf` direct link or the model page
- **Mirror unreachable** → hf-mirror rate-limits per egress IP; wait 1–2 minutes. The tool retries, falls back to the official host, and shrinks its read block size on slow links before giving up.

**Q: Why does a remote check sometimes take tens of seconds?**
Only the header is read, but GGUF metadata sits after the vocabulary — a Qwen-style model with 150k+ tokens needs 10–25 MB before `chat_template` appears. Seconds on a healthy mirror, much longer when throttled.

**Q: "Has a template but no tool support" vs "no template"?**
Completely different problems. **No template** means the model ships no chat format (it degenerates into "keep writing"). **No tool support** means the template exists but has no `tools` branch — you can chat, but the agent can't inject tool definitions. The former is basically unusable; the latter can sometimes be worked around with `--chat-template` or a text-based tool protocol.

## Limits worth knowing

- Speed assumes dense models; MoE numbers are conservative.
- Windows VRAM "ceiling" includes evictable memory, so numbers can look optimistic while a browser is open. Linux and macOS ceilings use free memory only, so they're stricter — that's intentional.
- Reading a remote file needs a mirror that responds; when hf-mirror throttles, download the `.gguf` and check it locally.

## Feedback and contact

| What | Where |
|---|---|
| Wrong numbers, crashes, a model it cannot recognise | [GitHub Issues](https://github.com/RoRoToCode/vramfit/issues) |
| Security issues | Email <su@roroto.com>, please do not open an issue |
| Commercial use, collaboration, redistribution licensing | <su@roroto.com> |
| You want to change the code yourself | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

Issues first: they are public and searchable, so the next person hitting the same
problem finds the answer without asking again.

Three things in a report save most of the back-and-forth:

1. The model name or HuggingFace link
2. Your GPU and its VRAM (what `nvidia-smi` shows, or the value you passed to `--vram`)
3. The output of `node check.mjs --about` — it lists the assumptions actually applied

## License

**MIT.** Commercial use, closed-source forks, rebranding, bundling into your own product
(a VS Code extension, an LM Studio plugin, an internal tool, a paid service) — all fine.
You do **not** have to open-source anything of yours.

What you have to do depends on how you use it:

| How you use it | Attribution | What to do |
|---|---|---|
| Install it, screenshot a result | not required | a link is nice, not mandatory |
| Quote a verdict in an article / course / report | **not required, but please credit** | one line — "data from vramfit" — plus a link. The **Cite** button on the GitHub repo generates BibTeX from [`CITATION.cff`](CITATION.cff) |
| Copy code into your product | **required** | keep the copyright and permission notice: ship the [`LICENSE`](LICENSE) text, or list `vramfit — MIT — https://github.com/RoRoToCode/vramfit` in your third-party notices |
| Ship a plugin / fork / rebranded build | **required, and no impersonation** | as above, plus "based on vramfit" — don't call it the official build |

Embedding only `core/` (or `core/` + `net/`) is the same deal: those directories stand alone
and don't need `cli/` or `check.mjs`.

Two things that are not license terms but I'd ask for:

- **Don't imply endorsement.** Calling a re-skinned fork "official vramfit" will make
  people think it came from here. Rebrand and credit instead.
- **Pass the disclaimer along.** Every number is a static estimate, not a measurement.
  If you show the output to users, keep the "reference only, verify by running it" line
  with it.

The numbers themselves are not copyrightable — quote and rework them freely; the license
is about the code.

