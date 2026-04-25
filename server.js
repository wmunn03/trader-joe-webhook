Perfect. VSCode is open with the old `server.js`. Here's what to do:

1. Click anywhere in the code
2. **Select all** → `Cmd+A`
3. **Delete** everything
4. **Copy the entire block below** and paste it in

Then save with `Cmd+S`, go back to terminal and run:
```bash
git add server.js && git commit -m "Add LuxAlgo confluence endpoint" && git push
```

Here's the full file to paste:

Here's the full file — **select all in VSCode (`Cmd+A`), delete, then paste this entire block:**

```javascript
/**
 * Trader Joe — FX Webhook Execution Server
 * + Auto-Poller: checks Base44 TradeSetup entity every 5 minutes
 *   via Base44 backend functions.
 * + LuxAlgo endpoint: /luxalgo receives TradingView alerts from LuxAlgo
 *   and cross-references against Pending setups before executing.
 *
 * MAX_CONCURRENT_TRADES = 2
 * Each trade risks 1% of account balance.
 */

const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const OANDA_API_KEY        = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID     = process.env.OANDA_ACCOUNT_ID;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN;

const BASE44_GET_TRADES_URL   = 'https://trader-joe-4634b4f9.base44.app/functions/getPendingTrades';
const BASE44_UPDATE_TRADE_URL = 'https://trader-joe-4634b4f9.base44.app/functions/updateTradeStatus';

const OANDA_BASE            = 'https://api-fxpractice.oanda.com/v3';
const POLL_INTERVAL_MS      = 5 * 60 * 1000;
const MAX_CONCURRENT_TRADES = 2;
const RISK_PER_TRADE_PCT    = 0.01;

// ── Instrument map ────────────────────────────────────────────────────────────
const INSTRUMENT_MAP = {
  'EURUSD':  'EUR_USD',
  'EUR_USD': 'EUR_USD',
  'GBPUSD':  'GBP_USD',
  'GBP_USD': 'GBP_USD',
  'AUDUSD':  'AUD_USD',
  'AUD_USD': 'AUD_USD',
  'USDJPY':  'USD_JPY',
  'USD_JPY': 'USD_JPY',
};

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Trader Joe Webhook Server — Online 🟢', time: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Execute a trade on OANDA
// ─────────────────────────────────────────────────────────────────────────────
async function executeTrade({ symbol, action, entry, stop_loss, take_profit, comment }) {
  const instrument = INSTRUMENT_MAP[symbol.toUpperCase().replace('/', '')];
  if (!instrument) throw new Error(`Unsupported symbol: ${symbol}`);

  const accountRes = await axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/summary`, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
  });
  const balance = parseFloat(accountRes.data.account.balance);
  console.log(`💰 Balance: $${balance}`);

  const priceRes = await axios.get(
    `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`,
    { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
  );
  const prices   = priceRes.data.prices[0];
  const bid      = parseFloat(prices.bids[0].price);
  const ask      = parseFloat(prices.asks[0].price);
  const midPrice = (bid + ask) / 2;

  if (entry !== null) {
    const proximityPct = Math.abs(midPrice - entry) / entry;
    if (proximityPct > 0.0020) {
      throw new Error(`Price ${midPrice.toFixed(5)} too far from entry ${entry} (${(proximityPct * 100).toFixed(3)}%)`);
    }
  }

  const effectiveEntry = entry !== null ? entry : midPrice;

  const riskAmount      = balance * RISK_PER_TRADE_PCT;
  const slDistance      = Math.abs(effectiveEntry - stop_loss);
  const isJPY           = instrument.includes('JPY');
  const pipSize         = isJPY ? 0.01 : 0.0001;
  const pipValuePerUnit = isJPY ? (0.01 / midPrice) : 0.0001;
  const slPips          = slDistance / pipSize;
  let   units           = Math.floor(riskAmount / (slPips * pipValuePerUnit));
  units = Math.min(units, 50000);
  if (action.toUpperCase() === 'SELL') units = -units;

  console.log(`📐 Risk $${riskAmount.toFixed(2)} | SL: ${slPips.toFixed(1)} pips | Units: ${units}`);

  const decPlaces = isJPY ? 3 : 5;
  const orderBody = {
    order: {
      type:        'MARKET',
      instrument,
      units:       units.toString(),
      timeInForce: 'FOK',
      stopLossOnFill:   { price: parseFloat(stop_loss).toFixed(decPlaces),   timeInForce: 'GTC' },
      takeProfitOnFill: { price: parseFloat(take_profit).toFixed(decPlaces), timeInForce: 'GTC' },
      clientExtensions: { comment: comment || `TraderJoe | ${symbol} ${action}`, tag: 'trader-joe' }
    }
  };

  const orderRes = await axios.post(
    `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/orders`,
    orderBody,
    { headers: { Authorization: `Bearer ${OANDA_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const fill    = orderRes.data.orderFillTransaction || orderRes.data.orderCreateTransaction;
  const tradeId = fill?.tradeOpened?.tradeID || fill?.id || 'unknown';
  console.log(`✅ Filled! Trade ID: ${tradeId} | Price: ${fill?.price}`);

  return { tradeId, fillPrice: fill?.price || effectiveEntry, units: Math.abs(units), riskAmount, balance };
}

// ─────────────────────────────────────────────────────────────────────────────
// LUXALGO ENDPOINT — /luxalgo
// ─────────────────────────────────────────────────────────────────────────────
app.post('/luxalgo', async (req, res) => {
  const payload = req.body;

  if (payload.secret !== WEBHOOK_SECRET) {
    console.warn('⚠️  [LuxAlgo] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { pair, action, timeframe, oscillator } = payload;
  if (!pair || !action) {
    return res.status(400).json({ error: 'Missing required fields: pair, action' });
  }

  const normalizedPair   = pair.toUpperCase().replace('/', '').replace('_', '');
  const normalizedAction = action.toUpperCase();

  console.log(`📡 [LuxAlgo] Signal: ${normalizedPair} ${normalizedAction} | TF: ${timeframe || 'N/A'} | Osc: ${oscillator || 'N/A'}`);

  try {
    const openTradesRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );
    const openCount = openTradesRes.data.trades.length;

    if (openCount >= MAX_CONCURRENT_TRADES) {
      console.log(`🔍 [LuxAlgo] Max trades reached. Ignoring.`);
      return res.json({ status: 'ignored', reason: 'max_concurrent_trades_reached', open_trades: openCount });
    }

    const b44Res = await axios.get(BASE44_GET_TRADES_URL, {
      headers: { 'x-api-key': BASE44_SERVICE_TOKEN }
    });
    const setups = b44Res.data?.records || [];

    const match = setups.find(s => {
      const setupPair   = (s.pair || '').toUpperCase().replace('/', '').replace('_', '');
      const setupAction = (s.action || '').toUpperCase();
      return setupPair === normalizedPair && setupAction === normalizedAction;
    });

    if (!match) {
      console.log(`🚫 [LuxAlgo] No macro setup for ${normalizedPair} ${normalizedAction}. Ignored.`);
      return res.json({
        status:  'ignored',
        reason:  'no_matching_macro_setup',
        pair:    normalizedPair,
        action:  normalizedAction,
        message: 'No Pending macro setup exists for this pair/direction.'
      });
    }

    console.log(`✅ [LuxAlgo] CONFLUENCE on ${normalizedPair} ${normalizedAction}! Executing...`);

    await axios.post(BASE44_UPDATE_TRADE_URL,
      { id: match.id, status