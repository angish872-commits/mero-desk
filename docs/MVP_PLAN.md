# Metrodex MVP implementation plan

## Goal

A localhost-first class demo that shows one local compute server being rented for a short AI session.

## Demo flow

1. User enters a lightweight demo login.
2. Dashboard shows Metrodex GPU-01 as AVAILABLE.
3. User selects llama.cpp or OpenCode.
4. User selects 1, 2, 3, or 5 minutes.
5. Backend creates one compute session and marks the node BUSY.
6. AI Chat becomes active.
7. User sends prompts through the backend.
8. When the timer ends, the session expires and the node becomes AVAILABLE again.

## Architecture

Browser
→ Node HTTP backend
→ Runtime adapter
   → llama.cpp on the local server
   → OpenCode Responses API
→ Optional Supabase persistence

The browser never gets SSH credentials, an OpenCode API key, or a Supabase secret key.

## Current API

- GET /api/health
- GET /api/status
- POST /api/launch
- POST /api/chat
- POST /api/stop

## Supabase tables

- servers
- compute_sessions
- chat_messages

The schema is in `supabase/schema.sql`.

RLS is enabled on every public table and anon/authenticated access is revoked. The local backend is designed to use a server-only Supabase secret key.

## Environment

```text
PORT=3000
LLAMA_URL=http://127.0.0.1:8080
LLAMA_MODEL=local-model
OPENCODE_API_KEY=
OPENCODE_MODEL=gpt-5.6-luna
SUPABASE_URL=
SUPABASE_SECRET_KEY=
```

## Run

```bash
cp .env.example .env.local
node server.mjs
```

Open:

```text
http://localhost:3000
```

## MVP scope intentionally excluded

- payments
- Kubernetes
- multi-server scheduling
- public SSH access
- complex billing
- production authentication
- production multi-tenant isolation

Those are future-product concerns, not required for the class MVP.

## Next implementation step

Attach one Supabase project, apply `supabase/schema.sql`, add its server-side URL/secret key locally, then connect the real llama.cpp endpoint on the GPU server.
