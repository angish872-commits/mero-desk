# Mero Desk / Metrodex MVP

A minimal web MVP for renting a local AI compute server for short sessions.

## MVP flow

1. Demo login
2. See the local RTX server and availability
3. Choose runtime: llama.cpp or OpenCode
4. Choose 1, 2, 3, or 5 minutes
5. Launch a temporary session
6. Chat with the selected AI runtime
7. Session expires and the server returns to AVAILABLE

The app is intentionally localhost-first and does not expose SSH access to end users.


## Live backend

Supabase project: `mero-desk` (`fjzoyuovtadmjdvrline`)

Live state API:

```text
https://fjzoyuovtadmjdvrline.supabase.co/functions/v1/metrodex-state
```

The Edge Function owns session launch/stop/status/expiry and chat-message persistence.
