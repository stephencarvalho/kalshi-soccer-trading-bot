# Kalshi Soccer In-Play Trading Bot + Dashboard

Node.js trading engine + monitor API + Angular dashboard for Kalshi soccer match-winner markets.

The bot scans live soccer events, applies rule-based entry logic, places IOC orders, enforces risk controls, and records all trading actions for analysis.

## Prerequisites

- Node.js `>= 20.19.0` (Angular 21 compatible)
- npm
- `mise` (recommended): <https://mise.jdx.dev/getting-started.html>
- Kalshi API key ID + RSA private key in a local `.pem` file

### Install `mise`

macOS:

```bash
brew install mise
```

Windows (`winget`):

```powershell
winget install jdx.mise
```

Windows (`scoop`):

```powershell
scoop install mise
```

After install, restart your terminal and verify:

```bash
mise --version
```

Check versions:

```bash
node -v
npm -v
```

## Security First

- Never commit `.env` or `.pem` key files.
- Rotate any key that was ever pasted into chat or logs.
- Use `KALSHI_PRIVATE_KEY_PATH` (file path) instead of inline PEM in env.
- Team standard: store local Kalshi PEMs under `./.certs/kalshi/`.

## Architecture

- Trading engine: `src/index.js`
- Strategy rules: `src/strategy.js`
- Monitor API: `src/monitorServer.js` (`/api/health`, `/api/dashboard`)
- Dashboard (Angular 21): `dashboard/`
- Persistent state: `data/state.json`
- Action logs: `logs/trading-actions.ndjson`

## Strategy (Current Implementation)

### Market scope

- Soccer only.
- League filter from `LEAGUES`:
  - `LEAGUES=ALL` means all soccer competitions detected on Kalshi.
  - comma-separated list means explicit whitelist only.

### Entry conditions

1. Live game data must be available (minute + score).
2. Match minute must be `>= MIN_TRIGGER_MINUTE` (default `70`).
3. Team must be leading by:
   - `MIN_GOAL_LEAD` before `POST80_START_MINUTE` (default: 2-goal lead)
   - `POST80_MIN_GOAL_LEAD` at/after `POST80_START_MINUTE` (default: 1-goal lead)
4. Leading team red-card filter:
   - skip if `leadingTeamRedCards > trailingTeamRedCards` (when card data is available).
5. Market must be active and look like a match-winner market (draw/tie props excluded).
6. YES ask price must be at or below:
   - `MAX_YES_PRICE` before post-80 window
   - `min(MAX_YES_PRICE, POST80_MAX_YES_PRICE)` in post-80 window.
7. Event is skipped if already traded (one filled entry per event).

### Order behavior

- Side: Buy `YES` on leading team market.
- Type: IOC (`time_in_force=immediate_or_cancel`).
- Contracts: `min(floor(stake / ask), floor(balance / ask))`.
- Retry model:
  - if not filled, bot tries again on the next cycle until event no longer eligible.
  - pending orders are not left resting (IOC only).

### Risk controls

- Daily stop-loss: `MAX_DAILY_LOSS_USD` using settlement PnL and `TIMEZONE` day boundaries.
- Max concurrent open positions: `MAX_OPEN_POSITIONS`.
- Skip if insufficient available cash balance.

### Recovery sizing ladder (optional)

Controlled by:

- `RECOVERY_MODE_ENABLED`
- `RECOVERY_STAKE_USD`
- `RECOVERY_MAX_STAKE_USD`

Current ladder logic:

- Track unresolved losses by stake tier and offset with the next higher tier.
- Includes both settled PnL and open unrealized PnL.
- With defaults (`$1 -> $2 -> $4 -> $8 -> $16`):
  - `$1` losses are offset by `$2` wins,
  - `$2` losses by `$4` wins, etc.
- Bot chooses the next stake from the highest tier that still has unresolved loss.

## Setup

1. Install the toolchain with `mise`:

```bash
mise install
```

2. Install project dependencies:

```bash
mise run setup
```

3. Create local env file:

```bash
cp .env.example .env
```

4. Fill `.env` values, especially Kalshi credentials and key path.

Detailed local setup guide:

- [docs/local-setup.md](/Users/ajaymarampalli/Desktop/projects/kalshi-soccer-trading-bot/docs/local-setup.md)
- Kalshi API key guide: <https://docs.kalshi.com/getting_started/api_keys>
- Kalshi account profile: <https://kalshi.com/account/profile>

## Run With `mise`

Task scripts are organized under `mise/tasks/` and loaded by `mise`, while `mise.toml` only pins the toolchain.

Dry run, full stack:

```bash
mise run up:dry
```

Live mode, full stack:

```bash
mise run up:live
```

Individual services:

```bash
mise run start:bot:dry
mise run start:bot:live
mise run start:api
mise run start:dashboard
```

## GitHub Workflows

- CI: installs dependencies, runs backend syntax validation, and builds the Angular dashboard on pushes to `main` and on pull requests.
- CodeQL: scans the JavaScript/TypeScript codebase on pushes to `main`, pull requests, and every Monday at 06:00 UTC.

## Manual Run (3 terminals)

### 1) Trading engine

Dry run:

```bash
npm run start:dry
```

Live mode:

```bash
DRY_RUN=false npm start
```

### 2) Monitor API backend

```bash
npm run monitor:api
```

Health endpoints:

- `http://localhost:8787/api/health`
- `http://localhost:8787/api/dashboard`

### 3) Dashboard frontend

```bash
npm run dashboard:dev
```

UI:

- `http://localhost:4200`

## Dashboard Screenshots (Updated)

### 1. Overview (Chart.js all-time PnL + KPI cards)

![Dashboard overview](docs/screenshots/01-overview.png)

### 2. Recovery ladder + live games + open trades

![Live games and open trades](docs/screenshots/02-live-open-trades.png)

### 3. League leaderboard + closed trades

![League leaderboard and closed trades](docs/screenshots/03-leaderboard-closed.png)

### 4. Closed trades + action log

![Action log](docs/screenshots/04-action-log.png)

## `.env` Configuration Reference

### Authentication

- `KALSHI_API_BASE_URL` (default: `https://api.elections.kalshi.com/trade-api/v2`)
- `KALSHI_API_KEY_ID` (required)
- `KALSHI_PRIVATE_KEY_PATH` (required unless using inline PEM, team standard: `./.certs/kalshi/trade-api.local.pem`)
- `KALSHI_PRIVATE_KEY_PEM` (optional, not recommended)

### Bot runtime

- `DRY_RUN` (`true|false`)
- `POLL_SECONDS` (cycle interval)
- `TIMEZONE` (used for daily stop-loss boundaries)
- `LOG_LEVEL` (`info`, etc.)

### Strategy thresholds

- `MIN_TRIGGER_MINUTE`
- `MIN_GOAL_LEAD`
- `RETRY_UNTIL_MINUTE`
- `STAKE_USD`
- `ESTIMATED_WIN_PROBABILITY`
- `FEE_BUFFER`
- `MAX_YES_PRICE` (if blank, computed as `ESTIMATED_WIN_PROBABILITY - FEE_BUFFER`)
- `POST80_START_MINUTE`
- `POST80_MIN_GOAL_LEAD`
- `POST80_MAX_YES_PRICE`

### Liquidity / market quality settings

- `MIN_VOLUME_24H_CONTRACTS`
- `MIN_LIQUIDITY_DOLLARS`

### Risk controls

- `MAX_OPEN_POSITIONS`
- `MAX_DAILY_LOSS_USD`

### Recovery ladder sizing

- `RECOVERY_MODE_ENABLED`
- `RECOVERY_STAKE_USD`
- `RECOVERY_MAX_STAKE_USD`

### League selection and exclusions

- `LEAGUES` (`ALL` or comma-separated competitions)
- `IGNORE_SETTLEMENT_TICKERS` (comma-separated ticker/event IDs excluded from metrics)

### Notifications (optional)

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_WHATSAPP_FROM`
- `TWILIO_WHATSAPP_TO`

### Storage and overrides

- `STATE_FILE`
- `RUNTIME_OVERRIDES_FILE`

### Netlify / deployed dashboard

- `DASHBOARD_API_BASE_URL` should be set to the public monitor API base URL for Netlify deploys and deploy previews.
- If this is left blank, the dashboard only works in local development where `/api/*` is proxied to `http://localhost:8787`.

## Logs and Data Persistence

- `logs/trading-actions.ndjson`: append-only event/action log.
- `data/state.json`: bot memory (traded events, stop-loss state, etc.).

If you stop/restart processes, these files preserve bot state and dashboard history context.

## Quick Health Checklist

1. Engine terminal prints cycle logs.
2. `http://localhost:8787/api/health` returns `{"ok": true, ...}`.
3. `http://localhost:4200` loads and refreshes.
4. Dashboard "Agent" status is not `DOWN`.
