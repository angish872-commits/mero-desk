import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
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
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.LLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || process.env.LLAMA_MODEL || "qwen3:8b";
const OPENCODE_BIN = process.env.OPENCODE_BIN || "/home/movefule/.opencode/bin/opencode";
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || "opencode/big-pickle";
const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS || 45_000);
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

async function askOllama(message) {
  const response = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        {
          role: "system",
          content: "You are the Mero Desk compute assistant. Be concise and useful.",
        },
        { role: "user", content: message },
      ],
      temperature: 0.7,
      stream: false,
      max_tokens: 512,
    }),
  });

  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || data?.message?.content;
  if (!text) throw new Error("Ollama returned no assistant text");
  return { text, demo: false };
}

function parseOpenCodeOutput(stdout) {
  const text = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "text" && typeof event.text === "string") text.push(event.text);
      if (event.part?.type === "text" && typeof event.part.text === "string") text.push(event.part.text);
    } catch {
      // OpenCode's JSON mode can emit terminal noise; only structured text events are user output.
    }
  }
  return text.join("\n").trim();
}

async function askOpenCode(message) {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCODE_BIN, ["run", "--format", "json", "--model", OPENCODE_MODEL, message], {
      cwd: process.env.OPENCODE_CWD || __dirname,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OpenCode timed out."));
    }, OPENCODE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const text = parseOpenCodeOutput(stdout);
      if (code !== 0 || !text) {
        reject(new Error(`OpenCode failed${stderr.trim() ? `: ${stderr.trim().slice(-240)}` : "."}`));
        return;
      }
      resolve({ text, demo: false });
    });
  });
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
        ollamaConfigured: Boolean(OLLAMA_URL),
        ollamaModel: OLLAMA_MODEL,
        opencodeConfigured: Boolean(OPENCODE_BIN),
        opencodeModel: OPENCODE_MODEL,
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
      const runtime = String(body.runtime || "");
      const userLabel = String(body.userLabel || "demo-user").slice(0, 80);

      if (![1, 2, 3, 5].includes(durationMinutes)) {
        return json(res, 400, { error: "Duration must be 1, 2, 3, or 5 minutes." });
      }
      if (!["llama.cpp", "opencode"].includes(runtime)) {
        return json(res, 400, { error: "Unsupported runtime." });
      }

      const launched = await liveState("launch", {
        method: "POST",
        body: { runtime, durationMinutes, userLabel },
      });

      const dbSession = launched.session;
      currentSession = {
        id: dbSession.id,
        userLabel: dbSession.user_label,
        runtime: dbSession.runtime,
        durationMinutes: dbSession.duration_minutes,
        status: dbSession.status,
        startedAt: new Date(dbSession.started_at).getTime(),
        expiresAt: new Date(dbSession.expires_at).getTime(),
      };

      return json(res, 201, { session: currentSession });
    }

    if (req.method === "POST" && req.url === "/api/stop") {
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

      await persistMessage(currentSession.id, "user", message);

      const answer =
        currentSession.runtime === "opencode"
          ? await askOpenCode(message)
          : await askOllama(message);

      await persistMessage(currentSession.id, "assistant", answer.text);

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
