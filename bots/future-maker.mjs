import { cancelAll, clampToBand, connect, ensureFunded, market, placeLimit, roundToTick } from '../core/mnx.mjs'

const symbol = process.env.SYMBOL ?? 'OPENAI'
const spread = Number(process.env.SPREAD_BPS ?? 30) / 1e4
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ctx = await connect()
await ensureFunded(ctx)
let current, marketId
process.on('SIGINT', async () => {
  if (marketId) console.log(`cancelled ${(await cancelAll(ctx, marketId)).cancelled_count} orders`)
  process.exit()
})

// Valuation futures have no external feed: their oracle is an 8h EMA of book mid.
// Naive quotes can feed back into that EMA. Operator delist is settlement; absence is terminal.
while (true) {
  current = await market(symbol)
  if (!current) { if (marketId) await cancelAll(ctx, marketId); console.log(`${symbol} is absent: settled, exiting`); break }
  marketId = current.market_id
  await cancelAll(ctx, current.market_id)
  const fair = Number(process.env.FAIR ?? current.mark_price)
  const size = Number(process.env.SIZE ?? current.min_order_size)
  const q = (p) => roundToTick(current, clampToBand(current, p))
  const [bidP, askP] = [q(fair * (1 - spread)), q(fair * (1 + spread))]
  // A fair value far outside the oracle band collapses both quotes onto the band edge; never self-cross.
  if (bidP >= askP) { console.log('band collapsed quotes; skipping'); await sleep(5000); continue }
  const bid = await placeLimit(ctx, current, 'LONG', bidP, size, { postOnly: true })
  const ask = await placeLimit(ctx, current, 'SHORT', askP, size, { postOnly: true })
  console.log(`bid ${bidP} (${bid.order.order_id} ${bid.order.status}); ask ${askP} (${ask.order.order_id} ${ask.order.status})`)
  await sleep(5000)
}
