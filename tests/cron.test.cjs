// cron 解析与「下一次什么时候跑」的单测。纯函数，不碰网络、磁盘和 electron。
const assert = require('node:assert/strict')
const test = require('node:test')

const cron = require('../dist/shared/cron.js')

/** 用本地时间构造，避免测试跟着机器时区漂 */
const at = (y, m, d, hh = 0, mm = 0, ss = 0) => new Date(y, m - 1, d, hh, mm, ss).getTime()

test('每天 9 点：当天 8:59 算出来就是今天 9:00', () => {
  const next = cron.nextRun('0 9 * * *', at(2026, 11, 9, 8, 59))
  assert.equal(next, at(2026, 11, 9, 9, 0))
})

test('每天 9 点：过了 9:00:01 就顺延到明天', () => {
  const next = cron.nextRun('0 9 * * *', at(2026, 11, 9, 9, 0, 1))
  assert.equal(next, at(2026, 11, 10, 9, 0))
})

test('*/15 落在下一个刻钟，而不是整点', () => {
  const next = cron.nextRun('*/15 * * * *', at(2026, 11, 9, 10, 7))
  assert.equal(next, at(2026, 11, 9, 10, 15))
})

test('只限周一时，跨到下一个周一', () => {
  // 2026-11-09 是周一，9:00 已经过了 8:30，只能等下周一
  const next = cron.nextRun('30 8 * * 1', at(2026, 11, 9, 9, 0))
  assert.equal(next, at(2026, 11, 16, 8, 30))
})

test('周日的 7 和 0 等价', () => {
  const t = at(2026, 11, 9, 12, 0)
  assert.equal(cron.nextRun('0 3 * * 7', t), cron.nextRun('0 3 * * 0', t))
})

test('2 月 30 日永远不会命中，返回 null 而不是死循环', () => {
  assert.equal(cron.nextRun('0 0 30 2 *', at(2026, 1, 1)), null)
})

test('非法表达式一律 null：段数不对、越界、步长为 0', () => {
  assert.equal(cron.parseCron('0 9 * *'), null)
  assert.equal(cron.parseCron('70 * * * *'), null)
  assert.equal(cron.parseCron('*/0 * * * *'), null)
  assert.equal(cron.nextRun('not a cron', Date.now()), null)
})

test('日和周同时限定时按「或」处理（标准 cron 语义）', () => {
  // 每月 1 号 或 每周一，2026-11-09 是周一 → 当天 10:00 就该命中
  const next = cron.nextRun('0 10 1 * 1', at(2026, 11, 9, 9, 0))
  assert.equal(next, at(2026, 11, 9, 10, 0))
})

test('间隔任务从传入时间往后加，不受日历影响', () => {
  const t = at(2026, 11, 9, 10, 0)
  assert.equal(cron.nextRunFor({ kind: 'interval', minutes: 90 }, t), t + 90 * 60_000)
})

test('间隔任务的分钟数会被夹到 1~1440', () => {
  const t = at(2026, 11, 9, 10, 0)
  assert.equal(cron.nextRunFor({ kind: 'interval', minutes: 0 }, t), t + 60_000)
  assert.equal(cron.nextRunFor({ kind: 'interval', minutes: 99999 }, t), t + 1440 * 60_000)
})

test('人话说明：日更 / 周更 / 间隔', () => {
  assert.equal(cron.describeTrigger({ kind: 'cron', expr: '0 9 * * *' }), '每天 09:00')
  assert.equal(cron.describeTrigger({ kind: 'cron', expr: '30 8 * * 1,3' }), '每周一、周三 08:30')
  assert.equal(cron.describeTrigger({ kind: 'interval', minutes: 30 }), '每 30 分钟')
  assert.equal(cron.describeTrigger({ kind: 'interval', minutes: 120 }), '每 2 小时')
})
