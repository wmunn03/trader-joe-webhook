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
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET;
const BASE44_WEBHOOK   = process.env.BASE44_WEBHOOK_URL;

const OANDA_BASE = 'https://api-fxpractice.oanda.com/v3';

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

// ── Main webhook endpoint ─────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const payload = req.body;
  console.log('📩 Incoming webhook:', JSON.stringify(payload));

  if (payload.secret !== WEBHOOK_SECRET) {
    console.warn('❌ Invalid webhook secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { symbol, action, entry, stop_loss, take_profit, comment } = payload;

  if (!symbol || !action || !entry || !stop_loss || !take_profit) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const instrument = INSTRUMENT_MAP[symbol.toUpperCase()];
  if (!instrument) {
    return res.status(400).json({ error: `Unsupported symbol: ${symbol}` });
  }

  try {
    // ── 1. Get account balance ────────────────────────────────────────────
    const accountRes = await axios.get(`${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/summary`, {
      headers: { Authorization: `Bearer ${OANDA_API_KEY}` }
    });
    const balance = parseFloat(accountRes.data.account.balance);
    console.log(`💰 Account balance: $${balance}`);

    // ── 2. Get current price (needed for JPY pip value conversion) ────────
    const priceRes = await axios.get(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/pricing?instruments=${instrument}`,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}` } }
    );
    const prices   = priceRes.data.prices[0];
    const bid      = parseFloat(prices.bids[0].price);
    const ask      = parseFloat(prices.asks[0].price);
    const midPrice = (bid + ask) / 2;

    // ── 3. Entry proximity check (within 0.15%) ───────────────────────────
    const proximityPct = Math.abs(midPrice - entry) / entry;
    if (proximityPct > 0.0015) {
      const msg = `⚠️ Price ${midPrice} too far from entry ${entry} (${(proximityPct * 100).toFixed(3)}%). Skipping.`;
      console.warn(msg);
      return res.status(200).json({ status: 'skipped', reason: msg });
    }

    // ── 4. Position sizing — correct formula ──────────────────────────────
    // Risk amount in USD
    const riskAmount = balance * RISK_PER_TRADE_PCT;

    // Stop loss distance in price terms
    const slDistance = Math.abs(entry - stop_loss);

    // Pip value per unit in USD:
    // For USD quote pairs (EURUSD, GBPUSD, AUDUSD): pip = 0.0001, value per unit = $0.0001
    // For JPY pairs (USDJPY): pip = 0.01, value per unit = $0.01 / currentPrice
    let pipValuePerUnit;
    if (symbol.toUpperCase() === 'USDJPY') {
      pipValuePerUnit = 0.01 / midPrice; // convert JPY pip to USD
    } else {
      pipValuePerUnit = 0.0001; // USD quote: 1 pip = $0.0001 per unit
    }

    // Units = riskAmount / (slDistanceInPips * pipValuePerUnit)
    // slDistanceInPips = slDistance / pipSize
    const pipSize = symbol.toUpperCase() === 'USDJPY' ? 0.01 : 0.0001;
    const slPips  = slDistance / pipSize;
    let   units   = Math.floor(riskAmount / (slPips * pipValuePerUnit));

    // Safety cap: max 50k units (~$5 margin on practice)
    units = Math.min(units, 50000);
    if (action.toUpperCase() === 'SELL') units = -units;

    console.log(`📐 Risk $${riskAmount.toFixed(2)} | SL: ${slPips.toFixed(1)} pips | Units: ${units}`);

    // ── 5. Build and send OANDA order ─────────────────────────────────────
    const decPlaces = symbol.toUpperCase() === 'USDJPY' ? 3 : 5;
    const orderBody = {
      order: {
        type:        'MARKET',
        instrument:  instrument,
        units:       units.toString(),
        timeInForce: 'FOK',
        stopLossOnFill: {
          price:       stop_loss.toFixed(decPlaces),
          timeInForce: 'GTC'
        },
        takeProfitOnFill: {
          price:       take_profit.toFixed(decPlaces),
          timeInForce: 'GTC'
        },
        clientExtensions: {
          comment: comment || `TraderJoe | ${symbol} ${action}`,
          tag:     'trader-joe'
        }
      }
    };

    console.log('📤 Sending order:', JSON.stringify(orderBody));

    const orderRes = await axios.post(
      `${OANDA_BASE}/accounts/${OANDA_ACCOUNT_ID}/orders`,
      orderBody,
      { headers: { Authorization: `Bearer ${OANDA_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const fill    = orderRes.data.orderFillTransaction || orderRes.data.orderCreateTransaction;
    const tradeId = fill?.tradeOpened?.tradeID || fill?.id || 'unknown';

    console.log(`✅ Filled! Trade ID: ${tradeId} | Price: ${fill?.price}`);

    if (BASE44_WEBHOOK) {
      await axios.post(BASE44_WEBHOOK, {
        event: 'trade_executed', symbol, action,
        units: Math.abs(units), entry: fill?.price || entry,
        stop_loss, take_profit, trade_id: tradeId,
        balance_before: balance, comment
      }).catch(e => console.warn('Base44 notify failed:', e.message));
    }

    return res.json({
      status:      'executed',
      trade_id:    tradeId,
      symbol,      action,
      units:       Math.abs(units),
      entry:       fill?.price || entry,
      stop_loss,   take_profit,
      risk_amount: riskAmount.toFixed(2)
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Trader Joe webhook server running on port ${PORT}`));
