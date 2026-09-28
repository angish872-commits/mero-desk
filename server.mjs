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
const OPENCODE_API_KEY = process.env.OPENCODE_API_KEY || "";
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || "gpt-5.6-luna";
const SUPABASE_STATE_URL = (process.env.SUPABASE_STATE_URL || "https://fjzoyuovtadmjdvrline.supabase.co/functions/v1/metrodex-state").replace(/\/$/, "");


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

async function liveState(action = "status", { method = "GET", body } = {}) {
  const separator = SUPABASE_STATE_URL.includes("?") ? "&" : "?";
  const response = await fetch(`${SUPABASE_STATE_URL}${separator}action=${encodeURIComponent(action)}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Live Supabase state returned HTTP ${response.status}`);
  }
  return data;
}

async function persistMessage(sessionId, role, content) {
  await liveState("message", {
    method: "POST",
    body: { sessionId, role, content },
  });
}

async function expireIfNeeded() {
  try {
    const state = await liveState("status");
    currentSession = state.session
      ? {
          id: state.session.id,
          userLabel: state.session.user_label,
          runtime: state.session.runtime,
          durationMinutes: state.session.duration_minutes,
          status: state.session.status,
          startedAt: new Date(state.session.started_at).getTime(),
          expiresAt: new Date(state.session.expires_at).getTime(),
        }
      : null;
  } catch (error) {
    console.error("Live Supabase status unavailable:", error.message);
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

async function askOpenCode(message) {
  if (!OPENCODE_API_KEY) {
    return {
      text: "OpenCode Go is not connected yet. Put OPENCODE_API_KEY in .env.local to enable the cloud runtime.",
      demo: true,
    };
  }

  const response = await fetch("https://opencode.ai/zen/go/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENCODE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENCODE_MODEL,
      input: message,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`OpenCode ${response.status}: ${detail.slice(0, 240)}`);
  }

  const data = await response.json();
  const text = extractOpenAIText(data);
  if (!text) throw new Error("OpenCode returned no text");
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
        persistence: "supabase-live",
        llamaConfigured: Boolean(LLAMA_URL),
        opencodeConfigured: Boolean(OPENCODE_API_KEY),
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
      await liveState("stop", { method: "POST", body: {} });
      currentSession = null;
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
        currentSession.runtime === "opencode"
          ? await askOpenCode(message)
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
  console.log("Persistence: live Supabase Edge Function");
});
