import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import { Pool } from "pg";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
} from "discord.js";

/* =======================
   ENV
======================= */
const {
  PORT = 10000,
  DATABASE_URL,
  WEBAPP_SHARED_SECRET,

  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  GUILD_ID,

  DISCORD_WEBHOOK_LOGS,
  DISCORD_WEBHOOK_CSV,
  DISCORD_WEBHOOK_USERBANS,
  DISCORD_HEALTH,

  NETWORK_ID_DEFAULT = "global"
} = process.env;

if (!DATABASE_URL || !DISCORD_TOKEN || !DISCORD_CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

/* =======================
   EXPRESS
======================= */
const app = express();
app.use(express.json({ limit: "10mb" }));

/* =======================
   DATABASE
======================= */
const pool = new Pool({ connectionString: DATABASE_URL });

/* =======================
   IN-MEMORY STATE
======================= */
const userToServer = new Map();
const serverQueues = new Map();
const joinCounts = new Map();

function getQueue(serverId) {
  if (!serverQueues.has(serverId)) {
    serverQueues.set(serverId, new Map());
  }
  return serverQueues.get(serverId);
}

function enqueueCommand(serverId, command) {
  const q = getQueue(serverId);
  q.set(command.id, command);
}

const entry = userToServer.get(String(userId));

if (entry) {
  enqueueCommand(entry.serverId, {
    id: crypto.randomUUID(),
    action: "ban",
    userId,
    reason,
    moderator: msg.author.tag,
    issuedAt: Math.floor(Date.now() / 1000)
  });
}

if (entry) {
  enqueueCommand(entry.serverId, {
    id: crypto.randomUUID(),
    action: "warn",
    userId,
    reason,
    moderator: msg.author.tag,
    issuedAt: Math.floor(Date.now() / 1000)
  });
}
if (entry) {
  enqueueCommand(entry.serverId, {
    id: crypto.randomUUID(),
    action: "unwarn",
    userId,
    reason,
    moderator: msg.author.tag,
    issuedAt: Math.floor(Date.now() / 1000)
  });
}
if (entry) {
  enqueueCommand(entry.serverId, {
    id: crypto.randomUUID(),
    action: "kick",
    userId,
    reason,
    moderator: msg.author.tag,
    issuedAt: Math.floor(Date.now() / 1000)
  });
}
if (entry) {
  enqueueCommand(entry.serverId, {
    id: crypto.randomUUID(),
    action: "unban",
    userId,
    reason,
    moderator: msg.author.tag,
    issuedAt: Math.floor(Date.now() / 1000)
  });
}

/* =======================
   EMBED HELPERS (SINGLE SOURCE)
======================= */
function makeEmbed(color, title, fields = [], options = {}) {
  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp(new Date());

  if (fields.length) e.addFields(fields);
  if (options.footer) e.setFooter({ text: options.footer });
  if (options.description) e.setDescription(options.description);

  return e;
}

/* =======================
   WEBHOOK SEND
======================= */
async function sendWebhook(url, embed) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch {}
}

/* =======================
   DISCORD BOT
======================= */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

const PREFIX = "!";

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await sendWebhook(
    DISCORD_HEALTH,
    makeEmbed(0x00ff00, "🟢 Bot Online", [
      { name: "Status", value: "Ready" }
    ])
  );
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.guild) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);

  if (cmd === "help") {
    return msg.reply({
      embeds: [
        makeEmbed(0x5865f2, "📘 Moderation Commands", [
          { name: "!help", value: "Show this menu" },
          { name: "!ban <userid> <reason>", value: "Global ban" },
          { name: "!unban <userid>", value: "Remove global ban" },
          { name: "!warn <userid>", value: "Warn player in-game" },
          { name: "!unwarn <userid>", value: "Stop warning UI" }
        ])
      ]
    });
  }

  if (cmd === "ban") {
    const userId = Number(args[0]);
    const reason = args.slice(1).join(" ") || "Rule violation";
    if (!userId) return msg.reply("Usage: `!ban <userid> <reason>`");

    await pool.query(
      `insert into bans(network_id,user_id,reason,moderator)
       values ($1,$2,$3,$4)
       on conflict (network_id,user_id)
       do update set reason=$3, banned_at=now()`,
      [NETWORK_ID_DEFAULT, userId, reason, msg.author.tag]
    );

    await sendWebhook(
      DISCORD_WEBHOOK_USERBANS,
      makeEmbed(0xff0000, "🔨 USER BANNED", [
        { name: "User ID", value: String(userId) },
        { name: "Reason", value: reason },
        { name: "Moderator", value: msg.author.tag }
      ], { footer: "Stored in database" })
    );

    return msg.reply(`✅ Banned **${userId}**`);
  }
});

/* =======================
   AUTH
======================= */
function verify(req, res, next) {
  if (req.headers.authorization !== WEBAPP_SHARED_SECRET) {
    return res.sendStatus(401);
  }
  next();
}

/* =======================
   HEALTH
======================= */
app.get("/health", (_, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

/* =======================
   ROBLOX ROUTES
======================= */
app.post("/roblox/register-server", verify, async (req, res) => {
  const { serverId, players } = req.body;
  const now = Date.now();

  for (const p of players) {
    userToServer.set(String(p.userId), { serverId, lastSeen: now });
    const count = (joinCounts.get(p.userId) || 0) + 1;
    joinCounts.set(p.userId, count);

    await sendWebhook(
      DISCORD_WEBHOOK_LOGS,
      makeEmbed(
        count >= 3 ? 0xff3333 : 0x55ffcc,
        count >= 3 ? "🚨 REPEATED JOINS" : "➡️ PLAYER JOINED",
        [
          { name: "Player", value: `\`\`\`yaml\n${p.username}\n${p.userId}\n\`\`\`` },
          { name: "Server", value: serverId },
          { name: "Join Count", value: String(count) }
        ]
      )
    );
  }

  res.sendStatus(200);
});

app.post("/roblox/heartbeat", verify, async (req, res) => {
  const { serverId, players, uptime } = req.body;

  await sendWebhook(
    DISCORD_WEBHOOK_LOGS,
    makeEmbed(0x00c3ff, "🫀 SERVER HEARTBEAT", [
      { name: "Server", value: serverId },
      { name: "Players", value: String(players) },
      { name: "Uptime", value: `${uptime}s` }
    ])
  );

  res.sendStatus(200);
});

app.post("/roblox/chat", verify, async (req, res) => {
  const m = req.body;

  await sendWebhook(
    DISCORD_WEBHOOK_LOGS,
    makeEmbed(0x5865f2, "💬 CHAT MESSAGE", [
      { name: "Player", value: `${m.username} (${m.userId})` },
      { name: "Server", value: m.serverId },
      { name: "Message", value: `\`\`\`\n${m.text}\n\`\`\`` }
    ])
  );

  res.sendStatus(200);
});

/* =======================
   COMMAND QUEUE
======================= */
app.post("/roblox/poll-commands", verify, (req, res) => {
  const { serverId } = req.body;
  res.json({ commands: [...getQueue(serverId).values()] });
});

app.post("/roblox/ack", verify, (req, res) => {
  const { serverId, ids } = req.body;
  const q = getQueue(serverId);
  for (const id of ids) q.delete(id);
  res.json({ ok: true });
});

/* =======================
   DB PING
======================= */
app.get("/db/ping", async (_, res) => {
  try {
    await pool.query("select 1");
    await sendWebhook(DISCORD_HEALTH, makeEmbed(0x00ff00, "🟢 DB OK"));
    res.send("OK");
  } catch {
    res.status(500).send("FAIL");
  }
});

/* =======================
   START
======================= */
app.listen(PORT, () => {
  console.log("🚀 Service running on port", PORT);
});

client.login(DISCORD_TOKEN);