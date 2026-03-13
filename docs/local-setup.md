# Local Setup

This document defines the team standard for local Kalshi credentials and the recommended development workflow with `mise`.

## Install `mise`

- Official getting started guide: <https://mise.jdx.dev/getting-started.html>
- After installing, verify it:

```bash
mise --version
```

## Team Standard For Kalshi Credentials

Use the same local file layout on every machine:

- Copy `.env.example` to `.env`
- Store the Kalshi private key at `./.certs/kalshi/trade-api.local.pem`
- Point `KALSHI_PRIVATE_KEY_PATH` at that repo-relative path
- Do not use `KALSHI_PRIVATE_KEY_PEM` for normal development

Recommended Kalshi API key naming pattern in the Kalshi UI:

- `kalshi-soccer-trading-bot-local-<your-name-or-initials>`

This keeps the account page readable when multiple keys are created over time.

## Create A Kalshi API Key

Kalshi references:

- API key setup guide: <https://docs.kalshi.com/getting_started/api_keys>
- Account profile page: <https://kalshi.com/account/profile>
- API reference for self-managed keys: <https://docs.kalshi.com/api-reference/api-keys/create-api-key>
- API reference for generated keys: <https://docs.kalshi.com/api-reference/api-keys/generate-api-key>

Preferred path for this project:

1. Sign in to Kalshi and open <https://kalshi.com/account/profile>.
2. In the API keys section, create a new key.
3. Name it with the team pattern: `kalshi-soccer-trading-bot-local-<your-name-or-initials>`.
4. Save the returned private key immediately. Kalshi states that the private key cannot be retrieved again after creation.
5. Create the local directory and save the PEM file:

```bash
mkdir -p .certs/kalshi
chmod 700 .certs .certs/kalshi 2>/dev/null || true
```

6. Save the private key as:

```text
./.certs/kalshi/trade-api.local.pem
```

7. Restrict permissions on macOS/Linux:

```bash
chmod 600 ./.certs/kalshi/trade-api.local.pem
```

## Update `.env`

Start from the example file:

```bash
cp .env.example .env
```

Set the Kalshi values in `.env`:

```dotenv
KALSHI_API_BASE_URL=https://api.elections.kalshi.com/trade-api/v2
KALSHI_API_KEY_ID=replace-with-your-kalshi-key-id
KALSHI_PRIVATE_KEY_PATH=./.certs/kalshi/trade-api.local.pem
```

Notes:

- `KALSHI_API_BASE_URL` should stay on `https://api.elections.kalshi.com/trade-api/v2` unless Kalshi changes its trading API base URL.
- Keep `KALSHI_PRIVATE_KEY_PEM` unset in normal use.
- `.env` and `.certs/` are gitignored in this repo.

## Install Project Dependencies

With `mise` installed, from the repo root run:

```bash
mise install
mise run setup
```

`mise install` installs the toolchain defined in `mise.toml`, and `mise run setup` installs npm dependencies for both the root project and the Angular dashboard. Team task scripts live under `mise/tasks/` so the root config stays focused on tool versions.

## Run The Project With `mise`

Single command for the full local stack:

```bash
mise run up:dry
```

Live trading mode:

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

## Manual Fallback Without `mise`

If someone on the team is not using `mise` yet, the old workflow still works:

```bash
npm install
cd dashboard && npm install
```

Then run these in separate terminals:

```bash
npm run start:dry
npm run monitor:api
npm run dashboard:dev
```
