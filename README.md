# Mero Desk / Metrodex MVP

A minimal web MVP for renting a local AI compute server for short sessions.

## MVP flow

1. Demo login
2. See the local RTX server and availability
3. Choose runtime: Ollama or OpenCode
4. Choose 1, 2, 3, or 5 minutes
5. Launch a temporary session
6. Use Chat or the session Terminal
7. Run Ollama, Python, Node, Git, and project commands in the session workspace
8. Session expires and the server returns to AVAILABLE

The app is intentionally localhost-first and does not expose SSH access to end users.


## Live backend

Supabase project: `mero-desk` (`fjzoyuovtadmjdvrline`)

Live state API:

```text
https://fjzoyuovtadmjdvrline.supabase.co/functions/v1/metrodex-state
```

The Edge Function owns session launch/stop/status/expiry and chat-message persistence.

The Node backend keeps Supabase credentials and the SSH connection server-side. Ollama is
called through its local OpenAI-compatible endpoint. OpenCode is called through the local
OpenCode CLI in JSON mode, so the MVP does not require an OpenCode cloud key.

The Terminal mode is a trusted-LAN MVP feature. It starts a shell as the configured server
user in a session-specific workspace and closes it when the session ends. It is not a public
multi-tenant sandbox yet; production rental requires per-session containers or VMs, quotas,
network controls, authentication, and audit logging.

## Run

```bash
cp .env.example .env.local
npm run start
```

The browser UI is available at `http://127.0.0.1:3000` on the target server. The smoke test
checks Supabase persistence, Ollama chat, and cleanup. Set `RUNTIME=opencode` to test OpenCode;
set `WAIT_FOR_EXPIRY=1` to wait for the full one-minute expiry instead of stopping early.
