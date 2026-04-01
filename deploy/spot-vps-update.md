# Spot Bot VPS Update Runbook

This document describes the safe update flow for the live spot bot on the Ubuntu VPS.

It is intended for ongoing updates, not first-time provisioning. For initial setup, see
[`ubuntu-vps.md`](./ubuntu-vps.md).

## Scope

- Target host: Ubuntu VPS
- Deploy user: `trader`
- Spot bot repo path: `/home/trader/binance_trader`
- PM2 app name: `binance-spot-trader`
- Futures bot is separate and must not be restarted as part of this flow

## Why This Flow Exists

This bot stores important runtime state and VPS-local configuration inside the repo directory:

- `/home/trader/binance_trader/.env`
- `/home/trader/binance_trader/config/trading.json`
- `/home/trader/binance_trader/data/bot-state.json`

A naive extract-overwrite deploy can replace those files. This runbook preserves them explicitly and
restarts only the spot bot.

## Local Packaging Step

Run this on the local development machine from the parent directory of the repo:

```powershell
cd C:\Users\louis\Documents
tar -czf binance_trader.tar.gz -C C:\Users\louis\Documents binance_trader --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=data --exclude=logs --exclude=prices.db --exclude=config/trading.json
scp .\binance_trader.tar.gz trader@143.110.183.193:/home/trader/
```

### Packaging Rules

- Exclude `node_modules`
- Exclude `dist`
- Exclude `.git`
- Exclude `.env`
- Exclude `data`
- Exclude `logs`
- Exclude `prices.db`
- Exclude `config/trading.json`

Do not upload the local `.env`, local state file, or local trading config to the VPS.

## VPS Update Step

Run this on the VPS:

```bash
cd /home/trader
cp binance_trader/.env /home/trader/binance_trader.env.backup
cp binance_trader/config/trading.json /home/trader/binance_trader.trading.json.backup
cp binance_trader/data/bot-state.json /home/trader/binance_trader.bot-state.json.backup
tar -xzf binance_trader.tar.gz
cp /home/trader/binance_trader.env.backup /home/trader/binance_trader/.env
mkdir -p /home/trader/binance_trader/config /home/trader/binance_trader/data
cp /home/trader/binance_trader.trading.json.backup /home/trader/binance_trader/config/trading.json
cp /home/trader/binance_trader.bot-state.json.backup /home/trader/binance_trader/data/bot-state.json
cd /home/trader/binance_trader
npm ci
npm run build
pm2 restart binance-spot-trader --update-env
```

## Post-Deploy Verification

### 1. Check PM2 status

```bash
pm2 status
```

Confirm:

- `binance-spot-trader` is `online`
- `binance-risk-trader` remains `online`

### 2. Check spot bot logs only

```bash
pm2 logs binance-spot-trader --lines 50
```

Healthy startup should show:

- normal market data fetches
- strategy scans
- trading cycle completion
- persisted state writes to `/home/trader/binance_trader/data/bot-state.json`

### 3. Verify the local operator API

Run:

```bash
curl http://127.0.0.1:3002/health
curl http://127.0.0.1:3002/status -H "Authorization: Bearer YOUR_CONTROL_API_TOKEN"
```

Notes:

- Do not wrap the token in angle brackets. Use `Bearer actual_token_here`, not `Bearer <actual_token_here>`.
- `/health` is the liveness endpoint.
- `/status` is the operator endpoint and should include fields such as:
  - `severity`
  - `recommendedAction`
  - `recommendedActionReason`
  - `operatorState`
  - `baselineReset`
  - `riskVisibility`
  - `openOrderVisibility`
  - `performance`
  - `failures`
  - `reconciliation.orders`

Operator note:

- stale local `PENDING` `MARKET` orders are now normalized during persisted-state restore and exchange reconciliation
- live exit sizing is now clamped to exchange-available base balance before a market sell is submitted
- real unresolved stale orders should still surface in `/status`
- `/status.reconciliation.orders` reports how many stale market orders were reclassified to terminal states
- `/status.openOrderVisibility` should no longer accumulate ancient dead `PENDING` market-order artifacts forever
- `POST /reset-baseline` can rebase drawdown after an external transfer, but only when the book is flat and no cycle is running

If Binance still returns `-2010` insufficient balance on a market sell after this change, treat that as a real
exchange/local state mismatch that needs operator review. The bot should no longer keep retrying an obviously
oversized local exit quantity unchanged.

## Benign Warnings You May See

### `tar: Ignoring unknown extended header keyword 'SCHILY.fflags'`

This is benign. It comes from tar metadata differences between systems and does not indicate a bad deploy.

### `npm warn deprecated ...`

These are dependency warnings, not deploy blockers. They are worth cleaning up separately, but they do
not by themselves mean the release failed.

## Safe Rollback Pattern

If a deploy is bad but the repo is still intact on the VPS:

1. Keep the VPS `.env`, trading config, and bot state.
2. Restore known-good code.
3. Rebuild.
4. Restart only `binance-spot-trader`.

This runbook does not prescribe a Git-based rollback because the current deployment flow is archive-based.

## Things To Avoid

- Do not overwrite `/home/trader/binance_trader/.env`
- Do not overwrite `/home/trader/binance_trader/config/trading.json`
- Do not overwrite `/home/trader/binance_trader/data/bot-state.json`
- Do not run `pm2 restart all`
- Do not run `pm2 stop all`
- Do not run `pm2 delete all`
- Do not restart the futures bot unless that is the explicit task
- Do not expose the control API publicly
- Do not paste live tokens into shared logs or external threads

## Operational Notes

- Spot bot API listens on `127.0.0.1:3002`
- Futures bot is separate and may listen on `127.0.0.1:3333`
- `/health` is liveness-oriented
- `/status` is the detailed operator supervision endpoint
- The VPS is small, so avoid unnecessary extra services or heavy builds

## One-Block Update Sequence

Local:

```powershell
cd C:\Users\louis\Documents
tar -czf binance_trader.tar.gz -C C:\Users\louis\Documents binance_trader --exclude=node_modules --exclude=dist --exclude=.git --exclude=.env --exclude=data --exclude=logs --exclude=prices.db --exclude=config/trading.json
scp .\binance_trader.tar.gz trader@143.110.183.193:/home/trader/
```

VPS:

```bash
cd /home/trader
cp binance_trader/.env /home/trader/binance_trader.env.backup
cp binance_trader/config/trading.json /home/trader/binance_trader.trading.json.backup
cp binance_trader/data/bot-state.json /home/trader/binance_trader.bot-state.json.backup
tar -xzf binance_trader.tar.gz
cp /home/trader/binance_trader.env.backup /home/trader/binance_trader/.env
mkdir -p /home/trader/binance_trader/config /home/trader/binance_trader/data
cp /home/trader/binance_trader.trading.json.backup /home/trader/binance_trader/config/trading.json
cp /home/trader/binance_trader.bot-state.json.backup /home/trader/binance_trader/data/bot-state.json
cd /home/trader/binance_trader
npm ci
npm run build
pm2 restart binance-spot-trader --update-env
pm2 logs binance-spot-trader --lines 50
```
