# backend-api

Single source of truth backend for the Shopify B2B Platform. Setup-only scaffold — no business logic yet.

## Stack

- Node.js
- Express
- MongoDB (via Mongoose)

## Folder structure

```
src/
  config/       # env-driven config, e.g. MongoDB connection (db.js)
  controllers/  # (empty) request handlers for future features
  models/       # (empty) Mongoose schemas for future features
  routes/       # route definitions — currently only health.routes.js
  middleware/   # (empty) shared Express middleware for future features
  services/     # (empty) business logic layer for future features
app.js          # Express app: middleware + route mounting
server.js       # entry point: loads env, connects to MongoDB, starts the HTTP server
```

## Environment variables (`.env`)

| Variable | Description |
|---|---|
| `PORT` | Port the server listens on (default `5000`) |
| `MONGODB_URI` | MongoDB connection string |
| `SHOPIFY_SHOP` | Target shop domain for future Shopify Admin API calls (not yet wired into any code) |
| `SHOPIFY_API_VERSION` | Shopify Admin API version to use once that integration is built (not yet wired into any code) |

## Commands

```bash
npm install
npm run dev     # node --watch server.js
npm start        # node server.js
```

## Health check

```
GET /api/health
```

Returns:

```json
{
  "status": "ok",
  "service": "backend-api",
  "timestamp": "2026-08-07T...",
  "db": "connected"
}
```

`db` will read `"disconnected"` until a local/remote MongoDB instance is reachable at `MONGODB_URI`.
