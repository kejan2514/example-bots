import { cancelAll, connect, ensureFunded, market, orderbook, placeMarket } from '../core/mnx.mjs'

const symbol = process.env.SYMBOL ?? 'NVDA'
const edge = Number(process.env.EDGE_BPS ?? 50) / 1e4
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const ctx = await connect()
await ensureFunded(ctx)
let current, marketId, position = 0
process.on('SIGINT', async () => {
  if (marketId) console.log(`cancelled ${(await cancelAll(ctx, marketId)).cancelled_count} orders`)
  process.exit()
})

while (true) {
  current = await market(symbol)
  if (!current) { if (marketId) await cancelAll(ctx, marketId); console.log(`${symbol} is absent: terminal market, exiting`); break }
  marketId = current.market_id
  const size = Number(process.env.SIZE ?? current.min_order_size)
  const max = Number(process.env.MAX_POS ?? 3 * current.min_order_size)
  const book = await orderbook(symbol)
  const bid = Number(book.bids?.[0]?.price), ask = Number(book.asks?.[0]?.price), oracle = Number(current.oracle_price)
  if (ask && ask < oracle * (1 - edge) && position + size <= max) {
    const placed = await placeMarket(ctx, current, 'LONG', size); position += size; console.log(`buy ${placed.order.order_id} ${placed.order.status}; pos ${position}`)
  } else if (bid && bid > oracle * (1 + edge) && position - size >= -max) {
    const placed = await placeMarket(ctx, current, 'SHORT', size); position -= size; console.log(`sell ${placed.order.order_id} ${placed.order.status}; pos ${position}`)
  } else console.log(`no edge; pos ${position}`)
  await sleep(5000)
}
