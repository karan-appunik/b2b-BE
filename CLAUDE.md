# backend-api

Single source of truth backend for the Shopify B2B Platform. Currently a setup-only scaffold — no business logic implemented yet.

## Stack

- Node.js (CommonJS)
- Express
- MongoDB via Mongoose

## Structure

```
app.js          # Express app: middleware + route mounting
server.js       # Entry point: loads env, connects to MongoDB, starts HTTP server
src/
  config/       # env-driven config (db.js = MongoDB connection)
  routes/       # route definitions (currently only health.routes.js)
  controllers/  # (empty) request handlers — to be added
  models/       # (empty) Mongoose schemas — to be added
  middleware/   # (empty) shared Express middleware — to be added
  services/     # (empty) business logic layer — to be added
```

## Commands

```bash
npm install
npm run dev     # node --watch server.js
npm start       # node server.js
```

## Environment variables (`.env`)

| Variable | Description |
|---|---|
| `PORT` | Port the server listens on (default `5000`) |
| `MONGODB_URI` | MongoDB connection string |
| `SHOPIFY_SHOP` | Target shop domain for future Shopify Admin API calls (not yet wired into any code) |
| `SHOPIFY_API_VERSION` | Shopify Admin API version for future integration (not yet wired into any code) |

## Health check

`GET /api/health` — returns service status and MongoDB connection state (`db: "connected"` or `"disconnected"`).

## Notes for future work

- `controllers/`, `models/`, `middleware/`, `services/` are empty placeholders — populate as real features are added, keep the layering (routes → controllers → services → models).
- Shopify Admin API integration is planned (`SHOPIFY_SHOP`, `SHOPIFY_API_VERSION` env vars exist) but not yet implemented.
