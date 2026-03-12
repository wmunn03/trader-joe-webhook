/**
 * Trader Joe — FX Webhook Execution Server
 * + Auto-Poller: checks Base44 TradeSetup entity every 5 minutes
 *   and fires orders when price reaches entry level — no TradingView needed.
 */

const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
const OANDA_API_KEY    = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET;
const BASE44_WEBHOOK   = process.env.BASE44_WEBHOOK_URL;
const BASE44_TOKEN     = process.env.BASE44_SERVICE_TOKEN;
const BASE44_APP_ID    = process.env.BASE44_APP_ID || '69b22eb4180f95224634b4f9';
const BASE44_API       = process.env.BASE44_API_URL || 'https://api.base44.com';

const OANDA_BASE       = 'https://api-fxpractice.oanda.com/v3';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ── Instrument map ────────────────────────────────────────────────────────────
const INSTRUMENT_MAP = {
  'EURUSD': 'EUR_USD',
  'GBPUSD': 'GBP_USD',
  'AUDUSD': 'AUD_USD',
  'USDJPY': 'USD_JPY',
};

const RISK_PER_TRADE_PCT = 0.01; // 1% account risk

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Trader Joe Webhook Server — Online 🟢', time: new Date().toISOString() });
});

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: Execute a trade on OANDA
// ─────────────────────────────────────────────────────────────────────────────
async function executeTrade({ symbol, action, entry, stop_loss, take_profit, comment }) {
  const instrument = INSTRUMENT_MAP[symbol.toUpperCase()];
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

  // 3. Entry proximity check (within 0.20% for poller, 0.15% for webhook)
  const proximityPct = Math.abs(midPrice - entry) / entry;
  if (proximityPct > 0.0020) {
    throw new Error(`Price ${midPrice.toFixed(5)} too far from entry ${entry} (${(proximityPct * 100).toFixed(3)}%)`);
  }

  // 4. Position sizing
  const riskAmount     = balance * RISK_PER_TRADE_PCT;
  const slDistance     = Math.abs(entry - stop_loss);
  const pipSize        = symbol.toUpperCase() === 'USDJPY' ? 0.01 : 0.0001;
  const pipValuePerUnit = symbol.toUpperCase() === 'USDJPY' ? (0.01 / midPrice) : 0.0001;
  const slPips         = slDistance / pipSize;
  let   units          = Math.floor(riskAmount / (slPips * pipValuePerUnit));
  units = Math.min(units, 50000);
  if (action.toUpperCase() === 'SELL') units = -units;

  console.log(`📐 Risk $${riskAmount.toFixed(2)} | SL: ${slPips.toFixed(1)} pips | Units: ${units}`);

  // 5. Build order
  const decPlaces = symbol.toUpperCase() === 'USDJPY' ? 3 : 5;
  const orderBody = {
    order: {
      type:        'MARKET',
      instrument,
      units:       units.toString(),
      timeInForce: 'FOK',
      stopLossOnFill:    { price: stop_loss.toFixed(decPlaces),   timeInForce: 'GTC' },
      takeProfitOnFill:  { price: take_profit.toFixed(decPlaces), timeInForce: 'GTC' },
      clientExtensions:  { comment: comment || `TraderJoe | ${symbol} ${action}`, tag: 'trader-joe' }
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
// POLLER: Check Pending TradeSetups every 5 minutes
// ─────────────────────────────────────────────────────────────────────────────
async function pollTradeSetups() {
  console.log(`🔍 [Poller] Checking for Pending trade setups... ${new Date().toISOString()}`);

  try {
    // 1. Fetch all Pending setups from Base44
    const b44Res = await axios.get(
      `${BASE44_API}/api/apps/${BASE44_APP_ID}/entities/TradeSetup/`,
      {
        headers: { 'x-api-key': BASE44_TOKEN },
        params:  { status: 'Pending' }
      }
    );

    const setups = b44Res.data;
    if (!setups || setups.length === 0) {
      console.log('🔍 [Poller] No pending setups found.');
      return;
    }

    console.log(`🔍 [Poller] Found ${setups.length} pending setup(s).`);

    // 2. Get current prices for all needed instruments
    const instruments = [...new Set(setups.map(s => INSTRUMENT_MAP[s.pair?.replace('/', '').toUpperCase()]).filter(Boolean))];
    if (instruments.length === 0) return;

    const priceRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instruments.join(',')}`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );

    const priceMap = {};
    for (const p of priceRes.data.prices) {
      const mid = (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2;
      priceMap[p.instrument] = mid;
    }

    // 3. Check each setup
    for (const setup of setups) {
      const symbol     = setup.pair?.replace('/', '').toUpperCase();
      const instrument = INSTRUMENT_MAP[symbol];
      if (!instrument) continue;

      const currentPrice = priceMap[instrument];
      if (!currentPrice) continue;

      const entry     = parseFloat(setup.entry);
      const proximity = Math.abs(currentPrice - entry) / entry;

      console.log(`📊 [Poller] ${symbol} | Current: ${currentPrice.toFixed(5)} | Entry: ${entry} | Distance: ${(proximity * 100).toFixed(3)}%`);

      // Trigger if within 0.20% of entry
      if (proximity <= 0.0020) {
        console.log(`🎯 [Poller] ${symbol} entry triggered! Executing trade...`);

        try {
          // Mark as Triggered first to prevent double-firing
          await axios.put(
            `${BASE44_API}/api/apps/${BASE44_APP_ID}/entities/TradeSetup/${setup.id}`,
            { status: 'Triggered' },
            { headers: { 'x-api-key': BASE44_TOKEN, 'Content-Type': 'application/json' } }
          );

          const result = await executeTrade({
            symbol,
            action:     setup.action,
            entry:      parseFloat(setup.entry),
            stop_loss:  parseFloat(setup.stop_loss),
            take_profit: parseFloat(setup.take_profit),
            comment:    `TraderJoe Auto | ${symbol} ${setup.action} | ${setup.id}`
          });

          // Update record with trade ID
          await axios.put(
            `${BASE44_API}/api/apps/${BASE44_APP_ID}/entities/TradeSetup/${setup.id}`,
            { status: 'Filled', trade_id_oanda: result.tradeId, notes: (setup.notes || '') + ` | Auto-filled at ${result.fillPrice}` },
            { headers: { 'x-api-key': BASE44_TOKEN, 'Content-Type': 'application/json' } }
          );

          console.log(`✅ [Poller] Trade filled for ${symbol}. OANDA ID: ${result.tradeId}`);

          // Notify Base44 agent
          if (BASE44_WEBHOOK) {
            await axios.post(BASE44_WEBHOOK, {
              event: 'trade_executed', symbol,
              action: setup.action, units: result.units,
              entry: result.fillPrice, stop_loss: setup.stop_loss,
              take_profit: setup.take_profit, trade_id: result.tradeId,
              balance_before: result.balance, comment: 'Auto-poller execution'
            }).catch(e => console.warn('Base44 notify failed:', e.message));
          }

        } catch (execErr) {
          console.error(`❌ [Poller] Trade execution failed for ${symbol}:`, execErr.message);
          // Revert to Pending if execution failed so it can retry
          await axios.put(
            `${BASE44_API}/api/apps/${BASE44_APP_ID}/entities/TradeSetup/${setup.id}`,
            { status: 'Pending', notes: (setup.notes || '') + ` | Exec failed: ${execErr.message}` },
            { headers: { 'x-api-key': BASE44_TOKEN, 'Content-Type': 'application/json' } }
          ).catch(() => {});
        }
      }
    }

  } catch (err) {
    console.error('❌ [Poller] Error fetching setups:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK endpoint (kept for manual/TradingView use if ever needed)
// ─────────────────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const payload = req.body;
  console.log('📩 Incoming webhook:', JSON.stringify(payload));

  if (payload.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, action, entry, stop_loss, take_profit, comment } = payload;
  if (!symbol || !action || !entry || !stop_loss || !take_profit) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await executeTrade({ symbol, action, entry, stop_loss, take_profit, comment });

    if (BASE44_WEBHOOK) {
      await axios.post(BASE44_WEBHOOK, {
        event: 'trade_executed', symbol, action,
        units: result.units, entry: result.fillPrice,
        stop_loss, take_profit, trade_id: result.tradeId,
        balance_before: result.balance, comment
      }).catch(e => console.warn('Base44 notify failed:', e.message));
    }

    return res.json({
      status: 'executed', trade_id: result.tradeId,
      symbol, action, units: result.units,
      entry: result.fillPrice, stop_loss, take_profit,
      risk_amount: result.riskAmount.toFixed(2)
    });

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('❌ Execution error:', JSON.stringify(errMsg));
    return res.status(500).json({ error: 'Order execution failed', detail: errMsg });
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
  console.log(`🚀 Trader Joe webhook server running on port ${PORT}`);

  // Run poller immediately on startup, then every 5 minutes
  pollTradeSetups();
  setInterval(pollTradeSetups, POLL_INTERVAL_MS);
  console.log(`⏱️  Auto-poller active — checking every 5 minutes`);
});
