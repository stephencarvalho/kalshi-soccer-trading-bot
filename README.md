# Kalshi Soccer 70'+ 2-Goal Lead Bot (Node)

Automated Kalshi trading bot for soccer game winner markets.

## Prerequisites

- Node.js `>= 20.19.0` (Angular 21 requirement)
- npm (project currently uses npm 11 in the dashboard app)
- Kalshi API key ID + private key PEM file on local disk

Check versions:

```bash
node -v
npm -v
```

## Strategy implemented

- Scan open Kalshi events continuously.
- Restrict to configured soccer competitions.
- Trigger when:
  - game minute `>= 70`
  - one team leads by `2+` goals
- Place YES buy order on the leading team's winner market.
- Retry every cycle until minute `80` (uses `immediate_or_cancel` orders).
- Stake target: `$1` per qualifying game (converted to integer contracts using current ask).
- Skip low-liquidity markets.
- Stop all new trading for the day after `$50` realized daily loss (resets by date in configured timezone).

## Important security rule

Do not paste private keys in chat or commit them to git.

Use a local file and point `KALSHI_PRIVATE_KEY_PATH` to it.

## Setup

1. Install dependencies:

```bash
npm install
cd dashboard && npm install && cd ..
```

2. Create `.env`:

```bash
cp .env.example .env
```

3. Fill `.env` with your rotated Kalshi credentials.

Required `.env` keys:

- `KALSHI_API_KEY_ID`
- `KALSHI_PRIVATE_KEY_PATH`

Recommended for first run:

- `DRY_RUN=true`

## Running the full app (backend + frontend)

Use separate terminals.

### Terminal 1: trading bot engine

```bash
npm run start:dry
```

For live trading:

```bash
DRY_RUN=false npm start
```

### Terminal 2: monitor API backend (serves dashboard data)

```bash
npm run monitor:api
```

Monitor API URL:

- `http://localhost:8787/api/health`
- `http://localhost:8787/api/dashboard`

### Terminal 3: Angular dashboard frontend

```bash
npm run dashboard:dev
```

Dashboard URL:

- `http://localhost:4200`

## Dashboard screenshots (key screens)

### 1. Overview (PnL, status, guardrails)

![Dashboard overview](docs/screenshots/01-overview.png)

### 2. Live games monitored + open trades

![Live games and open trades](docs/screenshots/02-live-open-trades.png)

### 3. League leaderboard + closed trades

![League leaderboard and closed trades](docs/screenshots/03-leaderboard-closed.png)

### 4. Action log stream

![Action log](docs/screenshots/04-action-log.png)

## Optional services

### WhatsApp alerts (Twilio sandbox)

Set in `.env`:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_WHATSAPP_TO`

If blank, notifications log locally only.

## Quick health checklist

1. Bot terminal shows cycle logs every poll interval.
2. `http://localhost:8787/api/health` returns `{"ok":true,...}`.
3. `http://localhost:4200` loads dashboard and updates every few seconds.

## Config you should tune first

- `ESTIMATED_WIN_PROBABILITY` and `FEE_BUFFER`
  - default max price is computed as:
  - `MAX_YES_PRICE = ESTIMATED_WIN_PROBABILITY - FEE_BUFFER`
  - with defaults: `0.92 - 0.02 = 0.90`
- `MIN_VOLUME_24H_CONTRACTS`
- `MIN_LIQUIDITY_DOLLARS`

## Why liquidity filters matter

- Low `volume_24h_fp` and low `liquidity_dollars` usually mean wider spreads and poor fill quality.
- A strategy can be directionally right and still lose EV from bad fills.
- Start with conservative defaults (`50` contracts / `$250` liquidity), then tighten/loosen using logs.

## Logs and state

- Human-readable logs: console
- Structured action log: `logs/trading-actions.ndjson`
- Persistent state: `data/state.json`

## Notes and limitations

- This bot currently depends on Kalshi event metadata to read minute/score.
- If some competitions do not expose minute/score consistently, those games will be skipped.
- External live-score feed fallback is intentionally disabled to stay within `$0` budget.

## Runbook

- Pause bot: stop bot process (`Ctrl+C` in terminal 1)
- Resume bot: restart `npm run start:dry` or `DRY_RUN=false npm start`
- Daily stop-loss reset: automatic by date (`TIMEZONE`)
- Monitor API restart: `npm run monitor:api`
- Dashboard restart: `npm run dashboard:dev`

Runtime overrides are stored in `data/runtime-overrides.json` and reloaded each cycle.
