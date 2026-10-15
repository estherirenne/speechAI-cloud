"use strict";
const express = require("express");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const {
  PORT = 3000,
  DB_HOST = "db",
  DB_PORT = 5432,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  JWT_SECRET,
  OLLAMA_URL = "http://host.docker.internal:11434",
  OLLAMA_MODEL = "llama3.2",
} = process.env;

// ---------- Logging (satu baris JSON per kejadian, tampil di `docker compose logs api`) ----------
function log(level, msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

if (!JWT_SECRET || !DB_NAME || !DB_USER || !DB_PASSWORD) {
  log("fatal", "Missing required environment variables (JWT_SECRET, DB_NAME, DB_USER, DB_PASSWORD)");
  process.exit(1);
}

const pool = new Pool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  max: 10,
  connectionTimeoutMillis: 3000,
});
pool.on("error", (e) => log("error", "idle db client error", { error: e.message }));

// Jalankan fn di dalam satu transaksi dengan app.user_id diisi,
// supaya Row Level Security di PostgreSQL membatasi data ke user ini saja.
async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

function isDbDown(err) {
  const code = String(err && err.code || "");
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN", "ECONNRESET"].includes(code) ||
    code.startsWith("57P") || code.startsWith("08") ||
    /timeout|terminated|ECONN/i.test(String(err && err.message || ""));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEVELS = ["beginner", "intermediate", "advanced"];
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Log tiap request (kecuali /health biar log tidak penuh)
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => {
    const path = req.originalUrl.split("?")[0];
    if (path === "/health") return;
    log("info", "request", { method: req.method, path, status: res.statusCode, ms: Date.now() - t, user: req.user && req.user.username });
  });
  next();
});

// ---------- Health check ----------
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up" });
  } catch (e) {
    log("error", "health check failed: database down", { error: e.message });
    res.status(503).json({ status: "degraded", db: "down" });
  }
});

// ---------- Auth ----------
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Login required" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

function validCredentials(body) {
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return { error: "Username must be 3-30 characters: letters, numbers, underscore" };
  if (password.length < 6 || password.length > 100) return { error: "Password must be 6-100 characters" };
  return { username, password };
}

const sign = (u) => jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: "12h" });

app.post("/api/register", ah(async (req, res) => {
  const v = validCredentials(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const r = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, crypt($2, gen_salt('bf'))) RETURNING id, username",
      [v.username, v.password]
    );
    res.status(201).json({ token: sign(r.rows[0]), username: r.rows[0].username });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Username already taken" });
    throw e;
  }
}));

app.post("/api/login", ah(async (req, res) => {
  const v = validCredentials(req.body || {});
  if (v.error) return res.status(400).json({ error: v.error });
  const r = await pool.query(
    "SELECT id, username FROM users WHERE username = $1 AND password_hash = crypt($2, password_hash)",
    [v.username, v.password]
  );
  if (!r.rowCount) return res.status(401).json({ error: "Wrong username or password" });
  res.json({ token: sign(r.rows[0]), username: r.rows[0].username });
}));

// ---------- Chats (CRUD) ----------
// Catatan: query di bawah sengaja TIDAK memakai "WHERE user_id = ...".
// Pembatasan per-user dikerjakan oleh RLS di database.
app.get("/api/chats", auth, ah(async (req, res) => {
  const r = await withUser(req.user.id, (c) =>
    c.query("SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC LIMIT 50"));
  res.json(r.rows);
}));

app.post("/api/chats", auth, ah(async (req, res) => {
  let title = "New chat";
  if (req.body && req.body.title !== undefined) {
    title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    if (!title || title.length > 100) return res.status(400).json({ error: "Title must be 1-100 characters" });
  }
  const r = await withUser(req.user.id, (c) =>
    c.query("INSERT INTO chats (user_id, title) VALUES ($1, $2) RETURNING id, title, updated_at", [req.user.id, title]));
  res.status(201).json(r.rows[0]);
}));

app.get("/api/chats/:id", auth, ah(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid chat id" });
  const out = await withUser(req.user.id, async (c) => {
    const chat = await c.query("SELECT id, title, updated_at FROM chats WHERE id = $1", [req.params.id]);
    if (!chat.rowCount) return null;
    const msgs = await c.query("SELECT id, role, content, created_at FROM messages WHERE chat_id = $1 ORDER BY id", [req.params.id]);
    return { ...chat.rows[0], messages: msgs.rows };
  });
  if (!out) return res.status(404).json({ error: "Chat not found" });
  res.json(out);
}));

app.patch("/api/chats/:id", auth, ah(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid chat id" });
  const title = req.body && typeof req.body.title === "string" ? req.body.title.trim() : "";
  if (!title || title.length > 100) return res.status(400).json({ error: "Title must be 1-100 characters" });
  const r = await withUser(req.user.id, (c) =>
    c.query("UPDATE chats SET title = $1, updated_at = now() WHERE id = $2 RETURNING id, title, updated_at", [title, req.params.id]));
  if (!r.rowCount) return res.status(404).json({ error: "Chat not found" });
  res.json(r.rows[0]);
}));

app.delete("/api/chats/:id", auth, ah(async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Invalid chat id" });
  const n = await withUser(req.user.id, async (c) => {
    await c.query("DELETE FROM messages WHERE chat_id = $1", [req.params.id]);
    const r = await c.query("DELETE FROM chats WHERE id = $1", [req.params.id]);
    return r.rowCount;
  });
  if (!n) return res.status(404).json({ error: "Chat not found" });
  res.status(204).end();
}));

// ---------- Kirim pesan & minta balasan AI ----------
async function askOllama(messages, level, topic) {
  const system = `You are a friendly English conversation partner for an Indonesian learner at ${level} level.
Rules:
- Reply in 1-3 short sentences, natural spoken English, no lists, no emojis.
- Always end with one easy follow-up question so the learner keeps talking.
- If the learner made a grammar or word-choice mistake, add a new final line starting with "Fix:" that shows the corrected sentence and a very short reason. If there was no mistake, do not add a Fix line.
- Never write in Indonesian unless the learner is clearly stuck, then give one short hint.
${topic ? "- Conversation topic: " + topic + "." : "- Start with small talk if there is no topic."}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, messages: [{ role: "system", content: system }, ...messages] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error("Ollama replied " + r.status);
    const data = await r.json();
    return String(data.message.content).trim();
  } finally {
    clearTimeout(timer);
  }
}

app.post("/api/chats/:id/messages", auth, ah(async (req, res) => {
  const id = req.params.id;
  if (!UUID_RE.test(id)) return res.status(400).json({ error: "Invalid chat id" });

  const body = req.body || {};
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) return res.status(400).json({ error: "Message cannot be empty" });
  if (content.length > 2000) return res.status(400).json({ error: "Message is too long (max 2000 characters)" });
  const level = LEVELS.includes(body.level) ? body.level : "intermediate";
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 100) : "";

  // 1) ambil riwayat (RLS memastikan chat ini milik user)
  const past = await withUser(req.user.id, async (c) => {
    const chat = await c.query("SELECT id FROM chats WHERE id = $1", [id]);
    if (!chat.rowCount) return null;
    const m = await c.query("SELECT role, content FROM messages WHERE chat_id = $1 ORDER BY id DESC LIMIT 12", [id]);
    return m.rows.reverse();
  });
  if (!past) return res.status(404).json({ error: "Chat not found" });

  // 2) minta balasan ke Ollama (di luar transaksi DB)
  let reply;
  try {
    reply = await askOllama([...past, { role: "user", content }], level, topic);
  } catch (e) {
    log("error", "ollama request failed", { error: e.message, url: OLLAMA_URL });
    return res.status(502).json({ error: "AI service is unavailable. Is Ollama running?" });
  }

  // 3) simpan pesan user + balasan AI
  await withUser(req.user.id, async (c) => {
    await c.query(
      "INSERT INTO messages (chat_id, user_id, role, content) VALUES ($1::uuid, $2::uuid, 'user', $3), ($1::uuid, $2::uuid, 'assistant', $4)",
      [id, req.user.id, content, reply]
    );
    await c.query(
      "UPDATE chats SET title = CASE WHEN title = 'New chat' THEN left($2::text, 50) ELSE title END, updated_at = now() WHERE id = $1::uuid",
      [id, content]
    );
  });
  res.json({ reply });
}));

// ---------- 404 & error handler ----------
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.status && err.status < 500) return res.status(err.status).json({ error: "Bad request" });
  if (isDbDown(err)) {
    log("error", "database unavailable", { error: err.message, code: err.code });
    return res.status(503).json({ error: "Database unavailable. Please try again in a moment." });
  }
  log("error", "unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, () => log("info", "api started", { port: Number(PORT), ollama: OLLAMA_URL, model: OLLAMA_MODEL }));

function shutdown(sig) {
  log("info", "shutting down", { signal: sig });
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
