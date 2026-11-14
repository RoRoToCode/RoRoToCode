const test = require('node:test')
const assert = require('node:assert/strict')
const {
  preferFromNames,
  planFromAssets,
  candidateNames,
  isMainPackage,
  isVirtualGpu,
  cudaCodeOf,
  packageCudaCode,
  orderedCudaVersions
} = require('../dist/main/gpuplan.js')

const assets = (tag) => [
  // GitHub 上 cudart 包永远排最前、且名字同样以 -bin-win-cuda-… 结尾
  { name: `cudart-llama-bin-win-cuda-12.4-x64.zip`, browser_download_url: 'u' },
  { name: `llama-${tag}-bin-win-cuda-12.4-x64.zip`, browser_download_url: 'u' },
  { name: `llama-${tag}-bin-win-cuda-13.4-x64.zip`, browser_download_url: 'u' },
  { name: `llama-${tag}-bin-win-vulkan-x64.zip`, browser_download_url: 'u' },
  { name: `llama-${tag}-bin-win-cpu-x64.zip`, browser_download_url: 'u' }
]

test('显卡名 → 后端：N 卡走 CUDA', () => {
  const p = preferFromNames(['NVIDIA GeForce RTX 4060 Laptop GPU', 'Intel(R) UHD Graphics'])
  assert.equal(p.preference, 'cuda')
  assert.match(p.reason, /NVIDIA/)
})

test('显卡名 → 后端：A 卡 / 核显走 Vulkan（不再默认装 CPU 版）', () => {
  assert.equal(preferFromNames(['AMD Radeon RX 7800 XT']).preference, 'vulkan')
  assert.equal(preferFromNames(['Intel(R) Arc(TM) A770 Graphics']).preference, 'vulkan')
  assert.equal(preferFromNames(['Intel(R) Iris(R) Xe Graphics']).preference, 'vulkan')
})

test('显卡名 → 后端：确实没有显卡才落到 CPU', () => {
  const p = preferFromNames([])
  assert.equal(p.preference, 'cpu')
  assert.match(p.reason, /没检测到/)
  assert.equal(preferFromNames(['Microsoft Basic Display Adapter']).preference, 'cpu')
})

test('cudart 包不会被当成主程序包', () => {
  assert.equal(isMainPackage('cudart-llama-bin-win-cuda-12.4-x64.zip'), false)
  assert.equal(isMainPackage('llama-b6000-bin-win-cuda-12.4-x64.zip'), true)
  const only = planFromAssets([{ name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', browser_download_url: 'u' }], 'cuda')
  assert.equal(only, null)
})

test('N 卡：优先 cuda-12.x 主包，并带上同版本 cudart', () => {
  const plan = planFromAssets(assets('b6000'), 'cuda')
  assert.equal(plan.main.name, 'llama-b6000-bin-win-cuda-12.4-x64.zip')
  assert.deepEqual(plan.extras.map((a) => a.name), ['cudart-llama-bin-win-cuda-12.4-x64.zip'])
})

test('A 卡：选 vulkan 主包，不带 cudart', () => {
  const plan = planFromAssets(assets('b6000'), 'vulkan')
  assert.equal(plan.main.name, 'llama-b6000-bin-win-vulkan-x64.zip')
  assert.equal(plan.extras.length, 0)
})

test('强制 CPU：即使有显卡包也选 cpu 包', () => {
  const plan = planFromAssets(assets('b6000'), 'cpu')
  assert.equal(plan.main.name, 'llama-b6000-bin-win-cpu-x64.zip')
})

test('缺 cuda 包时降级：CUDA 优先 → 再降 vulkan', () => {
  const partial = assets('b6000').filter((a) => !/-cuda-/.test(a.name))
  assert.equal(planFromAssets(partial, 'cuda').main.name, 'llama-b6000-bin-win-vulkan-x64.zip')
})

test('镜像兜底候选顺序跟着显卡走', () => {
  assert.match(candidateNames('b6000', 'cuda')[0], /cuda-12\.4/)
  assert.match(candidateNames('b6000', 'vulkan')[0], /vulkan/)
  assert.match(candidateNames('b6000', 'cpu')[0], /cpu/)
  // CPU 也要留一个能跑的兜底，别在包缺失时直接失败
  assert.equal(candidateNames('b6000', 'cpu').length, 2)
})

test('虚拟显卡不算显卡：Parsec / 远程桌面 / Basic Display 都滤掉', () => {
  assert.equal(isVirtualGpu('Parsec Virtual Display Adapter'), true)
  assert.equal(isVirtualGpu('Microsoft Basic Display Adapter'), true)
  assert.equal(isVirtualGpu('Microsoft Remote Display Adapter'), true)
  assert.equal(isVirtualGpu('ToDesk Virtual Display'), true)
  assert.equal(isVirtualGpu('NVIDIA GeForce RTX 4060'), false)
  assert.equal(isVirtualGpu('AMD Radeon RX 7800 XT'), false)
  // 只剩虚拟卡 = 没有可用显卡，装 CPU 版
  assert.equal(preferFromNames(['Parsec Virtual Display Adapter']).preference, 'cpu')
})

test('CUDA 版本解析：包名 / 驱动版本都能换成分数比较', () => {
  assert.equal(cudaCodeOf('12.4'), 1204)
  assert.equal(cudaCodeOf('13.4'), 1304)
  assert.equal(cudaCodeOf(null), null)
  assert.equal(packageCudaCode('llama-b6000-bin-win-cuda-12.4-x64.zip'), 1204)
  assert.equal(packageCudaCode('llama-b6000-bin-win-vulkan-x64.zip'), null)
})

test('驱动支持的 CUDA 版本决定装哪个包（不再写死 12.4）', () => {
  const pool = assets('b6000')
  // 驱动只到 12.6：13.4 装上也加载不了，必须挑 12.4
  assert.equal(planFromAssets(pool, 'cuda', { cudaCode: 1206, computeCap: 8.9 }).main.name,
    'llama-b6000-bin-win-cuda-12.4-x64.zip')
  // 驱动到 13.4 + 普通卡：可以上更新的运行时
  assert.equal(planFromAssets(pool, 'cuda', { cudaCode: 1304, computeCap: 8.9 }).main.name,
    'llama-b6000-bin-win-cuda-13.4-x64.zip')
  // RTX 50（sm_120）必须 12.8 以上：12.4 的运行时没有它的设备代码
  assert.equal(planFromAssets(pool, 'cuda', { cudaCode: 1304, computeCap: 12.0 }).main.name,
    'llama-b6000-bin-win-cuda-13.4-x64.zip')
  // 版本未知（驱动太老 / 读不到）：保守回到 12.x
  assert.equal(planFromAssets(pool, 'cuda', { cudaCode: null, computeCap: null }).main.name,
    'llama-b6000-bin-win-cuda-12.4-x64.zip')
  // 驱动太老，任何 CUDA 包都加载不了：自动落到 Vulkan，而不是白装一个跑不起来的 CUDA 版
  assert.equal(planFromAssets(pool, 'cuda', { cudaCode: 1108, computeCap: 8.6 }).main.name,
    'llama-b6000-bin-win-vulkan-x64.zip')
})

test('镜像兜底的 CUDA 候选顺序同样跟着驱动走', () => {
  // 驱动 13.4 + Blackwell：先试 13.4
  assert.match(candidateNames('b6000', 'cuda', { cudaCode: 1304, computeCap: 12.0 })[0], /cuda-13\.4/)
  // 没有本机信息：仍按 12.4 优先（老驱动更普遍）
  assert.match(candidateNames('b6000', 'cuda', {})[0], /cuda-12\.4/)
  // 驱动 12.6：13.4 直接不进候选，省掉一次必然失败的探测
  assert.deepEqual(orderedCudaVersions({ cudaCode: 1206 }), ['12.4'])
  assert.deepEqual(orderedCudaVersions({ cudaCode: 1304 }), ['13.4', '12.4'])
  // 驱动太老：一个 CUDA 版本都不留，候选里直接是 Vulkan
  assert.deepEqual(orderedCudaVersions({ cudaCode: 1108 }), [])
  assert.match(candidateNames('b6000', 'cuda', { cudaCode: 1108 })[0], /vulkan/)
})
