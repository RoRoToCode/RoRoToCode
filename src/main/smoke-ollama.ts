import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanOllamaDisk } from './ollamadir'

/**
 * Ollama 目录离线解析自检：纯 Node，不启动 Ollama。
 *
 * 造一份和真实存储结构一致的假目录（manifests + blobs），验证：
 * 清单 → 模型名、digest → blob 路径、非 GGUF 识别、坏清单不拖垮整轮扫描。
 */

let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}${detail ? `  ::  ${detail}` : ''}`)
  }
}

/** 造一个 blob：GGUF 魔数 + 填充，模拟真实权重文件 */
function ggufBytes(padding: number): Buffer {
  const head = Buffer.from('GGUF', 'latin1')
  const rest = Buffer.alloc(padding, 7)
  return Buffer.concat([head, rest])
}

async function writeManifest(
  root: string,
  rel: string,
  digest: string,
  size: number,
  mediaType = 'application/vnd.ollama.image.model',
  dir = 'manifests'
): Promise<void> {
  const file = path.join(root, dir, rel)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: 'sha256:config' },
      layers: [
        { mediaType, digest, size },
        { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:tpl', size: 128 }
      ]
    }),
    'utf8'
  )
}

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), `roro-ollama-smoke-${process.pid}`)
  await fs.rm(root, { recursive: true, force: true })
  await fs.mkdir(path.join(root, 'blobs'), { recursive: true })
  process.env.OLLAMA_MODELS = root

  // 1. 目录存在但空
  let scan = await scanOllamaDisk()
  check('空目录：ok 且没有模型', scan.ok && scan.models.length === 0, JSON.stringify(scan.models))

  // 2. 正常模型
  await fs.writeFile(path.join(root, 'blobs', 'sha256-aaaa1111'), ggufBytes(4096))
  await writeManifest(root, 'registry.ollama.ai/library/qwen2.5-coder/7b', 'sha256:aaaa1111', 4100)
  scan = await scanOllamaDisk()
  check('library 命名空间 → 名称是 qwen2.5-coder:7b', scan.models[0]?.name === 'qwen2.5-coder:7b', String(scan.models[0]?.name))
  check('digest 正确映射到 blobs/sha256-xxx', /sha256-aaaa1111$/.test(scan.models[0]?.blob ?? ''), String(scan.models[0]?.blob))
  check('文件大小取自实际 blob', scan.models[0]?.sizeBytes === 4100, String(scan.models[0]?.sizeBytes))
  check('GGUF 魔数识别正确', scan.models[0]?.gguf === true)

  // 3. 非 library 命名空间保留前缀
  await fs.writeFile(path.join(root, 'blobs', 'sha256-bbbb2222'), ggufBytes(1024))
  await writeManifest(root, 'registry.ollama.ai/someone/mymodel/v2', 'sha256:bbbb2222', 1028)
  scan = await scanOllamaDisk()
  const mine = scan.models.find((m) => m.name === 'someone/mymodel:v2')
  check('自定义命名空间 → someone/mymodel:v2', !!mine, scan.models.map((m) => m.name).join(', '))
  check('按体积倒序（大的在前）', scan.models[0]?.name === 'qwen2.5-coder:7b', scan.models[0]?.name ?? '')

  // 4. 不是 GGUF 的 blob（旧 GGML / 别的东西）要标出来，别当成能用的模型
  await fs.writeFile(path.join(root, 'blobs', 'sha256-cccc3333'), Buffer.from('GGML not gguf', 'latin1'))
  await writeManifest(root, 'registry.ollama.ai/library/old-ggml/1b', 'sha256:cccc3333', 13)
  scan = await scanOllamaDisk()
  const old = scan.models.find((m) => m.name === 'old-ggml:1b')
  check('非 GGUF 的 blob 标为 gguf=false', old?.gguf === false, JSON.stringify(old))

  // 5. 清单指向不存在的 blob：跳过，不能让整轮扫描失败
  await writeManifest(root, 'registry.ollama.ai/library/ghost/1b', 'sha256:missing999', 100)
  scan = await scanOllamaDisk()
  check('blob 缺失的清单被跳过', scan.ok && !scan.models.some((m) => m.name === 'ghost:1b'))
  check('其它模型不受影响', scan.models.length === 3, String(scan.models.length))

  // 6. 坏 JSON：跳过这一条，其余照旧
  const bad = path.join(root, 'manifests', 'registry.ollama.ai', 'library', 'broken', '1b')
  await fs.mkdir(path.dirname(bad), { recursive: true })
  await fs.writeFile(bad, '{ this is not json', 'utf8')
  scan = await scanOllamaDisk()
  check('坏清单不会让整轮扫描抛错', scan.ok && scan.models.length === 3, String(scan.models.length))

  // 7. 没有 model 层（比如只有适配器）不算模型
  await writeManifest(
    root,
    'registry.ollama.ai/library/adapter-only/1b',
    'sha256:aaaa1111',
    4100,
    'application/vnd.ollama.image.adapter'
  )
  scan = await scanOllamaDisk()
  check('没有 model 层的清单不计入', !scan.models.some((m) => m.name === 'adapter-only:1b'))

  // 8. 新布局：Ollama 0.12+ 把清单搬到 manifests-v2，host 也从 registry.ollama.ai 变成 ollama.com
  await fs.writeFile(path.join(root, 'blobs', 'sha256-dddd4444'), ggufBytes(2048))
  await writeManifest(root, 'ollama.com/library/qwen3/14b', 'sha256:dddd4444', 2052, undefined, 'manifests-v2')
  scan = await scanOllamaDisk()
  const v2 = scan.models.find((m) => m.name === 'qwen3:14b')
  check('manifests-v2 里的模型也能扫到（老布局同时存在时）', !!v2, scan.models.map((m) => m.name).join(', '))
  check('manifests-v2 的名字去掉 ollama.com/library 前缀', v2?.name === 'qwen3:14b', String(v2?.name))

  // 同一个模型在两个目录各有一份清单：只能出现一次
  await writeManifest(root, 'ollama.com/library/qwen3/14b', 'sha256:dddd4444', 2052, undefined, 'manifests')
  scan = await scanOllamaDisk()
  check(
    '新老目录重复的清单只算一个模型',
    scan.models.filter((m) => m.name === 'qwen3:14b').length === 1,
    String(scan.models.filter((m) => m.name === 'qwen3:14b').length)
  )

  // 9. 只有 manifests-v2（全新装的机器就是这个样子）：不能报「没有模型目录」
  const only = path.join(root, 'v2-only')
  await fs.mkdir(path.join(only, 'blobs'), { recursive: true })
  await fs.writeFile(path.join(only, 'blobs', 'sha256-eeee5555'), ggufBytes(512))
  await writeManifest(only, 'ollama.com/library/llama3.2/3b', 'sha256:eeee5555', 516, undefined, 'manifests-v2')
  process.env.OLLAMA_MODELS = only
  scan = await scanOllamaDisk()
  check('只有 manifests-v2 时 dir 不为 null', scan.dir !== null, String(scan.dir))
  check('只有 manifests-v2 时也能列出模型', scan.models[0]?.name === 'llama3.2:3b', scan.models.map((m) => m.name).join(', '))

  // 10. 目录不存在：不是错误，只表示没装过 Ollama
  process.env.OLLAMA_MODELS = path.join(root, 'nope')
  scan = await scanOllamaDisk()
  check('目录不存在 → ok 且 dir 为 null', scan.ok && scan.dir === null, String(scan.dir))

  await fs.rm(root, { recursive: true, force: true })
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
