/**
 * Trader Joe — FX Webhook Execution Server
 * Receives alerts from TradingView → validates conditions → executes on OANDA Practice
 * Deploy to Render as a Node.js web service
 */

const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

// ── Config (set as Render Environment Variables) ──────────────────────────────
const OANDA_API_KEY    = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET;   // shared secret with TradingView
const BASE44_WEBHOOK   = process.env.BASE44_WEBHOOK_URL; // optional: notify Trader Joe agent

const OANDA_BASE = 'https://api-fxpractice.oanda.com/v3';

// ── Instrument map: TradingView symbol → OANDA instrument ────────────────────
const INSTRUMENT_MAP = {
  'EURUSD': 'EUR_USD',
  'GBPUSD': 'GBP_USD',
  'AUDUSD': 'AUD_USD',
  'USDJPY': 'USD_JPY',
};

// ── Risk config ───────────────────────────────────────────────────────────────
const RISK_PER_TRADE_PCT = 0.01; // 1% account risk per trade

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'Trader Joe Webhook Server — Online 🟢', time: new Date().toISOString() });
});

// ── Main webhook endpoint ─────────────────────────────────────────────────────
/**
 * Expected TradingView alert JSON payload:
 * {
 *   "secret":     "YOUR_WEBHOOK_SECRET",
 *   "symbol":     "EURUSD",
 *   "action":     "SELL",          // BUY or SELL
 *   "entry":      1.1625,
 *   "stop_loss":  1.1665,
 *   "take_profit": 1.1480,
 *   "comment":    "EUR/USD bearish channel short"
 * }
 */
app.post('/webhook', async (req, res) => {
  const payload = req.body;
  console.log('📩 Incoming webhook:', JSON.stringify(payload));

  // ── 1. Validate secret ────────────────────────────────────────────────────
  if (payload.secret !== WEBHOOK_SECRET) {
    console.warn('❌ Invalid webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, action, entry, stop_loss, take_profit, comment } = payload;

  // ── 2. Validate required fields ───────────────────────────────────────────
  if (!symbol || !action || !entry || !stop_loss || !take_profit) {
    return res.status(400).json({ error: 'Missing required fields: symbol, action, entry, stop_loss, take_profit' });
  }

  const instrument = INSTRUMENT_MAP[symbol.toUpperCase()];
  if (!instrument) {
    return res.status(400).json({ error: `Unsupported symbol: ${symbol}` });
  }

  try {
    // ── 3. Get account balance ────────────────────────────────────────────
    const accountRes = await axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/summary`, {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
    });
    const balance = parseFloat(accountRes.data.account.balance);
    console.log(`💰 Account balance: $${balance}`);

    // ── 4. Calculate position size ────────────────────────────────────────
    const riskAmount   = balance * RISK_PER_TRADE_PCT;
    const stopPips     = Math.abs(entry - stop_loss);
    const pipValue     = getPipValue(symbol);
    let   units        = Math.floor(riskAmount / (stopPips * pipValue));

    // Cap at 100k units (1 standard lot) for safety on practice
    units = Math.min(units, 100000);
    if (action.toUpperCase() === 'SELL') units = -units;

    console.log(`📐 Risk: $${riskAmount.toFixed(2)} | Stop pips: ${(stopPips * pipValue * 10000).toFixed(1)} | Units: ${units}`);

    // ── 5. Get current market price ───────────────────────────────────────
    const priceRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );
    const prices    = priceRes.data.prices[0];
    const bid       = parseFloat(prices.bids[0].price);
    const ask       = parseFloat(prices.asks[0].price);
    const midPrice  = (bid + ask) / 2;

    // ── 6. Entry proximity check (within 0.15% of entry price) ───────────
    const proximityPct = Math.abs(midPrice - entry) / entry;
    if (proximityPct > 0.0015) {
      const msg = `⚠️ Price ${midPrice} too far from entry ${entry} (${(proximityPct * 100).toFixed(3)}%). Skipping.`;
      console.warn(msg);
      return res.status(200).json({ status: 'skipped', reason: msg });
    }

    // ── 7. Build OANDA order ──────────────────────────────────────────────
    const orderBody = {
      order: {
        type:        'MARKET',
        instrument:  instrument,
        units:       units.toString(),
        timeInForce: 'FOK',
        stopLossOnFill: {
          price: stop_loss.toFixed(getDecimalPlaces(symbol)),
          timeInForce: 'GTC'
        },
        takeProfitOnFill: {
          price: take_profit.toFixed(getDecimalPlaces(symbol)),
          timeInForce: 'GTC'
        },
        clientExtensions: {
          comment: comment || `TraderJoe | ${symbol} ${action}`,
          tag:     'trader-joe'
        }
      }
    };

    console.log('📤 Sending order to OANDA:', JSON.stringify(orderBody));

    // ── 8. Execute order ──────────────────────────────────────────────────
    const orderRes = await axios.post(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/orders`,
      orderBody,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const fill = orderRes.data.orderFillTransaction || orderRes.data.orderCreateTransaction;
    const tradeId = fill?.tradeOpened?.tradeID || fill?.id || 'unknown';

    console.log(`✅ Order filled! Trade ID: ${tradeId} | Price: ${fill?.price || 'N/A'}`);

    // ── 9. Notify Base44 agent (optional) ────────────────────────────────
    if (BASE44_WEBHOOK) {
      await axios.post(BASE44_WEBHOOK, {
        event:      'trade_executed',
        symbol,
        action,
        units:      Math.abs(units),
        entry:      fill?.price || entry,
        stop_loss,
        take_profit,
        trade_id:   tradeId,
        balance_before: balance,
        comment
      }).catch(e => console.warn('Base44 notify failed:', e.message));
    }

    return res.json({
      status:     'executed',
      trade_id:   tradeId,
      symbol,
      action,
      units:      Math.abs(units),
      entry:      fill?.price || entry,
      stop_loss,
      take_profit,
      risk_amount: riskAmount.toFixed(2)
    });

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('❌ Execution error:', JSON.stringify(errMsg));
    return res.status(500).json({ error: 'Order execution failed', detail: errMsg });
  }
});

// ── Close all open trades endpoint ────────────────────────────────────────────
app.post('/close-all', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const tradesRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );
    const trades = tradesRes.data.trades;
    const results = [];

    for (const trade of trades) {
      const closeRes = await axios.put(
        `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/trades/${trade.id}/close`,
        {},
        { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
      );
      results.push({ trade_id: trade.id, status: 'closed', pnl: closeRes.data.orderFillTransaction?.pl });
    }

    return res.json({ status: 'all_closed', trades_closed: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── Account status endpoint ───────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const [acct, trades] = await Promise.all([
      axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/summary`, {
        headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
      }),
      axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/openTrades`, {
        headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
      })
    ]);

    return res.json({
      balance:        acct.data.account.balance,
      unrealized_pnl: acct.data.account.unrealizedPL,
      open_trades:    trades.data.trades.length,
      trades:         trades.data.trades.map(t => ({
        id:         t.id,
        instrument: t.instrument,
        units:      t.currentUnits,
        open_price: t.price,
        pnl:        t.unrealizedPL
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function getPipValue(symbol) {
  // Approximate pip value in USD per unit (at standard rates)
  const map = {
    'EURUSD': 0.0001,
    'GBPUSD': 0.0001,
    'AUDUSD': 0.0001,
    'USDJPY': 0.01,
  };
  return map[symbol.toUpperCase()] || 0.0001;
}

function getDecimalPlaces(symbol) {
  return symbol.toUpperCase() === 'USDJPY' ? 3 : 5;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Trader Joe webhook server running on port ${PORT}`));
