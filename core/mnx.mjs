import {
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  Wallet,
  formatUnits,
  getBytes,
  hexlify,
  keccak256,
  parseUnits,
  randomBytes,
  toBeHex,
  toUtf8Bytes,
} from 'ethers'

const API = 'https://api.testnet.mnx.fi'
const RPC = 'https://carrot.megaeth.com/rpc'
const CHAIN_ID = 6343
const E18 = 10n ** 18n
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(path, options = {}) {
  const response = await fetch(API + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const text = await response.text()
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${JSON.stringify(data)}`)
  return data
}

export async function connect() {
  if (!process.env.MNX_PRIVATE_KEY) throw new Error('Set MNX_PRIVATE_KEY to a fresh testnet key')
  const provider = new JsonRpcProvider(RPC)
  const wallet = new Wallet(process.env.MNX_PRIVATE_KEY, provider)
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('Wrong chain')
  const signature = await wallet.signMessage(getBytes(keccak256(toUtf8Bytes(API))))
  const auth = await request('/v0/auth/authorize', {
    method: 'POST',
    body: JSON.stringify({
      signature, userAddress: wallet.address, isTermAccepted: true,
      accepted_risk_disclaimer: true,
      ...(process.env.MNX_INVITE_CODE ? { invite_code: process.env.MNX_INVITE_CODE } : {}),
    }),
  })
  const headers = { Authorization: `Bearer ${auth.token}` }
  const user = await request('/v0/users/by-eoa/' + wallet.address)
  return { wallet, provider, user, headers }
}

export async function ensureFunded(ctx, minUsd = 20) {
  const [contracts, margin] = await Promise.all([
    request('/v0/contracts/shared'), request(`/v0/balance/${ctx.user.user_id}/margin`, { headers: ctx.headers }),
  ])
  if (margin.balance.available >= minUsd) return margin.balance
  const collateral = new Contract(contracts.addressCollateralToken, [
    'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  ], ctx.wallet)
  const bank = new Contract(contracts.addressMarginBank, [
    'function bankBalances(address) view returns (uint256)', 'function depositToBank(address,uint128) returns (bool)',
  ], ctx.wallet)
  const amount = parseUnits(String(minUsd), Number(await collateral.decimals()))
  const held = await bank.bankBalances(ctx.wallet.address)
  const needed = held < amount ? amount - held : 0n
  if (needed) {
    // Faucet mints wallet USDM and gas, but does not deposit collateral.
    if ((await collateral.balanceOf(ctx.wallet.address)) < needed || await ctx.provider.getBalance(ctx.wallet.address) === 0n) {
      await request('/v0/faucet', { method: 'POST', headers: ctx.headers, body: '{}' })
    }
    if ((await collateral.allowance(ctx.wallet.address, contracts.addressMarginBank)) < needed) {
      await (await collateral.approve(contracts.addressMarginBank, needed)).wait()
    }
    await (await bank.depositToBank(ctx.wallet.address, needed)).wait()
  }
  for (let i = 0; i < 90; i++) {
    const fresh = await request(`/v0/balance/${ctx.user.user_id}/margin`, { headers: ctx.headers })
    if (fresh.balance.available >= minUsd) return fresh.balance
    await sleep(1000)
  }
  throw new Error('Deposit did not appear in margin balance')
}

export const markets = () => request('/v0/markets')
export async function market(symbol) {
  return (await markets()).find((item) => item.symbol === symbol)
}
export const orderbook = (symbol) => request('/v0/orderbook?symbol=' + encodeURIComponent(symbol))

// String() is load-bearing: the JSON body carries this same shortest-decimal repr and the
// server re-scales it to compare against the signature. toFixed() would expose float junk
// (0.565 -> 0.564999...947) and break signature verification.
const raw = (value) => parseUnits(String(value), 18)
const human = (value) => Number(formatUnits(value, 18))
const down = (value, step) => value / step * step

export function roundToTick(market, price) {
  const tick = BigInt(market.tick_size_e18_raw) || raw(market.tick_size)
  return human(down(raw(price), tick))
}

export function clampToBand(market, price) {
  const oracle = Number(market.oracle_price)
  const low = Math.max(Number(market.min_order_price ?? -Infinity), oracle * (1 - Number(market.mtb_short) * 0.9))
  const high = Math.min(Number(market.max_order_price ?? Infinity), oracle * (1 + Number(market.mtb_long) * 0.9))
  return Math.min(high, Math.max(low, price))
}

async function place(ctx, item, side, price, qty, postOnly) {
  const orderType = price === undefined ? 'MARKET' : 'LIMIT'
  const quantity = down(raw(qty), BigInt(item.step_size_e18_raw))
  if (quantity < BigInt(item.min_order_size_e18_raw)) throw new Error('Quantity is below min_order_size')
  const signedPrice = orderType === 'MARKET' ? 0n : raw(price)
  const salt = BigInt(hexlify(randomBytes(6)))
  const expiration = Math.floor(Date.now() / 1000) + 3600
  const flags = toBeHex((salt << 4n) | (side === 'LONG' ? 1n : 0n), 8)
  const types = { Order: [
    { name: 'flags', type: 'bytes8' }, { name: 'quantity', type: 'uint128' },
    { name: 'price', type: 'uint128' }, { name: 'triggerPrice', type: 'uint128' },
    { name: 'triggerCondition', type: 'uint8' }, { name: 'leverage', type: 'uint128' },
    { name: 'maker', type: 'address' }, { name: 'expiration', type: 'uint128' },
  ] }
  const message = { flags, quantity, price: signedPrice, triggerPrice: 0n, triggerCondition: 0,
    leverage: E18, maker: ctx.wallet.address, expiration: BigInt(expiration) }
  const domain = { name: 'IsolatedTrader', version: '2.0', chainId: CHAIN_ID, verifyingContract: item.trader_address }
  // MNX v2 wants personal_sign(typed-data digest), followed by literal 01.
  const signature = await ctx.wallet.signMessage(getBytes(TypedDataEncoder.hash(domain, types, message))) + '01'
  return request('/v0/orders', { method: 'POST', headers: ctx.headers, body: JSON.stringify({
    market_id: item.market_id, side, order_type: orderType, price: orderType === 'MARKET' ? 0 : human(signedPrice),
    quantity_e18_raw: quantity.toString(), leverage: 1, reduce_only: false, post_only: postOnly,
    expiration_seconds: expiration, salt: salt.toString(), signature, signature_type: 1,
  }) })
}

export const placeLimit = (ctx, item, side, price, qty, { postOnly = false } = {}) =>
  place(ctx, item, side, roundToTick(item, clampToBand(item, price)), qty, postOnly)
export const placeMarket = (ctx, item, side, qty) => place(ctx, item, side, undefined, qty, false)
export const cancelAll = (ctx, marketId) => request('/v0/orders/cancel/all', {
  method: 'POST', headers: ctx.headers, body: JSON.stringify({ market_id: marketId, reason: 'example bot cleanup' }),
})
