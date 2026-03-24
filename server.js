/**
 * Trader Joe — FX Webhook Execution Server
 * + Auto-Poller: checks Base44 TradeSetup entity every 5 minutes
 *   via Base44 backend functions.
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

const OANDA_BASE          = 'https://api-fxpractice.oanda.com/v3';
const POLL_INTERVAL_MS    = 5 * 60 * 1000; // 5 minutes
const MAX_CONCURRENT_TRADES = 2;            // ← Max open trades at any time
const RISK_PER_TRADE_PCT  = 0.01;           // 1% per trade

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

  // 1. Account balance
  const accountRes = await axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/summary`, {
    headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
  });
  const balance = parseFloat(accountRes.data.account.balance);
  console.log(`💰 Balance: $${balance}`);

  // 2. Current price
  const priceRes = await axios.get(
    `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`,
    { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
  );
  const prices   = priceRes.data.prices[0];
  const bid      = parseFloat(prices.bids[0].price);
  const ask      = parseFloat(prices.asks[0].price);
  const midPrice = (bid + ask) / 2;

  // 3. Entry proximity check (within 0.20%)
  const proximityPct = Math.abs(midPrice - entry) / entry;
  if (proximityPct > 0.0020) {
    throw new Error(`Price ${midPrice.toFixed(5)} too far from entry ${entry} (${(proximityPct * 100).toFixed(3)}%)`);
  }

  // 4. Position sizing (1% risk per trade)
  const riskAmount      = balance * RISK_PER_TRADE_PCT;
  const slDistance      = Math.abs(entry - stop_loss);
  const isJPY           = instrument.includes('JPY');
  const pipSize         = isJPY ? 0.01 : 0.0001;
  const pipValuePerUnit = isJPY ? (0.01 / midPrice) : 0.0001;
  const slPips          = slDistance / pipSize;
  let   units           = Math.floor(riskAmount / (slPips * pipValuePerUnit));
  units = Math.min(units, 50000);
  if (action.toUpperCase() === 'SELL') units = -units;

  console.log(`📐 Risk $${riskAmount.toFixed(2)} | SL: ${slPips.toFixed(1)} pips | Units: ${units}`);

  // 5. Build order
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

  // 6. Fire order
  const orderRes = await axios.post(
    `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/orders`,
    orderBody,
    { headers: { Authorization: `Bearer ${OANDA_API_KEY}`, 'Content-Type': 'application/json' } }
  );

  const fill    = orderRes.data.orderFillTransaction || orderRes.data.orderCreateTransaction;
  const tradeId = fill?.tradeOpened?.tradeID || fill?.id || 'unknown';
  console.log(`✅ Filled! Trade ID: ${tradeId} | Price: ${fill?.price}`);

  return { tradeId, fillPrice: fill?.price || entry, units: Math.abs(units), riskAmount, balance };
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLER: Check Pending TradeSetups, respect MAX_CONCURRENT_TRADES = 2
// ─────────────────────────────────────────────────────────────────────────────
async function pollTradeSetups() {
  console.log(`🔍 [Poller] Checking trade setups... ${new Date().toISOString()}`);

  try {
    // 1. Check how many trades are already open on OANDA
    const openTradesRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );
    const openCount = openTradesRes.data.trades.length;
    const slotsAvailable = MAX_CONCURRENT_TRADES - openCount;

    console.log(`📊 [Poller] Open trades: ${openCount}/${MAX_CONCURRENT_TRADES} | Slots available: ${slotsAvailable}`);

    if (slotsAvailable <= 0) {
      console.log('🔍 [Poller] Max concurrent trades reached. Skipping.');
      return;
    }

    // 2. Fetch Pending setups from Base44
    const b44Res = await axios.get(BASE44_GET_TRADES_URL, {
      headers: { 'x-api-key': BASE44_SERVICE_TOKEN }
    });

    const setups = b44Res.data?.records || [];
    if (setups.length === 0) {
      console.log('🔍 [Poller] No pending setups found.');
      return;
    }

    // Sort by confidence score descending — best setups first
    const sorted = setups
      .filter(s => s.confidence_score)
      .sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0));

    console.log(`🔍 [Poller] ${sorted.length} pending setup(s) sorted by confidence.`);

    // 3. Get current prices
    const symbols = [...new Set(sorted.map(s => {
      const raw = (s.pair || '').replace('/', '').toUpperCase();
      return INSTRUMENT_MAP[raw];
    }).filter(Boolean))];

    if (symbols.length === 0) return;

    const priceRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${symbols.join(',')}`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );

    const priceMap = {};
    for (const p of priceRes.data.prices) {
      const mid = (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2;
      priceMap[p.instrument] = mid;
    }

    // 4. Work through setups — fire up to `slotsAvailable` trades
    let fired = 0;
    for (const setup of sorted) {
      if (fired >= slotsAvailable) break;

      const rawSymbol  = (setup.pair || '').replace('/', '').toUpperCase();
      const instrument = INSTRUMENT_MAP[rawSymbol];
      if (!instrument) continue;

      const currentPrice = priceMap[instrument];
      if (!currentPrice) continue;

      const entry     = parseFloat(setup.entry);
      const proximity = Math.abs(currentPrice - entry) / entry;

      console.log(`📊 [Poller] ${rawSymbol} | Score: ${setup.confidence_score} | Price: ${currentPrice.toFixed(5)} | Entry: ${entry} | Distance: ${(proximity * 100).toFixed(3)}%`);

      if (proximity <= 0.0020) {
        console.log(`🎯 [Poller] ${rawSymbol} entry triggered! (${fired + 1} of ${slotsAvailable} slots)`);

        try {
          // Mark Triggered to prevent double-fire
          await axios.post(BASE44_UPDATE_TRADE_URL,
            { id: setup.id, status: 'Triggered' },
            { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }
          );

          const result = await executeTrade({
            symbol:      rawSymbol,
            action:      setup.action,
            entry:       parseFloat(setup.entry),
            stop_loss:   parseFloat(setup.stop_loss),
            take_profit: parseFloat(setup.take_profit),
            comment:     `TraderJoe Auto | ${rawSymbol} ${setup.action}`
          });

          await axios.post(BASE44_UPDATE_TRADE_URL,
            {
              id:             setup.id,
              status:         'Filled',
              trade_id_oanda: result.tradeId,
              notes:          (setup.notes || '') + ` | Auto-filled at ${result.fillPrice}`
            },
            { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }
          );

          console.log(`✅ [Poller] Trade filled for ${rawSymbol}. OANDA ID: ${result.tradeId}`);
          fired++;

        } catch (execErr) {
          console.error(`❌ [Poller] Execution failed for ${rawSymbol}:`, execErr.message);
          await axios.post(BASE44_UPDATE_TRADE_URL,
            { id: setup.id, status: 'Pending', notes: (setup.notes || '') + ` | Exec failed: ${execErr.message}` },
            { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }
          ).catch(() => {});
        }
      }
    }

    if (fired === 0) console.log('🔍 [Poller] No setups close enough to entry. Waiting...');

  } catch (err) {
    console.error('❌ [Poller] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK endpoint (manual use)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const payload = req.body;
  if (payload.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, action, entry, stop_loss, take_profit, comment } = payload;
  if (!symbol || !action || !entry || !stop_loss || !take_profit) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await executeTrade({ symbol, action, entry, stop_loss, take_profit, comment });
    return res.json({
      status: 'executed', trade_id: result.tradeId,
      symbol, action, units: result.units,
      entry: result.fillPrice, stop_loss, take_profit,
      risk_amount: result.riskAmount.toFixed(2)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Order execution failed', detail: err.response?.data || err.message });
  }
});

// ── Close all open trades ─────────────────────────────────────────────────────
app.post('/close-all', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const tradesRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );
    const results = [];
    for (const trade of tradesRes.data.trades) {
      const closeRes = await axios.put(
        `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/trades/${trade.id}/close`,
        {}, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
      );
      results.push({ trade_id: trade.id, status: 'closed', pnl: closeRes.data.orderFillTransaction?.pl });
    }
    return res.json({ status: 'all_closed', trades_closed: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── Status endpoint ───────────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [acct, trades] = await Promise.all([
      axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/summary`, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }),
      axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`, { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } })
    ]);
    return res.json({
      balance:        acct.data.account.balance,
      unrealized_pnl: acct.data.account.unrealizedPL,
      open_trades:    trades.data.trades.length,
      trades:         trades.data.trades.map(t => ({
        id: t.id, instrument: t.instrument,
        units: t.currentUnits, open_price: t.price, pnl: t.unrealizedPL
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── Start server + poller ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Trader Joe running on port ${PORT} | Max concurrent trades: ${MAX_CONCURRENT_TRADES}`);
  pollTradeSetups();
  setInterval(pollTradeSetups, POLL_INTERVAL_MS);
  console.log(`⏱️  Auto-poller active — checking every 5 minutes`);
});
