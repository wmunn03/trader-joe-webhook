# Trader Joe — FX Webhook Execution Server

Receives alerts from TradingView, validates conditions, and executes trades on OANDA Practice account.

## Architecture

```
TradingView Alert (JSON) → POST /webhook → Validate → OANDA Market Order (with SL + TP)
```

## Deploy to Render

1. Push this repo to GitHub
2. Go to https://render.com → New → Web Service → connect your GitHub repo
3. Set environment variables in Render dashboard:
   - `OANDA_API_KEY` — your OANDA practice API key
   - `OANDA_ACCOUNT_ID` — e.g. `101-001-XXXXXXXX-XXX`
   - `WEBHOOK_SECRET` — choose any strong random string (e.g. `TJ_abc123xyz`)
4. Deploy — Render will auto-build and give you a public URL

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| POST | `/webhook` | Receive TradingView alert → execute trade |
| POST | `/close-all` | Close all open trades (emergency) |
| GET | `/status?secret=XXX` | View open trades + account balance |

## TradingView Alert Setup

In TradingView → Alerts → Notifications → Webhook URL:
```
https://YOUR-RENDER-URL.onrender.com/webhook
```

Alert message body (JSON):
```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "symbol": "EURUSD",
  "action": "SELL",
  "entry": 1.1625,
  "stop_loss": 1.1665,
  "take_profit": 1.1480,
  "comment": "EUR/USD bearish channel short"
}
```

## Supported Pairs
- EURUSD
- GBPUSD
- AUDUSD
- USDJPY

## Risk Management
- **1% account risk per trade** (configurable via `RISK_PER_TRADE_PCT` in server.js)
- Max 1 standard lot (100,000 units) cap
- **Entry proximity check** — skips execution if current price is >0.15% away from your entry
- Auto stop-loss and take-profit attached to every order

## Safety Notes
- Always test on Practice account first
- The `/webhook` endpoint requires a secret token — never share it publicly
- The entry proximity guard prevents bad fills when price has moved away from your level
