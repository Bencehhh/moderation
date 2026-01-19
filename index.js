import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ===== ENV VARS (set on Render) =====
const WEBAPP_SHARED_SECRET = process.env.WEBAPP_SHARED_SECRET; // long random string
const DISCORD_WEBHOOK_LOGS = process.env.DISCORD_WEBHOOK_LOGS;
const DISCORD_WEBHOOK_CSV = process.env.DISCORD_WEBHOOK_CSV;

if (!WEBAPP_SHARED_SECRET || !DISCORD_WEBHOOK_LOGS || !DISCORD_WEBHOOK_CSV) {
  console.error("Missing env vars: WEBAPP_SHARED_SECRET, DISCORD_WEBHOOK_LOGS, DISCORD_WEBHOOK_CSV");
  process.exit(1);
}

// ===== In-memory maps (use Redis/Postgres later if you want persistence) =====
// userId -> { serverId, lastSeenMs }
const userToServer = new Map();

// serverId -> Map(commandId -> commandObj)  (reliable: only delete after ACK)
const serverQueues = new Map();

// simple replay protection via nonce (optional but included)
const seenNonces = new Map(); // nonce -> expireMs
setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of seenNonces.entries()) {
    if (exp <= now) seenNonces.delete(nonce);
  }
}, 30_000).unref();

function verify(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== WEBAPP_SHARED_SECRET) return res.sendStatus(401);

  // Optional anti-replay (we allow missing for easier dev)
  const nonce = req.headers["x-nonce"];
  const ts = req.headers["x-ts"];
  if (nonce && ts) {
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return res.status(400).json({ error: "Bad x-ts" });

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > 60) return res.status(401).json({ error: "Stale timestamp" });

    if (seenNonces.has(nonce)) return res.status(401).json({ error: "Replay detected" });
    seenNonces.set(nonce, Date.now() + 2 * 60 * 1000);
  }

  next();
}

function getQueue(serverId) {
  if (!serverQueues.has(serverId)) serverQueues.set(serverId, new Map());
  return serverQueues.get(serverId);
}

async function discordSendMessage(webhookUrl, content) {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("Discord webhook failed:", resp.status, t);
    }
  } catch (e) {
    console.error("Discord webhook error:", e);
  }
}

async function discordSendCsv(webhookUrl, csvText) {
  try {
    // Node 18+ supports FormData + Blob
    if (typeof FormData === "undefined" || typeof Blob === "undefined") {
      const preview = csvText.slice(0, 1800);
      await discordSendMessage(webhookUrl, `📄 CSV (preview)\n\`\`\`\n${preview}\n\`\`\``);
      return;
    }

    const form = new FormData();
    form.append("content", "📄 CSV Logs (last 10 minutes)");
    form.append("file", new Blob([csvText], { type: "text/csv" }), "logs.csv");

    const resp = await fetch(webhookUrl, { method: "POST", body: form });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("Discord CSV upload failed:", resp.status, t);
    }
  } catch (e) {
    console.error("Discord CSV upload error:", e);
  }
}

// ===== ROUTES =====

// Roblox server registers player list every 60s
// Body: { serverId, placeId, timestamp, players:[{userId, username}] }
app.post("/roblox/register-server", verify, async (req, res) => {
  const { serverId, players, timestamp } = req.body || {};
  if (!serverId || !Array.isArray(players)) return res.status(400).json({ error: "Bad payload" });

  const now = Date.now();
  for (const p of players) {
    if (!p?.userId) continue;
    userToServer.set(String(p.userId), { serverId, lastSeenMs: now });
  }

  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `🟢 Server update: **${serverId}** | players: **${players.length}** | <t:${timestamp}:F>`
  );

  res.sendStatus(200);
});

// Heartbeat every 5 minutes
// Body: { serverId, uptime, playersCount, timestamp }
app.post("/roblox/heartbeat", verify, async (req, res) => {
  const b = req.body || {};
  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `🫀 Heartbeat | server **${b.serverId}** | players **${b.playersCount}** | uptime **${b.uptime}s** | <t:${b.timestamp}:F>`
  );
  res.sendStatus(200);
});

// Chat log (filtered output)
// Body: { serverId, userId, username, channel, text, hasHashtags, wasLikelyFiltered, timestamp }
app.post("/roblox/chat", verify, async (req, res) => {
  const m = req.body || {};
  const tag = m.wasLikelyFiltered ? "⚠️ Filtered/Hashtags" : "OK";

  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `💬 **Chat** (${tag})
User: ${m.username} (${m.userId})
Channel: ${m.channel}
Server: ${m.serverId}
Message: ${m.text}
Time: <t:${m.timestamp}:F>`
  );
  res.sendStatus(200);
});

// Optional: chat flag events (spam, too many filtered messages, etc.)
// Body: { serverId, userId, username, reason, timestamp }
app.post("/roblox/chat-flag", verify, async (req, res) => {
  const f = req.body || {};
  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `🚩 **Chat Flag**
User: ${f.username} (${f.userId})
Reason: ${f.reason}
Server: ${f.serverId}
Time: <t:${f.timestamp}:F>`
  );
  res.sendStatus(200);
});

// CSV upload every 10 minutes
// Body: { serverId, csv, timestamp }
app.post("/roblox/csv", verify, async (req, res) => {
  const { serverId, csv, timestamp } = req.body || {};
  if (typeof csv !== "string") return res.status(400).json({ error: "csv missing" });

  await discordSendCsv(DISCORD_WEBHOOK_CSV, csv);
  await discordSendMessage(DISCORD_WEBHOOK_LOGS, `📄 CSV uploaded from server **${serverId}** | <t:${timestamp}:F>`);
  res.sendStatus(200);
});

// Discord bot creates a command
// Body: { action:"warn", userId:"123", reason:"...", imageKey:"WARNING_1" }
app.post("/command", verify, async (req, res) => {
  const { action, userId, reason, imageKey } = req.body || {};
  if (!action || !userId) return res.status(400).json({ error: "Missing action/userId" });

  const entry = userToServer.get(String(userId));
  if (!entry) return res.status(404).json({ error: "User not found in any active server" });

  if (Date.now() - entry.lastSeenMs > 2 * 60 * 1000) {
    return res.status(404).json({ error: "User mapping stale; user may have left" });
  }

  const cmd = {
    id: crypto.randomUUID(),
    action: String(action),
    userId: Number(userId),
    reason: String(reason || ""),
    imageKey: String(imageKey || "DEFAULT"),
    issuedAt: Math.floor(Date.now() / 1000),
    serverId: entry.serverId
  };

  const q = getQueue(entry.serverId);
  q.set(cmd.id, cmd);

  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `🛡️ Queued **${cmd.action}** for user **${cmd.userId}** → server **${cmd.serverId}** (id: ${cmd.id})`
  );

  res.json({ ok: true, routedServerId: cmd.serverId, commandId: cmd.id });
});

// Roblox polls its queue (every ~3 seconds)
// Body: { serverId, timestamp }
app.post("/roblox/poll-commands", verify, (req, res) => {
  const { serverId } = req.body || {};
  if (!serverId) return res.status(400).json({ error: "Missing serverId" });

  const q = getQueue(serverId);
  const commands = Array.from(q.values()).slice(0, 25);

  res.json({ commands });
});

// Roblox ACKs executed commands (reliable)
app.post("/roblox/ack", verify, (req, res) => {
  const { serverId, ackIds } = req.body || {};
  if (!serverId || !Array.isArray(ackIds)) return res.status(400).json({ error: "Bad payload" });

  const q = getQueue(serverId);
  for (const id of ackIds) q.delete(String(id));

  res.json({ ok: true, remaining: q.size });
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Webapp running on", PORT));
