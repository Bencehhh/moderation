import express from "express";
import crypto from "crypto";
import http from "http";
import { Pool } from "pg";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

/* ===================== ENV ===================== */
const {
  DISCORD_BOT_TOKEN,
  WEBAPP_SHARED_SECRET,
  DISCORD_WEBHOOK_LOGS,
  DISCORD_WEBHOOK_CSV,
  DATABASE_URL,
  MOD_ROLE_NAME = "Moderator",
  NETWORK_ID_DEFAULT = "main",
  PORT = 10000
} = process.env;

if (
  !DISCORD_BOT_TOKEN ||
  !WEBAPP_SHARED_SECRET ||
  !DISCORD_WEBHOOK_LOGS ||
  !DISCORD_WEBHOOK_CSV ||
  !DATABASE_URL
) {
  console.error("❌ Missing required environment variables");
  process.exit(1);
}

/* ===================== EXPRESS ===================== */
const app = express();
app.use(express.json({ limit: "10mb" }));

/* ===================== DATABASE ===================== */
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ===================== MEMORY ===================== */
const userToServer = new Map();        // userId → { serverId, lastSeenMs }
const serverQueues = new Map();        // serverId → Map(cmdId → cmd)
const seenNonces = new Map();

/* ===================== DISCORD ===================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`🤖 Discord bot online as ${client.user.tag}`);
});

/* ===================== HELPERS ===================== */
function auth(req, res, next) {
  if (req.headers.authorization !== WEBAPP_SHARED_SECRET) {
    return res.sendStatus(401);
  }
  next();
}

function getQueue(serverId) {
  if (!serverQueues.has(serverId)) {
    serverQueues.set(serverId, new Map());
  }
  return serverQueues.get(serverId);
}

async function webhook(url, payload) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

/* ===================== HEALTH ===================== */
app.get("/", (_, res) => res.send("OK"));
app.get("/health", (_, res) =>
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) })
);
app.get("/version", (_, res) => res.send("v3-merged"));
app.get("/db/ping", async (_, res) => {
  try {
    await pool.query("select 1");
    res.send("DB OK");
  } catch {
    res.status(500).send("DB FAIL");
  }
});

/* ===================== ROBLOX ===================== */
app.post("/roblox/register-server", auth, (req, res) => {
  const { serverId, players } = req.body;
  const now = Date.now();
  players.forEach(p => {
    userToServer.set(String(p.userId), { serverId, lastSeenMs: now });
  });
  res.sendStatus(200);
});

app.post("/roblox/chat", auth, async (req, res) => {
  const m = req.body;
  await webhook(DISCORD_WEBHOOK_LOGS, {
    content:
`💬 **Chat**
User: ${m.username} (${m.userId})
Display: ${m.displayName}
Server: ${m.serverId}
Message: ${m.text}`
  });
  res.sendStatus(200);
});

/* ===================== BAN CHECK ===================== */
app.post("/ban/check", auth, async (req, res) => {
  const { userId, username, displayName, serverId } = req.body;

  const ban = await pool.query(
    "select reason from bans where network_id=$1 and user_id=$2",
    [NETWORK_ID_DEFAULT, userId]
  );

  await pool.query(
    "insert into join_attempts(network_id,user_id,username,display_name,server_id) values ($1,$2,$3,$4,$5)",
    [NETWORK_ID_DEFAULT, userId, username, displayName, serverId]
  );

  if (ban.rowCount) {
    await webhook(DISCORD_WEBHOOK_LOGS, {
      embeds: [
        new EmbedBuilder()
          .setTitle("🚫 Banned User Join Attempt")
          .addFields(
            { name: "User", value: `${displayName} (${userId})` },
            { name: "Reason", value: ban.rows[0].reason }
          )
          .setTimestamp()
      ]
    });
    return res.json({ banned: true });
  }

  res.json({ banned: false });
});

/* ===================== COMMAND ROUTING ===================== */
app.post("/command", auth, async (req, res) => {
  const { action, userId, reason, moderator } = req.body;
  const entry = userToServer.get(String(userId));

  if (!entry) return res.json({ offline: true });

  const cmd = {
    id: crypto.randomUUID(),
    action,
    userId,
    reason,
    moderator,
    issuedAt: Date.now()
  };

  getQueue(entry.serverId).set(cmd.id, cmd);

  await pool.query(
    "insert into moderation_actions(network_id,action,user_id,reason,moderator) values ($1,$2,$3,$4,$5)",
    [NETWORK_ID_DEFAULT, action, userId, reason, moderator]
  );

  res.json({ routedServerId: entry.serverId });
});

/* ===================== DISCORD COMMANDS ===================== */
client.on("messageCreate", async msg => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith("!")) return;

  const [cmd, userId, ...rest] = msg.content.split(" ");
  const reason = rest.join(" ") || "Rule violation";

  if (!/^\d+$/.test(userId)) return;

  if (cmd === "!ban") {
    await pool.query(
      "insert into bans(network_id,user_id,reason,moderator) values ($1,$2,$3,$4) on conflict do nothing",
      [NETWORK_ID_DEFAULT, userId, reason, msg.author.tag]
    );
    msg.reply(`🚫 Banned ${userId}`);
  }

  if (cmd === "!unban") {
    await pool.query(
      "delete from bans where network_id=$1 and user_id=$2",
      [NETWORK_ID_DEFAULT, userId]
    );
    msg.reply(`✅ Unbanned ${userId}`);
  }
});

/* ===================== START ===================== */
client.login(DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log("🚀 Service running on", PORT));