# Kalshi Soccer In-Play Trading Bot + Dashboard

Node.js trading engine + monitor API + Angular dashboard for Kalshi soccer match-winner markets.

The bot scans live soccer events, applies rule-based entry logic, places IOC orders, enforces risk controls, and records all trading actions for analysis.

## Prerequisites

- Node.js `>= 20.19.0` (Angular 21 compatible)
- npm
- Kalshi API key ID + RSA private key in a local `.pem` file

Check versions:

```bash
node -v
npm -v
```

## Security First

- Never commit `.env` or `.pem` key files.
- Rotate any key that was ever pasted into chat or logs.
- Use `KALSHI_PRIVATE_KEY_PATH` (file path) instead of inline PEM in env.

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
2. Team must be leading by either:
   - `MIN_GOAL_LEAD` or more right now at the time of entry (default: 2-goal lead)
   - `POST80_MIN_GOAL_LEAD` at/after `POST80_START_MINUTE` (now `85`, default late-rule lead: 1 goal)
   - or, at/after minute `85`, the match is tied and the bot buys `Tie = YES`
3. Leading team red-card filter:
   - skip if `leadingTeamRedCards > trailingTeamRedCards` (when card data is available).
4. Late tie red-card filter:
   - late tie entries only qualify when both teams have the same number of red cards
   - if card data is unavailable, the trade is skipped
5. Market must be active and look like a valid match-winner outcome market.
6. YES ask price must be at or below:
   - `min(MAX_YES_PRICE, ANYTIME_LARGE_LEAD_MAX_YES_PRICE)` for the current 2+ lead signal
   - `min(MAX_YES_PRICE, POST80_MAX_YES_PRICE)` for the late 1-goal rule starting at minute `85`
   - `min(MAX_YES_PRICE, POST80_MAX_YES_PRICE)` for the late tie rule starting at minute `85`
7. Event is skipped if already traded (one filled entry per event).

### Order behavior

- Side: Buy `YES` on leading team market.
- Type: GTC limit order (`time_in_force=good_till_canceled`).
- Limit price:
  - order can fill at any price at or below the signal's configured cap
  - the bot never posts above the stage-specific max price cap (for example `0.90`)
- Contracts: sized against the configured limit price, not just the current ask snapshot.
- Resting-order safety model:
  - at most one bot-managed resting order is allowed per event
  - resting orders are canceled automatically if the signal becomes invalid, the market mapping changes, trading is paused, stop-loss is hit, or the bot is already at max position capacity
  - if a GTC order partially fills, any remaining quantity is canceled immediately so the bot cannot overfill the same event later

### Risk controls

- Daily stop-loss: `MAX_DAILY_LOSS_USD` using settlement PnL and `TIMEZONE` day boundaries.
- Max concurrent open positions: `MAX_OPEN_POSITIONS`.
- Skip if insufficient available cash balance.

### Recovery queue sizing (optional)

Controlled by:

- `RECOVERY_MODE_ENABLED`
- `RECOVERY_STAKE_USD`
- `RECOVERY_MAX_STAKE_USD`

Current queue logic:

- Base stake remains `STAKE_USD` when there are no unresolved closed losses.
- Only settled losing trades create recovery targets.
- Open unrealized PnL does not affect recovery sizing.
- The next trade targets the oldest unresolved loss using Kalshi fee-aware sizing.
- Dashboard shows the recovery queue, remaining loss balance, and linked recovery attempts.

## Strategy Log and Rule History

This project keeps historical trigger labels in persisted trade metadata and action logs. That means older trades can still show strategy IDs that are no longer active. The current rule set and prior rule labels are documented below so dashboard rows and logs remain interpretable over time.

### Current active trigger rules

- `CURRENT_LEAD_2`
  - Current implementation for the early/main signal.
  - Meaning: the currently leading team must be ahead by `MIN_GOAL_LEAD` right now at the moment of entry.
  - Default current setup: leader must be up by `2+` goals now.
- `POST_85_LEAD_1`
  - Current late-game signal.
  - Meaning: once the match reaches minute `85` or later, a team leading by `1+` goal can qualify.
  - Uses the late-rule price cap `POST80_MAX_YES_PRICE`.
- `POST_85_TIE_YES`
  - Current late-game tie signal.
  - Meaning: once the match reaches minute `85` or later, a tied match can qualify for `Tie = YES`.
  - Requires equal red cards for both teams and uses the same late-rule price cap `POST80_MAX_YES_PRICE`.

### Historical trigger rules still found in saved logs/state

- `ANYTIME_LEAD_2`
  - Older rule that allowed entry if the current leader had reached a `2+` goal lead at any earlier point in the match, even if the lead had narrowed by entry time.
  - This rule is no longer active and was replaced by `CURRENT_LEAD_2`.
- `POST_80_LEAD_1`
  - Older late-game rule that started at minute `80`.
  - This rule is no longer active and was replaced by `POST_85_LEAD_1`.
- `POST_70_LEAD_2`
  - Older lead-based entry rule seen in historical trades/logs.
  - This rule is no longer active.

### Sizing modes recorded in logs

- `BASE`
  - Standard non-recovery order sizing using the configured base stake.
- `RECOVERY_QUEUE_CAPPED`
  - Recovery mode sizing where the order was capped by current balance and/or `RECOVERY_MAX_STAKE_USD` instead of fully reaching the target recovery profit.

### Notes on historical logs

- `data/state.json` and `logs/trading-actions.ndjson` preserve the original trigger labels used at the time of each trade.
- The dashboard intentionally shows those original labels for historical accuracy, even if the live strategy has changed since then.

### Dated strategy update log

- `2026-03-16` `POST_85_TIE_YES` added
  - Decision: add late tie entries at/after minute `85` when `Tie = YES` is priced at or below `90c` and both teams have equal red cards.
  - Reason: increase the number of eligible bets and playable games without taking materially different late-game risk than the existing `POST_85_LEAD_1` rule.
- `2026-03-15` `CURRENT_LEAD_2` replaced `ANYTIME_LEAD_2`
  - Decision: require the team to be currently leading by `2+` goals at entry instead of only having led by `2+` at some earlier point.
  - Reason: prevent trades from firing after a lead had already narrowed, which made the dashboard condition text misleading and loosened the intended setup.
- `2026-03-15` `POST_85_LEAD_1` replaced `POST_80_LEAD_1`
  - Decision: move the late 1-goal rule from minute `80` to minute `85`.
  - Reason: make late one-goal entries more conservative while keeping the strategy active in endgame situations.

## Setup

1. Install dependencies:

```bash
npm install
cd dashboard && npm install && cd ..
```

2. Create local env file:

```bash
cp .env.example .env
```

3. Fill `.env` values (especially Kalshi credentials + key path).

## Run (3 terminals)

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

### 2. Recovery queue + live games + open trades

![Live games and open trades](docs/screenshots/02-live-open-trades.png)

### 3. League leaderboard + closed trades

![League leaderboard and closed trades](docs/screenshots/03-leaderboard-closed.png)

### 4. Closed trades + action log

![Action log](docs/screenshots/04-action-log.png)

## `.env` Configuration Reference

### Authentication

- `KALSHI_API_BASE_URL` (default: `https://api.elections.kalshi.com/trade-api/v2`)
- `KALSHI_API_KEY_ID` (required)
- `KALSHI_PRIVATE_KEY_PATH` (required unless using inline PEM)
- `KALSHI_PRIVATE_KEY_PEM` (optional, not recommended)
- `KALSHI_WEB_AUTH_STATE_PATH` (optional, default: `./.openclaw/kalshi-web-auth.json`)
- `KALSHI_WEB_USER_ID` (optional override, used only if not reading from auth state)
- `KALSHI_WEB_SESSION_COOKIE` (optional override, Kalshi web `sessions` cookie value)
- `KALSHI_WEB_CSRF_TOKEN` (optional override, Kalshi web `csrfToken` value)
- `INVESTED_START_DATE` (optional, default: `2026-03-01T00:00:00Z`)

### One-Time Kalshi web auth for deposit-based invested capital

To avoid manually updating web session env vars, run:

```bash
npm install
npm run kalshi:web-auth
```

This opens a browser, lets you log into Kalshi normally, and saves local browser auth state to `.openclaw/kalshi-web-auth.json`.

After that, restart the monitor API:

```bash
npm run monitor:api
```

The dashboard will then read deposit history automatically from the saved web session. Re-run `npm run kalshi:web-auth` only when Kalshi eventually expires the session.

### Bot runtime

- `DRY_RUN` (`true|false`)
- `POLL_SECONDS` (cycle interval)
- `TIMEZONE` (used for daily stop-loss boundaries)
- `LOG_LEVEL` (`info`, etc.)

### Strategy thresholds

- `MIN_GOAL_LEAD`
- `ANYTIME_LARGE_LEAD_MAX_YES_PRICE`
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

### Recovery queue sizing

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

## Logs and Data Persistence

- `logs/trading-actions.ndjson`: append-only event/action log.
- `data/state.json`: bot memory (traded events, stop-loss state, etc.).

If you stop/restart processes, these files preserve bot state and dashboard history context.

## Quick Health Checklist

1. Engine terminal prints cycle logs.
2. `http://localhost:8787/api/health` returns `{"ok": true, ...}`.
3. `http://localhost:4200` loads and refreshes.
4. Dashboard "Agent" status is not `DOWN`.
