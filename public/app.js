const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const serverStatus = $("#serverStatus");
const loginButton = $("#loginButton");
const loginDialog = $("#loginDialog");
const loginForm = $("#loginForm");
const closeLogin = $("#closeLogin");
const launchButton = $("#launchButton");
const launchNote = $("#launchNote");
const chatRuntime = $("#chatRuntime");
const countdown = $("#countdown");
const endButton = $("#endButton");
const emptyState = $("#emptyState");
const messages = $("#messages");
const chatForm = $("#chatForm");
const prompt = $("#prompt");
const sendButton = $("#sendButton");
const chatNote = $("#chatNote");
const chatView = $("#chatView");
const terminalView = $("#terminalView");
const chatModeButton = $("#chatModeButton");
const terminalModeButton = $("#terminalModeButton");
const terminalOutput = $("#terminalOutput");
const terminalForm = $("#terminalForm");
const terminalInput = $("#terminalInput");
const terminalSend = $("#terminalSend");
const terminalNote = $("#terminalNote");

let runtime = "llama.cpp";
let durationMinutes = 1;
let currentSession = null;
let timer = null;
let demoUser = null;
let terminalSocket = null;
let activeView = "chat";

function runtimeLabel(value) {
  if (value === "llama.cpp") return "Ollama";
  if (value === "opencode") return "OpenCode";
  return value;
}

try {
  demoUser = JSON.parse(localStorage.getItem("metrodex_demo_user") || "null");
} catch {
  demoUser = null;
}

function setLoggedInUI() {
  if (demoUser?.name) {
    loginButton.textContent = demoUser.name.split(" ")[0];
    launchNote.textContent = "Ready to launch a temporary compute session.";
  } else {
    loginButton.textContent = "Login";
    launchNote.textContent = "Sign in once, then launch the server.";
  }
}

setLoggedInUI();

loginButton.addEventListener("click", () => loginDialog.showModal());
closeLogin.addEventListener("click", () => loginDialog.close());

loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  demoUser = {
    name: String(form.get("name") || "").trim(),
    email: String(form.get("email") || "").trim(),
  };
  if (!demoUser.name || !demoUser.email) return;
  localStorage.setItem("metrodex_demo_user", JSON.stringify(demoUser));
  loginDialog.close();
  setLoggedInUI();
});

$$(".runtime-option").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".runtime-option").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    runtime = button.dataset.runtime;
  });
});

$$(".duration-option").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".duration-option").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    durationMinutes = Number(button.dataset.minutes);
  });
});

function setStatus(status) {
  serverStatus.textContent = status;
  serverStatus.classList.remove("available", "busy");
  serverStatus.classList.add(status === "BUSY" ? "busy" : "available");
  launchButton.disabled = status === "BUSY";
}

function formatCountdown(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const mins = String(Math.floor(total / 60)).padStart(2, "0");
  const secs = String(total % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function appendTerminal(text) {
  terminalOutput.textContent += text;
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function disconnectTerminal(message = "Terminal disconnected.") {
  if (terminalSocket) {
    terminalSocket.close();
    terminalSocket = null;
  }
  terminalInput.disabled = true;
  terminalSend.disabled = true;
  terminalNote.textContent = message;
}

function connectTerminal() {
  if (!currentSession || terminalSocket) return;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const endpoint = `${protocol}://${location.host}/ws/terminal?sessionId=${encodeURIComponent(currentSession.id)}`;
  terminalOutput.textContent = "Connecting to the session terminal…\n";
  terminalNote.textContent = "Connecting…";
  terminalSocket = new WebSocket(endpoint);

  terminalSocket.addEventListener("open", () => {
    terminalInput.disabled = false;
    terminalSend.disabled = false;
    terminalNote.textContent = "Connected. Try: ollama ps, ollama list, python3, npm, or git.";
    terminalInput.focus();
    terminalSocket.send(JSON.stringify({ type: "resize", cols: 120, rows: 32 }));
  });
  terminalSocket.addEventListener("message", (event) => {
    const raw = String(event.data || "");
    try {
      const message = JSON.parse(raw);
      if (message.type === "ready") {
        appendTerminal(`\r\n[Mero Desk workspace: ${message.cwd}]\r\n`);
        return;
      }
      if (message.type === "error") appendTerminal(`\r\n[terminal error] ${message.message}\r\n`);
      if (message.type === "expired") {
        appendTerminal(`\r\n[${message.message}]\r\n`);
        terminalInput.disabled = true;
        terminalSend.disabled = true;
      }
    } catch {
      appendTerminal(raw);
    }
  });
  terminalSocket.addEventListener("close", () => {
    terminalSocket = null;
    terminalInput.disabled = true;
    terminalSend.disabled = true;
    terminalNote.textContent = "Terminal closed because the session ended.";
  });
  terminalSocket.addEventListener("error", () => {
    terminalNote.textContent = "Terminal connection failed.";
  });
}

function setWorkspaceMode(mode) {
  activeView = mode;
  const terminal = mode === "terminal";
  chatView.classList.toggle("hidden", terminal);
  terminalView.classList.toggle("hidden", !terminal);
  chatModeButton.classList.toggle("active", !terminal);
  terminalModeButton.classList.toggle("active", terminal);
  chatModeButton.setAttribute("aria-selected", String(!terminal));
  terminalModeButton.setAttribute("aria-selected", String(terminal));
  if (terminal && currentSession) connectTerminal();
  if (!terminal) prompt.focus();
}

function renderSession() {
  const running = Boolean(currentSession);
  emptyState.classList.toggle("hidden", running);
  messages.classList.toggle("hidden", !running);
  endButton.classList.toggle("hidden", !running);
  prompt.disabled = !running;
  sendButton.disabled = !running;
  terminalInput.disabled = !running || !terminalSocket;
  terminalSend.disabled = !running || !terminalSocket;

  if (!running) {
    chatRuntime.textContent = "Not running";
    countdown.textContent = "--:--";
    disconnectTerminal("Launch a session to open the terminal.");
    return;
  }

  chatRuntime.textContent = runtimeLabel(currentSession.runtime);
  setStatus("BUSY");
  startTimer();
}

function startTimer() {
  clearInterval(timer);
  const update = () => {
    if (!currentSession) return;
    const remaining = currentSession.expiresAt - Date.now();
    countdown.textContent = formatCountdown(remaining);

    if (remaining <= 0) {
      clearInterval(timer);
      disconnectTerminal("Session expired. The terminal is closed.");
      currentSession = null;
      setStatus("AVAILABLE");
      renderSession();
      launchNote.textContent = "Session expired. The compute node is available again.";
    }
  };
  update();
  timer = setInterval(update, 250);
}

chatModeButton.addEventListener("click", () => setWorkspaceMode("chat"));
terminalModeButton.addEventListener("click", () => setWorkspaceMode("terminal"));

terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const command = terminalInput.value.trim();
  if (!command || !terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) return;
  terminalSocket.send(JSON.stringify({ type: "input", data: `${command}\r` }));
  terminalInput.value = "";
});

function addMessage(role, text) {
  const row = document.createElement("div");
  row.className = `message ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "Y" : "M";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";
  bubble.textContent = text;

  row.append(avatar, bubble);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

launchButton.addEventListener("click", async () => {
  if (!demoUser) {
    loginDialog.showModal();
    return;
  }

  launchButton.disabled = true;
  launchNote.textContent = "Starting compute session...";

  try {
    const response = await fetch("/api/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime,
        durationMinutes,
        userLabel: demoUser.email,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not launch instance.");

    currentSession = data.session;
    messages.replaceChildren();
    addMessage(
      "assistant",
      `Session ready on ${runtimeLabel(currentSession.runtime)}. You have ${currentSession.durationMinutes} minute${currentSession.durationMinutes === 1 ? "" : "s"}.`
    );
    launchNote.textContent = "Compute session is running.";
    chatNote.textContent = "";
    renderSession();
    document.querySelector(".chat-card").scrollIntoView({ behavior: "smooth", block: "start" });
    if (activeView === "terminal") connectTerminal();
    else prompt.focus();
  } catch (error) {
    launchNote.textContent = error.message;
    launchButton.disabled = false;
  }
});

endButton.addEventListener("click", async () => {
  try {
    await fetch("/api/stop", { method: "POST" });
  } finally {
    disconnectTerminal("Session ended. Launch a new session to reopen the terminal.");
    currentSession = null;
    clearInterval(timer);
    setStatus("AVAILABLE");
    renderSession();
    launchNote.textContent = "Session ended. The server is available again.";
  }
});

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentSession) return;

  const text = prompt.value.trim();
  if (!text) return;

  prompt.value = "";
  addMessage("user", text);
  const pending = addMessage("assistant", "Thinking…");
  sendButton.disabled = true;
  chatNote.textContent = "";

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Chat request failed.");

    pending.textContent = data.text;
    if (data.demo) {
      chatNote.textContent = "Runtime is in demo mode until its API/server key is configured.";
    }
  } catch (error) {
    pending.textContent = `Runtime error: ${error.message}`;
  } finally {
    sendButton.disabled = false;
    prompt.focus();
  }
});

async function refreshStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    setStatus(data.server.status);

    const incomingId = data.session?.id || null;
    const currentId = currentSession?.id || null;

    if (incomingId !== currentId) {
      currentSession = data.session;
      renderSession();
    } else if (currentSession) {
      currentSession = data.session;
    }
  } catch {
    // Keep the UI usable if the periodic health check fails.
  }
}

refreshStatus();
setInterval(refreshStatus, 4000);
window.addEventListener("beforeunload", () => terminalSocket?.close());
