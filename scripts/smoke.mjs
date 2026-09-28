const baseUrl = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const runtime = process.env.RUNTIME || "llama.cpp";
const waitForExpiry = process.env.WAIT_FOR_EXPIRY === "1";

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${text}`);
  return body;
}

const health = await request("/api/health");
if (!health.ok || health.persistence !== "supabase-live" || !health.ollamaConfigured || !health.opencodeConfigured) {
  throw new Error(`health check failed: ${JSON.stringify(health)}`);
}

const initial = await request("/api/status");
if (initial.server.status !== "AVAILABLE" || initial.session) {
  throw new Error(`expected an available server: ${JSON.stringify(initial)}`);
}

const launched = await request("/api/launch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ runtime, durationMinutes: 1, userLabel: `smoke-${runtime}` }),
});
if (launched.session.durationMinutes !== 1 || launched.session.runtime !== runtime) {
  throw new Error(`unexpected launch response: ${JSON.stringify(launched)}`);
}

const busy = await request("/api/status");
if (busy.server.status !== "BUSY" || busy.session?.id !== launched.session.id) {
  throw new Error(`expected BUSY state: ${JSON.stringify(busy)}`);
}

const chat = await request("/api/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "Reply with exactly OK." }),
});
if (chat.demo || typeof chat.text !== "string" || !chat.text.trim()) {
  throw new Error(`live ${runtime} chat failed: ${JSON.stringify(chat)}`);
}
console.log(`${runtime} chat ok: ${chat.text.trim().slice(0, 120)}`);

if (waitForExpiry) {
  console.log("waiting 65 seconds for the one-minute session to expire");
  await new Promise((resolve) => setTimeout(resolve, 65_000));
} else {
  await request("/api/stop", { method: "POST" });
}

const final = await request("/api/status");
if (final.server.status !== "AVAILABLE" || final.session) {
  throw new Error(`expected AVAILABLE after cleanup: ${JSON.stringify(final)}`);
}
console.log(waitForExpiry ? "one-minute expiry ok" : "stop lifecycle ok");
