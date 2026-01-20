import express from "express";
import crypto from "crypto";
import { Pool } from "pg";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ===== ENV =====

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BOT_INTERNAL_URL = process.env.BOT_INTERNAL_URL;
const BOT_INTERNAL_SECRET = process.env.BOT_INTERNAL_SECRET;
const NETWORK_ID_DEFAULT = process.env.NETWORK_ID_DEFAULT || "";
const WEBAPP_SHARED_SECRET = process.env.WEBAPP_SHARED_SECRET;
const DISCORD_WEBHOOK_LOGS = process.env.DISCORD_WEBHOOK_LOGS;
const DISCORD_WEBHOOK_CSV = process.env.DISCORD_WEBHOOK_CSV;

if (!WEBAPP_SHARED_SECRET || !DISCORD_WEBHOOK_LOGS || !DISCORD_WEBHOOK_CSV) {
  console.error("Missing env vars: WEBAPP_SHARED_SECRET, DISCORD_WEBHOOK_LOGS, DISCORD_WEBHOOK_CSV");
  process.exit(1);
}

// userId -> { serverId, lastSeenMs }
const userToServer = new Map();

// serverId -> Map(commandId -> commandObj)
const serverQueues = new Map();

// GLOBAL moderation actions for offline users (in-memory)
const globalActions = new Map(); 
// userId -> { type:"ban"|"unban", reason, moderator, timestamp }

const seenNonces = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [nonce, exp] of seenNonces.entries()) if (exp <= now) seenNonces.delete(nonce);
}, 30_000).unref();

function verify(req, res, next) {
  const auth = req.headers.authorization || "";
  if (auth !== WEBAPP_SHARED_SECRET) return res.sendStatus(401);

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

async function botLog(type, payload) {
  if (!BOT_INTERNAL_URL) return;
  try {
    await fetch(`${BOT_INTERNAL_URL}/internal/log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": BOT_INTERNAL_SECRET
      },
      body: JSON.stringify({ type, payload })
    });
  } catch (e) {
    console.error("Failed to notify bot:", e);
  }
}

// ===== Health =====
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptimeSeconds: Math.floor(process.uptime()) });
});
app.get("/", (req, res) => res.send("OK"));
// database ping
app.get("/db/ping", async (req, res) => {
  try {
    await pool.query("select 1");
    res.status(200).send("DB OK");
  } catch (e) {
    res.status(500).send("DB FAIL");
  }
});


// ===== WHOIS (for !whereis) =====
app.get("/whois/:userId", verify, (req, res) => {
  const userId = String(req.params.userId || "");
  const entry = userToServer.get(userId);
  if (!entry) return res.status(404).json({ error: "not_found" });
  res.json({ userId, serverId: entry.serverId, lastSeenMs: entry.lastSeenMs });
});

// ===== Roblox -> Webapp =====
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

app.post("/roblox/heartbeat", verify, async (req, res) => {
  const b = req.body || {};
  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `🫀 Heartbeat | server **${b.serverId}** | players **${b.playersCount}** | uptime **${b.uptime}s** | <t:${b.timestamp}:F>`
  );
  res.sendStatus(200);
});

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

app.post("/roblox/csv", verify, async (req, res) => {
  const { serverId, csv, timestamp } = req.body || {};
  if (typeof csv !== "string") return res.status(400).json({ error: "csv missing" });

  await discordSendCsv(DISCORD_WEBHOOK_CSV, csv);
  await discordSendMessage(DISCORD_WEBHOOK_LOGS, `📄 CSV uploaded from server **${serverId}** | <t:${timestamp}:F>`);
  res.sendStatus(200);
});

// Roblox polls commands for its server
app.post("/roblox/poll-commands", verify, (req, res) => {
  const { serverId } = req.body || {};
  if (!serverId) return res.status(400).json({ error: "Missing serverId" });

  const q = getQueue(serverId);
  const commands = Array.from(q.values()).slice(0, 25);

  res.json({ commands });
});

// Roblox ACKs server commands
app.post("/roblox/ack", verify, (req, res) => {
  const { serverId, ackIds } = req.body || {};
  if (!serverId || !Array.isArray(ackIds)) return res.status(400).json({ error: "Bad payload" });

  const q = getQueue(serverId);
  for (const id of ackIds) q.delete(String(id));

  res.json({ ok: true, remaining: q.size });
});

// ===== NEW: Roblox checks for offline ban/unban when a player joins =====
// Roblox calls: POST /roblox/global-action { userId }
app.post("/roblox/global-action", verify, (req, res) => {
  const userId = String(req.body?.userId || "");
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const action = globalActions.get(userId);
  if (!action) return res.json({ action: null });

  // One-time delivery, then remove
  globalActions.delete(userId);
  res.json({ action });
});
app.post("/ban/check", verify, async (req, res) => {
  const b = req.body || {};
  const networkId = String(b.networkId || NETWORK_ID_DEFAULT || "");
  const userId = Number(b.userId);

  if (!networkId || !Number.isFinite(userId)) return res.status(400).json({ error: "bad_payload" });

  const ban = await pool.query(
    "select reason, moderator, banned_at from bans where network_id=$1 and user_id=$2",
    [networkId, userId]
  );

  // log join attempt
  await pool.query(
    "insert into join_attempts(network_id,user_id,username,display_name,place_id,universe_id,server_id) values ($1,$2,$3,$4,$5,$6,$7)",
    [networkId, userId, b.username || null, b.displayName || null, b.placeId || null, b.universeId || null, b.serverId || null]
  );

  if (ban.rowCount > 0) {
    const row = ban.rows[0];

    // tell Discord bot to post an embed
    await botLog("banned_join_attempt", {
      networkId,
      userId,
      username: b.username,
      displayName: b.displayName,
      placeId: b.placeId,
      universeId: b.universeId,
      serverId: b.serverId,
      reason: row.reason,
      moderator: row.moderator,
      bannedAt: row.banned_at
    });

    return res.json({ banned: true, reason: row.reason });
  }

  res.json({ banned: false });
});

app.post("/ban/add", verify, async (req, res) => {
  const networkId = String(req.body?.networkId || NETWORK_ID_DEFAULT || "");
  const userId = Number(req.body?.userId);
  const reason = String(req.body?.reason || "Rule violation");
  const moderator = String(req.body?.moderator || "Discord");

  if (!networkId || !Number.isFinite(userId)) return res.status(400).json({ error: "bad_payload" });

  await pool.query(
    "insert into bans(network_id,user_id,reason,moderator) values ($1,$2,$3,$4) on conflict (network_id,user_id) do update set reason=excluded.reason, moderator=excluded.moderator, banned_at=now()",
    [networkId, userId, reason, moderator]
  );

  res.json({ ok: true });
});

app.post("/ban/remove", verify, async (req, res) => {
  const networkId = String(req.body?.networkId || NETWORK_ID_DEFAULT || "");
  const userId = Number(req.body?.userId);

  if (!networkId || !Number.isFinite(userId)) return res.status(400).json({ error: "bad_payload" });

  await pool.query("delete from bans where network_id=$1 and user_id=$2", [networkId, userId]);
  res.json({ ok: true });
});

// ===== Discord bot -> Webapp =====
app.post("/command", verify, async (req, res) => {
  const { action, userId, reason, moderator, imageA, imageB, interval } = req.body || {};
  if (!action || !userId) return res.status(400).json({ error: "Missing action/userId" });

  const userIdStr = String(userId);

  // Actions that can be handled even if user is offline (via global queue)
  if (action === "kick") {
    // store global ban so it applies even if user isn't currently mapped
    globalActions.set(userIdStr, {
      type: "ban",
      reason: String(reason || "Rule violation"),
      moderator: String(moderator || "Discord"),
      timestamp: Math.floor(Date.now() / 1000)
    });
  } else if (action === "unban") {
    globalActions.set(userIdStr, {
      type: "unban",
      reason: String(reason || "Unbanned"),
      moderator: String(moderator || "Discord"),
      timestamp: Math.floor(Date.now() / 1000)
    });
  }

  // If user is currently in a server, route the command there too (for immediate action)
  const entry = userToServer.get(userIdStr);

  if (!entry) {
    // For warn/unwarn we require live mapping (must target a server)
    if (action === "warn" || action === "unwarn") {
      return res.status(404).json({ error: "User not found in any active server" });
    }

    // For kick/unban we can accept offline
    await discordSendMessage(
      DISCORD_WEBHOOK_LOGS,
      `🛡️ Queued **${action}** for user **${userIdStr}** (offline/global)`
    );
    return res.json({ ok: true, routedServerId: null, offline: true });
  }

  if (Date.now() - entry.lastSeenMs > 2 * 60 * 1000) {
    // same logic: warn/unwarn needs fresh mapping
    if (action === "warn" || action === "unwarn") {
      return res.status(404).json({ error: "User mapping stale; user may have left" });
    }
  }

  const cmd = {
    id: crypto.randomUUID(),
    action: String(action),
    userId: Number(userId),
    reason: String(reason || ""),
    moderator: String(moderator || "Discord"),
    issuedAt: Math.floor(Date.now() / 1000),
    serverId: entry.serverId
  };

  if (cmd.action === "warn") {
    cmd.imageA = String(imageA || "WARNING_A");
    cmd.imageB = String(imageB || "WARNING_B");
    cmd.interval = Number(interval || 0.35);
  }

  const q = getQueue(entry.serverId);
  q.set(cmd.id, cmd);

  await discordSendMessage(
    DISCORD_WEBHOOK_LOGS,
    `🛡️ Queued **${cmd.action}** for user **${cmd.userId}** → server **${cmd.serverId}** (id: ${cmd.id})`
  );

  res.json({ ok: true, routedServerId: cmd.serverId, commandId: cmd.id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Webapp running on", PORT));
