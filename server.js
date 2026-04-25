/**
 * Trader Joe — FX Webhook Execution Server
 * + Auto-Poller: checks Base44 TradeSetup entity every 5 minutes
 * + LuxAlgo endpoint: confluence filter before execution
 * MAX_CONCURRENT_TRADES = 2 | 1% risk per trade
 */

const express = require('express');
const axios   = require('axios');
const app     = express();
app.use(express.json());

const OANDA_API_KEY        = process.env.OANDA_API_KEY;
const OANDA_ACCOUNT_ID     = process.env.OANDA_ACCOUNT_ID;
const WEBHOOK_SECRET       = process.env.WEBHOOK_SECRET;
const BASE44_SERVICE_TOKEN = process.env.BASE44_SERVICE_TOKEN;

const BASE44_GET_TRADES_URL   = 'https://trader-joe-4634b4f9.base44.app/functions/getPendingTrades';
const BASE44_UPDATE_TRADE_URL = 'https://trader-joe-4634b4f9.base44.app/functions/updateTradeStatus';

const OANDA_BASE            = 'https://api-oanda.com/v3';
const POLL_INTERVAL_MS      = 5 * 60 * 1000;
const MAX_CONCURRENT_TRADES = 2;
const RISK_PER_TRADE_PCT    = 0.01;

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

app.get('/', (req, res) => {
  res.json({ status: 'Trader Joe Live — Online', time: new Date().toISOString() });
});

async function executeTrade({ symbol, action, entry, stop_loss, take_profit, comment }) {
  const instrument = INSTRUMENT_MAP[symbol.toUpperCase().replace('/', '')];
  if (!instrument) throw new Error('Unsupported symbol: ' + symbol);

  const accountRes = await axios.get(OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/summary', {
    headers: { Authorization: 'Bearer ' + OANDA_API_KEY }
  });
  const balance = parseFloat(accountRes.data.account.balance);
  console.log('Balance: $' + balance);

  const priceRes = await axios.get(
    OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/pricing?instruments=' + instrument,
    { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } }
  );
  const prices   = priceRes.data.prices[0];
  const bid      = parseFloat(prices.bids[0].price);
  const ask      = parseFloat(prices.asks[0].price);
  const midPrice = (bid + ask) / 2;

  if (entry !== null) {
    const proximityPct = Math.abs(midPrice - entry) / entry;
    if (proximityPct > 0.0020) {
      throw new Error('Price ' + midPrice.toFixed(5) + ' too far from entry ' + entry);
    }
  }

  const effectiveEntry  = entry !== null ? entry : midPrice;
  const riskAmount      = balance * RISK_PER_TRADE_PCT;
  const slDistance      = Math.abs(effectiveEntry - stop_loss);
  const isJPY           = instrument.includes('JPY');
  const pipSize         = isJPY ? 0.01 : 0.0001;
  const pipValuePerUnit = isJPY ? (0.01 / midPrice) : 0.0001;
  const slPips          = slDistance / pipSize;
  let   units           = Math.floor(riskAmount / (slPips * pipValuePerUnit));
  units = Math.min(units, 50000);
  if (action.toUpperCase() === 'SELL') units = -units;

  console.log('Risk $' + riskAmount.toFixed(2) + ' | SL pips: ' + slPips.toFixed(1) + ' | Units: ' + units);

  const decPlaces = isJPY ? 3 : 5;
  const orderBody = {
    order: {
      type:        'MARKET',
      instrument,
      units:       units.toString(),
      timeInForce: 'FOK',
      stopLossOnFill:   { price: parseFloat(stop_loss).toFixed(decPlaces),   timeInForce: 'GTC' },
      takeProfitOnFill: { price: parseFloat(take_profit).toFixed(decPlaces), timeInForce: 'GTC' },
      clientExtensions: { comment: comment || 'TraderJoe | ' + symbol + ' ' + action, tag: 'trader-joe' }
    }
  };

  const orderRes = await axios.post(
    OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/orders',
    orderBody,
    { headers: { Authorization: 'Bearer ' + OANDA_API_KEY, 'Content-Type': 'application/json' } }
  );

  const fill    = orderRes.data.orderFillTransaction || orderRes.data.orderCreateTransaction;
  const tradeId = fill && fill.tradeOpened ? fill.tradeOpened.tradeID : (fill ? fill.id : 'unknown');
  console.log('Filled! Trade ID: ' + tradeId + ' | Price: ' + (fill ? fill.price : 'N/A'));

  return { tradeId, fillPrice: fill ? fill.price : effectiveEntry, units: Math.abs(units), riskAmount, balance };
}

app.post('/luxalgo', async (req, res) => {
  const payload = req.body;
  if (payload.secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const pair       = payload.pair;
  const action     = payload.action;
  const timeframe  = payload.timeframe;
  const oscillator = payload.oscillator;

  if (!pair || !action) {
    return res.status(400).json({ error: 'Missing required fields: pair, action' });
  }

  const normalizedPair   = pair.toUpperCase().replace('/', '').replace('_', '');
  const normalizedAction = action.toUpperCase();

  console.log('[LuxAlgo] Signal: ' + normalizedPair + ' ' + normalizedAction + ' | TF: ' + (timeframe || 'N/A'));

  try {
    const openTradesRes = await axios.get(
      OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/openTrades',
      { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } }
    );
    const openCount = openTradesRes.data.trades.length;

    if (openCount >= MAX_CONCURRENT_TRADES) {
      return res.json({ status: 'ignored', reason: 'max_concurrent_trades_reached', open_trades: openCount });
    }

    const b44Res = await axios.get(BASE44_GET_TRADES_URL, {
      headers: { 'x-api-key': BASE44_SERVICE_TOKEN }
    });
    const setups = b44Res.data && b44Res.data.records ? b44Res.data.records : [];

    const match = setups.find(function(s) {
      const setupPair   = (s.pair || '').toUpperCase().replace('/', '').replace('_', '');
      const setupAction = (s.action || '').toUpperCase();
      return setupPair === normalizedPair && setupAction === normalizedAction;
    });

    if (!match) {
      console.log('[LuxAlgo] No macro setup for ' + normalizedPair + ' ' + normalizedAction + '. Ignored.');
      return res.json({
        status:  'ignored',
        reason:  'no_matching_macro_setup',
        pair:    normalizedPair,
        action:  normalizedAction,
        message: 'No Pending macro setup exists for this pair/direction.'
      });
    }

    console.log('[LuxAlgo] CONFLUENCE on ' + normalizedPair + ' ' + normalizedAction + '! Executing...');

    await axios.post(BASE44_UPDATE_TRADE_URL,
      { id: match.id, status: 'Triggered' },
      { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }
    );

    const result = await executeTrade({
      symbol:      normalizedPair,
      action:      normalizedAction,
      entry:       null,
      stop_loss:   parseFloat(match.stop_loss),
      take_profit: parseFloat(match.take_profit),
      comment:     'TraderJoe LuxAlgo+Macro | ' + normalizedPair + ' ' + normalizedAction + ' | TF:' + (timeframe || 'N/A')
    });

    await axios.post(BASE44_UPDATE_TRADE_URL,
      {
        id:             match.id,
        status:         'Filled',
        trade_id_oanda: result.tradeId,
        notes:          (match.notes || '') + ' | LuxAlgo+Macro fill at ' + result.fillPrice + ' | TF: ' + (timeframe || 'N/A') + (oscillator ? ' | Osc: ' + oscillator : '')
      },
      { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }
    );

    console.log('[LuxAlgo] Executed! ' + normalizedPair + ' | OANDA ID: ' + result.tradeId);

    return res.json({
      status:      'executed',
      source:      'luxalgo_confluence',
      pair:        normalizedPair,
      action:      normalizedAction,
      trade_id:    result.tradeId,
      fill_price:  result.fillPrice,
      stop_loss:   match.stop_loss,
      take_profit: match.take_profit,
      units:       result.units,
      risk_amount: result.riskAmount.toFixed(2),
      timeframe:   timeframe || 'N/A',
      oscillator:  oscillator || 'N/A'
    });

  } catch (err) {
    console.error('[LuxAlgo] Error:', [err.me](https://err.me)ssage);
    return res.status(500).json({ error: 'LuxAlgo processing failed', detail: err.response ? err.response.data : [err.me](https://err.me)ssage });
  }
});

async function pollTradeSetups() {
  console.log('[Poller] Checking... ' + new Date().toISOString());
  try {
    const openTradesRes = await axios.get(
      OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/openTrades',
      { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } }
    );
    const openCount      = openTradesRes.data.trades.length;
    const slotsAvailable = MAX_CONCURRENT_TRADES - openCount;

    console.log('[Poller] Open: ' + openCount + '/' + MAX_CONCURRENT_TRADES + ' | Slots: ' + slotsAvailable);
    if (slotsAvailable <= 0) { console.log('[Poller] Full. Skipping.'); return; }

    const b44Res = await axios.get(BASE44_GET_TRADES_URL, { headers: { 'x-api-key': BASE44_SERVICE_TOKEN } });
    const setups = b44Res.data && b44Res.data.records ? b44Res.data.records : [];
    if (setups.length === 0) { console.log('[Poller] No pending setups.'); return; }

    const sorted = setups
      .filter(function(s) { return s.confidence_score; })
      .sort(function(a, b) { return (b.confidence_score || 0) - (a.confidence_score || 0); });

    const symbolSet = [];
    sorted.forEach(function(s) {
      const raw = (s.pair || '').replace('/', '').toUpperCase();
      const inst = INSTRUMENT_MAP[raw];
      if (inst && symbolSet.indexOf(inst) === -1) symbolSet.push(inst);
    });
    if (symbolSet.length === 0) return;

    const priceRes = await axios.get(
      OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/pricing?instruments=' + symbolSet.join(','),
      { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } }
    );
    const priceMap = {};
    priceRes.data.prices.forEach(function(p) {
      priceMap[p.instrument] = (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2;
    });

    let fired = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (fired >= slotsAvailable) break;
      const setup      = sorted[i];
      const rawSymbol  = (setup.pair || '').replace('/', '').toUpperCase();
      const instrument = INSTRUMENT_MAP[rawSymbol];
      if (!instrument) continue;
      const currentPrice = priceMap[instrument];
      if (!currentPrice) continue;
      const entry     = parseFloat(setup.entry);
      const proximity = Math.abs(currentPrice - entry) / entry;

      console.log('[Poller] ' + rawSymbol + ' | Price: ' + currentPrice.toFixed(5) + ' | Entry: ' + entry + ' | Dist: ' + (proximity * 100).toFixed(3) + '%');

      if (proximity <= 0.0020) {
        try {
          await axios.post(BASE44_UPDATE_TRADE_URL, { id: setup.id, status: 'Triggered' },
            { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } });

          const result = await executeTrade({
            symbol:      rawSymbol,
            action:      setup.action,
            entry:       parseFloat(setup.entry),
            stop_loss:   parseFloat(setup.stop_loss),
            take_profit: parseFloat(setup.take_profit),
            comment:     'TraderJoe Auto | ' + rawSymbol + ' ' + setup.action
          });

          await axios.post(BASE44_UPDATE_TRADE_URL,
            { id: setup.id, status: 'Filled', trade_id_oanda: result.tradeId,
              notes: (setup.notes || '') + ' | Auto-filled at ' + result.fillPrice },
            { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } });

          console.log('[Poller] Filled ' + rawSymbol + '. OANDA ID: ' + result.tradeId);
          fired++;
        } catch (execErr) {
          console.error('[Poller] Failed ' + rawSymbol + ':', [execErr.me](https://execErr.me)ssage);
          await axios.post(BASE44_UPDATE_TRADE_URL,
            { id: setup.id, status: 'Pending', notes: (setup.notes || '') + ' | Failed: ' + [execErr.me](https://execErr.me)ssage },
            { headers: { 'x-api-key': BASE44_SERVICE_TOKEN, 'Content-Type': 'application/json' } }).catch(function() {});
        }
      }
    }
    if (fired === 0) console.log('[Poller] Nothing close enough to entry.');
  } catch (err) {
    console.error('[Poller] Error:', [err.me](https://err.me)ssage);
  }
}

app.post('/webhook', async (req, res) => {
  const payload = req.body;
  if (payload.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const symbol     = payload.symbol;
  const action     = payload.action;
  const entry      = payload.entry;
  const stop_loss  = payload.stop_loss;
  const take_profit = payload.take_profit;
  const comment    = [payload.com](https://payload.com)ment;
  if (!symbol || !action || !entry || !stop_loss || !take_profit)
    return res.status(400).json({ error: 'Missing required fields' });
  try {
    const result = await executeTrade({ symbol, action, entry, stop_loss, take_profit, comment });
    return res.json({ status: 'executed', trade_id: result.tradeId, symbol, action,
      units: result.units, entry: result.fillPrice, stop_loss, take_profit,
      risk_amount: result.riskAmount.toFixed(2) });
  } catch (err) {
    return res.status(500).json({ error: 'Execution failed', detail: err.response ? err.response.data : [err.me](https://err.me)ssage });
  }
});

app.post('/close-all', async (req, res) => {
  if (req.body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const tradesRes = await axios.get(OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/openTrades',
      { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } });
    const results = [];
    for (let i = 0; i < tradesRes.data.trades.length; i++) {
      const trade    = tradesRes.data.trades[i];
      const closeRes = await axios.put(OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/trades/' + trade.id + '/close',
        {}, { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } });
      results.push({ trade_id: trade.id, status: 'closed', pnl: closeRes.data.orderFillTransaction ? closeRes.data.orderFillTransaction.pl : null });
    }
    return res.json({ status: 'all_closed', trades_closed: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.response ? err.response.data : [err.me](https://err.me)ssage });
  }
});

app.get('/status', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const acct   = await axios.get(OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/summary',
      { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } });
    const trades = await axios.get(OANDA_BASE + '/accounts/' + OANDA_ACCOUNT_ID + '/openTrades',
      { headers: { Authorization: 'Bearer ' + OANDA_API_KEY } });
    return res.json({
      balance:        acct.data.account.balance,
      unrealized_pnl: acct.data.account.unrealizedPL,
      open_trades:    trades.data.trades.length,
      trades:         trades.data.trades.map(function(t) {
        return { id: t.id, instrument: t.instrument, units: t.currentUnits, open_price: t.price, pnl: t.unrealizedPL };
      })
    });
  } catch (err) {
    return res.status(500).json({ error: err.response ? err.response.data : [err.me](https://err.me)ssage });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Trader Joe LIVE on port ' + PORT + ' | Max trades: ' + MAX_CONCURRENT_TRADES);
  console.log('LuxAlgo endpoint active: POST /luxalgo');
  pollTradeSetups();
  setInterval(pollTradeSetups, POLL_INTERVAL_MS);
  console.log('Poller active — every 5 minutes');
});