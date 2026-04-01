# gold-price-alert

Minimal multi-user, SaaS-ready version of the gold alert app using Node.js, Express, Prisma, PostgreSQL, cookie sessions, email alerts, and Telegram alerts.

## What changed

- Added a `User` model with per-user gold prices, alerts, activity logs, payment date, and Telegram chat ID
- Added simple email-based login with persistent session cookies
- Scoped all data APIs under authenticated `/api/me/...` routes
- Added Telegram bot delivery alongside email delivery
- Updated the dashboard to show personalized user data

## Core models

- `User`
- `Session`
- `GoldPrice`
- `AlertLog`
- `ActivityLog`

## Auth flow

- `POST /api/auth/login`
  Body: `{ "email": "you@example.com" }`
- `GET /api/auth/me`
- `POST /api/auth/logout`

This is intentionally simple: entering an email creates or logs in the user and sets a secure HTTP-only session cookie.

## User API

All user data routes are protected and user-specific:

- `GET /api/me/dashboard`
- `GET /api/me/latest-price`
- `GET /api/me/prices`
- `POST /api/me/prices/fetch`
- `POST /api/me/manual-price`
- `POST /api/me/payment-date`
- `POST /api/me/telegram-connect`
- `GET /api/me/activity`

## Alerts

Alerts are sent per user when:

- today's price is the user's lowest in the last 30 days
- the user has fewer than 5 days left in the payment window

Alerts are deduplicated per user, per day, per condition.

## Supabase setup

1. Create a Supabase project manually.
2. Copy the pooled connection string into `DATABASE_URL`.
3. Copy the direct connection string into `DIRECT_URL`.
4. Run:

   ```bash
   npx prisma generate
   npx prisma migrate dev --name init
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

The server now expects Prisma migrations to own table creation. The old SQLite bootstrap path has been removed.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example environment file:

   ```bash
   copy .env.example .env
   ```

3. Optionally configure:
   - SMTP for email alerts
   - `TELEGRAM_BOT_TOKEN` for Telegram alerts

4. Start the app:

   ```bash
   npm run dev
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Environment variables

- `PORT`
- `DATABASE_URL`
- `DIRECT_URL`
- `CRON_SCHEDULE`
- `FALLBACK_PRICE_PER_GRAM`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `ALERT_EMAIL_FROM`
- `TELEGRAM_BOT_TOKEN`

## Notes

- On startup, old single-user tables are preserved as backup tables if their schema does not support multi-user scoping.
- The scheduler now processes all users.
- If SMTP or Telegram is not configured, the alert is skipped for that channel and logged in the user's activity stream.
