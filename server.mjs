import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

async function loadEnvFile() {
  try {
    const raw = await readFile(path.join(__dirname, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env.local is optional.
  }
}

await loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const LLAMA_URL = (process.env.LLAMA_URL || "").replace(/\/$/, "");
const LLAMA_MODEL = process.env.LLAMA_MODEL || "local-model";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";

const SERVER = {
  id: "metrodex-gpu-01",
  name: "Metrodex GPU-01",
  gpu: "NVIDIA RTX 3060",
  vramGb: 12,
  ramGb: 32,
  cpu: "Intel Core i7",
};

let currentSession = null;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(data);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 100_000) throw new Error("Request too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function supabaseEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

async function supabase(pathname, { method = "GET", body, prefer } = {}) {
  if (!supabaseEnabled()) return null;

  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    "Content-Type": "application/json",
  };
  if (prefer) headers.Prefer = prefer;

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Supabase ${response.status}: ${detail.slice(0, 300)}`);
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function persistSession(session) {
  if (!supabaseEnabled()) return;
  await supabase("compute_sessions", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: session.id,
      server_id: SERVER.id,
      user_label: session.userLabel,
      runtime: session.runtime,
      duration_minutes: session.durationMinutes,
      status: session.status,
      started_at: new Date(session.startedAt).toISOString(),
      expires_at: new Date(session.expiresAt).toISOString(),
    },
  });
  await setPersistedServerStatus("BUSY");
}

async function updatePersistedSession(session, status) {
  if (!supabaseEnabled()) return;
  const endedAt = new Date().toISOString();
  await supabase(`compute_sessions?id=eq.${encodeURIComponent(session.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status, ended_at: endedAt },
  });
  await setPersistedServerStatus("AVAILABLE");
}

async function setPersistedServerStatus(status) {
  if (!supabaseEnabled()) return;
  await supabase(`servers?id=eq.${encodeURIComponent(SERVER.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: { status, updated_at: new Date().toISOString() },
  });
}

async function persistMessage(sessionId, role, content) {
  if (!supabaseEnabled()) return;
  await supabase("chat_messages", {
    method: "POST",
    prefer: "return=minimal",
    body: {
      id: crypto.randomUUID(),
      session_id: sessionId,
      role,
      content,
    },
  });
}

async function expireIfNeeded() {
  if (currentSession && currentSession.expiresAt <= Date.now()) {
    const expired = currentSession;
    currentSession = null;
    try {
      await updatePersistedSession(expired, "EXPIRED");
    } catch (error) {
      console.error("Could not persist expiry:", error.message);
    }
  }
}

function extractOpenAIText(data) {
  if (typeof data?.output_text === "string" && data.output_text) {
    return data.output_text;
  }
  const chunks = [];
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function askLlama(message) {
  if (!LLAMA_URL) {
    return {
      text: "llama.cpp is not connected yet. Set LLAMA_URL in .env.local to your local OpenAI-compatible llama.cpp server.",
      demo: true,
    };
  }

  const response = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: LLAMA_MODEL,
      messages: [
        {
          role: "system",
          content: "You are the Metrodex compute demo assistant. Be concise and useful.",
        },
        { role: "user", content: message },
      ],
      temperature: 0.7,
    }),
  });

  if (!response.ok) throw new Error(`llama.cpp returned HTTP ${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("llama.cpp returned no assistant text");
  return { text, demo: false };
}

async function askOpenAI(message) {
  if (!OPENAI_API_KEY) {
    return {
      text: "OpenAI is not connected yet. Put OPENAI_API_KEY in .env.local to enable the cloud runtime.",
      demo: true,
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: message,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenAI ${response.status}: ${detail.slice(0, 240)}`);
  }

  const data = await response.json();
  const text = extractOpenAIText(data);
  if (!text) throw new Error("OpenAI returned no text");
  return { text, demo: false };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const normalized = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(publicDir, normalized);

  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };

  try {
    const data = await readFile(fullPath);
    res.writeHead(200, {
      "Content-Type": types[path.extname(fullPath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    await expireIfNeeded();

    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, {
        ok: true,
        persistence: supabaseEnabled() ? "supabase" : "memory",
        llamaConfigured: Boolean(LLAMA_URL),
        openaiConfigured: Boolean(OPENAI_API_KEY),
      });
    }

    if (req.method === "GET" && req.url === "/api/status") {
      return json(res, 200, {
        server: {
          ...SERVER,
          status: currentSession ? "BUSY" : "AVAILABLE",
        },
        session: currentSession,
      });
    }

    if (req.method === "POST" && req.url === "/api/launch") {
      if (currentSession) {
        return json(res, 409, { error: "The server is already in use." });
      }

      const body = await readJson(req);
      const durationMinutes = Number(body.durationMinutes);
      const runtime = body.runtime;
      const userLabel = String(body.userLabel || "demo-user").slice(0, 80);

      if (![1, 2, 3, 5].includes(durationMinutes)) {
        return json(res, 400, { error: "Duration must be 1, 2, 3, or 5 minutes." });
      }
      if (!["llama.cpp", "openai"].includes(runtime)) {
        return json(res, 400, { error: "Unsupported runtime." });
      }

      currentSession = {
        id: crypto.randomUUID(),
        userLabel,
        runtime,
        durationMinutes,
        status: "RUNNING",
        startedAt: Date.now(),
        expiresAt: Date.now() + durationMinutes * 60_000,
      };

      try {
        await persistSession(currentSession);
      } catch (error) {
        console.error("Supabase persistence failed; continuing in memory:", error.message);
      }

      return json(res, 201, { session: currentSession });
    }

    if (req.method === "POST" && req.url === "/api/stop") {
      if (currentSession) {
        const stopped = currentSession;
        currentSession = null;
        try {
          await updatePersistedSession(stopped, "STOPPED");
        } catch (error) {
          console.error("Could not persist stop:", error.message);
        }
      }
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      if (!currentSession) {
        return json(res, 409, { error: "Launch a compute session first." });
      }

      const body = await readJson(req);
      const message = String(body.message || "").trim();

      if (!message) return json(res, 400, { error: "Message is required." });
      if (message.length > 4000) {
        return json(res, 400, { error: "Message is too long for the MVP." });
      }

      await persistMessage(currentSession.id, "user", message).catch(() => {});

      const answer =
        currentSession.runtime === "openai"
          ? await askOpenAI(message)
          : await askLlama(message);

      await persistMessage(currentSession.id, "assistant", answer.text).catch(() => {});

      return json(res, 200, answer);
    }

    return serveStatic(req, res);
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: error.message || "Unexpected server error." });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Metrodex MVP: http://localhost:${PORT}`);
  console.log(`Persistence: ${supabaseEnabled() ? "Supabase" : "memory fallback"}`);
});
