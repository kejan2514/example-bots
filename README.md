# MNX testnet bot examples

## What this is

Small, public JavaScript examples for placing and cancelling orders on the MNX testnet. They are intentionally simple teaching code, not production trading systems.

## The three market kinds

| Type | Examples | Price meaning | Settlement | What your bot must handle |
| --- | --- | --- | --- | --- |
| `perpetual` | NVDA, META, H100, DRAM | Stock or compute price in USD | Perpetual | Hourly funding; `us_equity` markets can go stale outside US equity hours. |
| `future` | OPENAI, ANTHROPIC, MOONSHOT, DEEPSEEK | Implied market cap in $B | Operator delists the market | No expiry field or external feed; absence from `GET /v0/markets` is terminal. |
| `binary_future` | DPREZ, ANTHTOP26, OAITOP26 | Probability strictly between 0 and 1 | Operator delists the market | Keep quotes inside `(0,1)`, use leverage 1, and treat absence as settlement. |

## Quickstart

```sh
git clone <this-repository>
cd example-bots
npm install
export MNX_PRIVATE_KEY=0x...       # fresh testnet key; never reuse a real key
export MNX_INVITE_CODE=...         # get one from the MNX team
node bots/perp-maker.mjs
```

The first run authenticates the wallet, uses the testnet faucet if necessary, then approves and deposits USDM into MarginBank. The faucet is rate limited, so keep the funded test wallet around while experimenting.

Outside US equity hours the default NVDA market goes stale and the perp maker will correctly wait instead of quoting. Use `SYMBOL=H100` (a 24/7 compute perpetual) to see quoting at any hour.

## Environment reference

| Variable | Used by | Default | Meaning |
| --- | --- | --- | --- |
| `MNX_PRIVATE_KEY` | all | required | Fresh MegaETH testnet private key. |
| `MNX_INVITE_CODE` | all | unset | Required for a brand-new account; omit after onboarding if desired. |
| `SYMBOL` | all | bot-specific | Market symbol to trade. |
| `SIZE` | all | market minimum | Order quantity. |
| `SPREAD_BPS` | makers | 30 (perp/future), 300 (binary) | Half-spread from the reference value. |
| `FAIR` | future maker | current mark | Your valuation-future fair value. |
| `PROB` | binary maker | current mark | Your binary probability estimate. |
| `EDGE_BPS` | taker | 50 | Oracle deviation required before taking. |
| `MAX_POS` | taker | 3 × minimum size | Locally tracked maximum absolute position. |

## Bots

`perp-maker.mjs` refreshes two post-only quotes around the mark. It cancels when the mark is over five minutes old, which matters for equity-session perpetuals whose funding and oracle freeze when that session closes.

`future-maker.mjs` shows valuation-future quoting. Its oracle is an 8-hour EMA of order-book mid, not an external price feed, so treating your own quotes as independent fair value is a mistake. A missing market means it settled.

`binary-maker.mjs` quotes a probability estimate, clamped first to `[0.01, 0.99]` and then to MNX's market-price band. Binaries use leverage 1 and special 1x liquidation semantics; they also settle by delist.

All three makers share one subtlety: orders must sit inside a band around the oracle price, so an estimate far from the oracle gets both quotes clamped onto the band edge. The bots skip that iteration rather than posting a self-crossing bid/ask pair.

`taker.mjs` reads the public book and takes only when its best price crosses an oracle-relative edge. It tracks net position in memory and will not exceed `MAX_POS`; it may correctly do nothing in a quiet book.

## Safety

Testnet only. Start with tiny sizes. Every bot cancels all of its orders for the current market on `SIGINT`; still verify open orders after any crash or network failure. The examples do not manage real positions, risk limits, reconnects, or persistent state.

See [docs.mnx.fi](https://docs.mnx.fi) for the full API, WebSockets, and session keys needed for production bots.
