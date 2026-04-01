# Ubuntu VPS Deployment

This runbook mirrors the futures bot deployment pattern while keeping the spot bot isolated.

This document is for first-time setup. For ongoing code updates on the live VPS, use
[`spot-vps-update.md`](./spot-vps-update.md).

Assumptions:

- Ubuntu 24.04 LTS
- A static VPS public IP
- Binance API key restricted to that IP
- Control API kept private on `127.0.0.1`
- The futures bot may already be running on the same VPS

## 1. Base packages

```bash
sudo apt update
sudo apt install -y ufw git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

## 2. Deploy the repo

```bash
cd /home/trader
git clone YOUR_REPO_URL binance_trader
cd binance_trader
npm ci
cp .env.example .env
```

## 3. Configure the spot bot

Edit `.env` and set:

```dotenv
BINANCE_ENV=testnet
DRY_RUN=true
CONTROL_API_HOST=127.0.0.1
CONTROL_API_PORT=3002
CONTROL_API_TOKEN=replace_with_long_random_token
BOT_STATE_FILE=./data/bot-state.json
BOT_CONFIG_FILE=./config/trading.json
```

Also set:

- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`
- `MAX_LIVE_ORDER_NOTIONAL`

If your futures bot is already on the VPS, keep this spot bot on a different control port. Do not reuse the futures API token or API key.

## 4. Configure symbols and strategies

Edit [`config/trading.json`](../config/trading.json):

- `symbols`: all symbols must currently share the same quote asset
- `strategies`: enable/disable or tune each strategy

Example:

```json
{
  "symbols": ["BTCEUR", "ETHEUR"],
  "strategies": [
    {
      "type": "trend_pullback",
      "name": "Trend Pullback Strategy",
      "enabled": true,
      "parameters": {
        "fastPeriod": 5,
        "pullbackPeriod": 20,
        "trendPeriod": 200
      }
    }
  ]
}
```

## 5. Build and start

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

## 6. Check logs and health

```bash
pm2 status
pm2 logs binance-spot-trader
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:3002/status -H "Authorization: Bearer replace_with_long_random_token"
```

`/health` is for liveness checks. Use `/status` for operator supervision and strategy state.

If `/status` ever reports stale open orders, also check `reconciliation.orders` in the payload. The bot now
normalizes obviously dead local `PENDING` market-order artifacts during restore/reconciliation, so a large
ancient `PENDING` market-order backlog should now indicate a genuine unresolved integrity issue rather than
normal historical residue.

## 7. Private operator access from your own machine

Run this from your local machine:

```bash
ssh -L 3002:127.0.0.1:3002 trader@YOUR_SERVER_IP
```

Then access the control API locally:

```bash
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:3002/status -H "Authorization: Bearer replace_with_long_random_token"
curl -X POST http://127.0.0.1:3002/close-position \
  -H "Authorization: Bearer replace_with_long_random_token" \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTCEUR","reason":"Manual close requested"}'
```

## 8. Move to live mode

Only after paper validation:

```dotenv
BINANCE_ENV=live
DRY_RUN=false
```

Then rebuild and restart:

```bash
npm run build
pm2 restart binance-spot-trader
```

## Notes

- Keep this bot on its own PM2 app, port, state file, and config file.
- Do not expose the control API publicly.
- Keep withdrawals disabled on the Binance API key.
- If the VPS public IP changes, update the Binance API trusted IP list before going live again.
