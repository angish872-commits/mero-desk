import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
const SUPABASE_SECRET_KEY = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const SERVER_ID = "metrodex-gpu-01";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function expireOldSession() {
  const nowIso = new Date().toISOString();
  const { data: expired, error } = await db
    .from("compute_sessions")
    .update({ status: "EXPIRED", ended_at: nowIso })
    .eq("server_id", SERVER_ID)
    .eq("status", "RUNNING")
    .lte("expires_at", nowIso)
    .select("id");
  if (error) throw error;
  if (expired?.length) {
    const { error: serverError } = await db
      .from("servers")
      .update({ status: "AVAILABLE", updated_at: nowIso })
      .eq("id", SERVER_ID);
    if (serverError) throw serverError;
  }
}

async function getRunningSession() {
  await expireOldSession();
  const { data, error } = await db
    .from("compute_sessions")
    .select("*")
    .eq("server_id", SERVER_ID)
    .eq("status", "RUNNING")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") || "status";

    if (req.method === "GET" && action === "status") {
      const session = await getRunningSession();
      const { data: server, error } = await db.from("servers").select("*").eq("id", SERVER_ID).single();
      if (error) throw error;
      return reply({ server, session });
    }

    if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    const body = await req.json().catch(() => ({}));

    if (action === "launch") {
      const running = await getRunningSession();
      if (running) return reply({ error: "Server is already busy." }, 409);
      const duration = Number(body.durationMinutes);
      const runtime = String(body.runtime || "");
      const userLabel = String(body.userLabel || "demo-user").slice(0, 80);
      if (![1, 2, 3, 5].includes(duration)) return reply({ error: "Duration must be 1, 2, 3, or 5 minutes." }, 400);
      if (!["llama.cpp", "opencode"].includes(runtime)) return reply({ error: "Unsupported runtime." }, 400);

      const started = new Date();
      const session = {
        id: crypto.randomUUID(),
        server_id: SERVER_ID,
        user_label: userLabel,
        runtime,
        duration_minutes: duration,
        status: "RUNNING",
        started_at: started.toISOString(),
        expires_at: new Date(started.getTime() + duration * 60_000).toISOString(),
      };
      const { data, error } = await db.from("compute_sessions").insert(session).select("*").single();
      if (error) {
        if (error.code === "23505") return reply({ error: "Server is already busy." }, 409);
        throw error;
      }
      const { error: serverError } = await db.from("servers").update({ status: "BUSY", updated_at: started.toISOString() }).eq("id", SERVER_ID);
      if (serverError) throw serverError;
      return reply({ session: data }, 201);
    }

    if (action === "stop") {
      const running = await getRunningSession();
      if (running) {
        const endedAt = new Date().toISOString();
        const { error } = await db.from("compute_sessions").update({ status: "STOPPED", ended_at: endedAt }).eq("id", running.id);
        if (error) throw error;
        const { error: serverError } = await db.from("servers").update({ status: "AVAILABLE", updated_at: endedAt }).eq("id", SERVER_ID);
        if (serverError) throw serverError;
      }
      return reply({ ok: true });
    }

    if (action === "message") {
      const sessionId = String(body.sessionId || "");
      const role = String(body.role || "");
      const content = String(body.content || "").trim();
      if (!sessionId || !["user", "assistant", "system"].includes(role) || !content) return reply({ error: "Invalid message." }, 400);
      const { data: session, error: sessionError } = await db.from("compute_sessions").select("id,status,expires_at").eq("id", sessionId).single();
      if (sessionError) return reply({ error: "Session not found." }, 404);
      if (session.status !== "RUNNING" || new Date(session.expires_at).getTime() <= Date.now()) return reply({ error: "Session is not active." }, 409);
      const { error } = await db.from("chat_messages").insert({ id: crypto.randomUUID(), session_id: sessionId, role, content: content.slice(0, 10000) });
      if (error) throw error;
      return reply({ ok: true }, 201);
    }

    return reply({ error: "Unknown action." }, 404);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
  }
});
