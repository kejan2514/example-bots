import { cancelAll, clampToBand, connect, ensureFunded, market, placeLimit, roundToTick } from '../core/mnx.mjs'

const symbol = process.env.SYMBOL ?? 'DPREZ'
const spread = Number(process.env.SPREAD_BPS ?? 300) / 1e4
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ctx = await connect()
await ensureFunded(ctx)
let current, marketId
process.on('SIGINT', async () => {
  if (marketId) console.log(`cancelled ${(await cancelAll(ctx, marketId)).cancelled_count} orders`)
  process.exit()
})

// Binaries are probabilities strictly between 0 and 1 and use special 1x liquidation semantics.
// They resolve by delist, so a missing market is the terminal settlement signal.
while (true) {
  current = await market(symbol)
  if (!current) { if (marketId) await cancelAll(ctx, marketId); console.log(`${symbol} is absent: settled, exiting`); break }
  marketId = current.market_id
  await cancelAll(ctx, current.market_id)
  const prob = Number(process.env.PROB ?? current.mark_price)
  const quote = (price) => roundToTick(current, clampToBand(current, Math.min(0.99, Math.max(0.01, price))))
  const size = Number(process.env.SIZE ?? current.min_order_size)
  const [bidP, askP] = [quote(prob - spread), quote(prob + spread)]
  // Both clamps (probability bounds + oracle band) can squeeze bid and ask together; never self-cross.
  if (bidP >= askP) { console.log('band collapsed quotes; skipping'); await sleep(5000); continue }
  const bid = await placeLimit(ctx, current, 'LONG', bidP, size, { postOnly: true })
  const ask = await placeLimit(ctx, current, 'SHORT', askP, size, { postOnly: true })
  console.log(`bid ${bidP} (${bid.order.order_id} ${bid.order.status}); ask ${askP} (${ask.order.order_id} ${ask.order.status})`)
  await sleep(5000)
}
