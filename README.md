# Tea Time Cafe

Tea Time Cafe is a simple café ordering/FAQ chatbot. It answers menu, price, and
promotion questions and can walk a customer through building, confirming, and
saving a pickup or delivery order. No frameworks, no build step, no database —
just a plain Node.js backend, static JSON data, and a small staff dashboard.

## Project Structure

- **`prompts/`** — System prompt defining Tea Time Cafe's role, tone, and rules.
- **`data/`** — Static JSON data: `menu.json`, `promotions.json`, and a
  generated `orders.json` (created on first confirmed order; not committed).
- **`frontend/`** — `index.html`/`script.js` is the customer-facing chat UI,
  wired to `POST /api/chat`. `dashboard.html`/`dashboard.js` is a working
  staff dashboard served directly by the backend.
- **`backend/server.js`** — The API server. Loads the system prompt + data,
  calls the LLM, manages order state, and serves the dashboard.
- **`.env.example`** / **`.env`** — API key and config. `.env` is never
  committed (see `.gitignore`).

## Requirements

- Node.js 20.12 or later.
- An Anthropic API key.
- Run `npm install` to install dependencies (Express, dotenv, the Anthropic SDK).

## Setup

1. Copy the env template and fill in your own values:

   ```bash
   cp .env.example .env
   ```

   | Variable            | Required | Description                                   |
   | ------------------- | -------- | ---------------------------------------------- |
   | `ANTHROPIC_API_KEY` | Yes      | Anthropic API key. Chat requests fail without it. |
   | `PORT`              | No       | Defaults to `3000`.                             |

   `.env` is gitignored — never commit it. On a hosting platform, set these
   as environment variables/secrets in the platform's dashboard rather than
   uploading a `.env` file.

2. Start the server:

   ```bash
   npm start
   ```

   (equivalent to `node backend/server.js`). If `ANTHROPIC_API_KEY` is
   missing, the server still starts (the dashboard and order endpoints
   don't need it) but `/api/chat` will fail to reach the LLM until it's set.

## What's running

- `POST /api/chat` — chat endpoint used by the frontend (requires
  `ANTHROPIC_API_KEY`).
- `GET /api/orders` / `POST /api/orders/:orderId/status` — used by the
  dashboard; don't touch the LLM.
- `GET /dashboard.html` — staff dashboard (order list + status controls).
- `frontend/index.html` — customer-facing chat UI, served by the backend
  and wired to `POST /api/chat`.

## Known limitations to consider before deploying publicly

- No authentication on the dashboard or `/api/orders*` endpoints — anyone
  who can reach the server can view customer PII (name, phone, delivery
  address) and change order statuses. Restrict network access (e.g. put it
  behind a VPN, IP allowlist, or reverse-proxy auth) before exposing it
  beyond local development.
- Orders are stored in a flat `data/orders.json` file, not a database —
  fine for low traffic, but there's no concurrent-write protection.

## Status

Backend, ordering flow, promotions, customer-facing chat UI, and staff
dashboard are all implemented and working end-to-end.
