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
  mediaType = 'application/vnd.ollama.image.model'
): Promise<void> {
  const file = path.join(root, 'manifests', rel)
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

  // 8. 目录不存在：不是错误，只表示没装过 Ollama
  process.env.OLLAMA_MODELS = path.join(root, 'nope')
  scan = await scanOllamaDisk()
  check('目录不存在 → ok 且 dir 为 null', scan.ok && scan.dir === null, String(scan.dir))

  await fs.rm(root, { recursive: true, force: true })
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
