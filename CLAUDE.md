# Tea Time Cafe — Project Guide

## Purpose

Tea Time Cafe is a simple café ordering/FAQ chatbot for a small coffee shop. It answers
questions about the menu, prices, and hours, and helps a customer place a basic
order. It is a **beginner-friendly, low-cost** project — favor the simplest
solution that works over anything clever or scalable.

## Architecture

Kept intentionally minimal:

- **`prompts/`** — System prompt(s) defining Tea Time Cafe's role, tone, and rules.
- **`data/`** — Static JSON data: `menu.json`, `promotions.json`, and a
  generated `orders.json` (created on first confirmed order; not committed).
  No database.
- **`frontend/`** — `index.html`/`script.js`/`style.css` is the customer chat
  UI; `dashboard.html`/`dashboard.js` is a staff dashboard for viewing and
  updating order status.
- **`backend/server.js`** — The API server. Loads the system prompt + data,
  calls the LLM, manages order state, and serves the dashboard.
- **`.env.example`** / **`.env`** — API keys and config. `.env` is never committed.

Flow: `frontend` → `backend` → LLM API (using `prompts/` + `data/` as context) → back to `frontend`.

See [README.md](README.md) for current build status and what's implemented
vs. still a placeholder.

## Coding Rules

- Keep it simple. No frameworks, build tools, or abstractions beyond what's
  needed to run a basic chat request/response.
- Prefer plain, readable code over "best practice" patterns aimed at scale.
- No premature features (auth, database, multi-language, etc.) unless asked.
- Comment only non-obvious logic — not what the code already says.
- One clear way to do a thing; don't add config options or flags "just in case."

## Security Rules

- Never hardcode API keys or secrets — always read from `.env` / environment
  variables, and keep `.env` out of version control (already in `.gitignore`).
- Never commit real `.env` values, only `.env.example` with empty placeholders.
- Validate/sanitize any user input before using it in prompts or file/data access.
- Don't log secrets or full API keys, even in debug output.
- Don't add network calls to third-party services beyond the LLM API without
  asking first.

## Token-Saving Rules

- Keep the system prompt in `prompts/` short and focused — no filler.
- Don't send the entire `data/menu.json` on every request if only part is
  relevant; load/filter what's needed.
- Avoid unnecessary conversation history in requests — trim to what's needed
  for context.
- Prefer smaller/cheaper LLM models for simple lookups; only use a stronger
  model if the task genuinely needs it.

## Scope Discipline

Only modify the files needed for the current task. Don't refactor, rename, or
touch unrelated files, folders, or structure while working on something else.
