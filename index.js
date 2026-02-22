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
const pool = new Pool({
  connectionString: DATABASE_URL
});

/* =======================
   IN-MEMORY STATE
======================= */
const userToServer = new Map();       // userId -> { serverId, lastSeen }
const serverQueues = new Map();       // serverId -> Map(commandId -> command)
const joinCounts = new Map();         // userId -> count

function getQueue(serverId) {
  if (!serverQueues.has(serverId)) {
    serverQueues.set(serverId, new Map());
  }
  return serverQueues.get(serverId);
}

function makeEmbed(color, title, fields = [], options = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setTimestamp(new Date());

  if (fields.length) embed.addFields(fields);
  if (options.footer) embed.setFooter({ text: options.footer });
  if (options.description) embed.setDescription(options.description);

  return embed;
}

/* =======================
   WEBHOOK HELPERS
======================= */
async function sendWebhook(url, embed) {
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] })
  }).catch(() => {});
}

function embed(color, title, fields = []) {
  return {
    title,
    color,
    fields,
    timestamp: new Date().toISOString()
  };
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

client.once("ready", async () => {
  console.log(`🤖 Discord bot logged in as ${client.user.tag}`);

  await sendWebhook(
    DISCORD_HEALTH,
    embed(0x00ff00, "Bot Online", [
      { name: "Status", value: "Ready" }
    ])
  );
});

const PREFIX = "!";

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (!msg.guild) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = msg.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);

  // !help
  if (cmd === "help") {
    return msg.reply({
      embeds: [
        embed(0x5865f2, "📘 Moderation Commands", [
          { name: "!help", value: "Show this menu" },
          { name: "!ban <userid> <reason>", value: "Global ban" },
          { name: "!unban <userid>", value: "Remove global ban" },
          { name: "!warn <userid>", value: "Warn player in-game" },
          { name: "!unwarn <userid>", value: "Stop warning UI" }
        ])
      ]
    });
  }

  // !ban
  if (cmd === "ban") {
    const userId = Number(args[0]);
    const reason = args.slice(1).join(" ") || "Rule violation";
    if (!userId) return msg.reply("Usage: `!ban <userid> <reason>`");

    await pool.query(
      "insert into bans(network_id,user_id,reason,moderator) values ($1,$2,$3,$4) on conflict do update set reason=excluded.reason",
      [NETWORK_ID_DEFAULT, userId, reason, msg.author.tag]
    );

    await sendWebhook(
      DISCORD_WEBHOOK_USERBANS,
      embed(0xff0000, "🔨 User Banned", [
        { name: "User ID", value: String(userId) },
        { name: "Reason", value: reason },
        { name: "Moderator", value: msg.author.tag }
      ])
    );

    return msg.reply(`✅ Banned **${userId}**`);
  }
});


const embed = makeEmbed(0xff5555, "🚨 USER WARNING", [
  {
    name: "👤 Player",
    value:
      "```yaml\n" +
      "Username: testUser\n" +
      "UserId: 123456\n" +
      "```",
    inline: false
  },
  {
    name: "⚠️ Reason",
    value:
      "```fix\n" +
      "Repeated rule violations\n" +
      "```",
    inline: false
  }
], {
  footer: "Roblox Moderation System"
});

makeEmbed(0x55ff88, "✅ WARNING CLEARED", [
  {
    name: "👤 Player",
    value: "```yaml\nUsername: testUser\nUserId: 123456\n```"
  },
  {
    name: "🧹 Action",
    value: "```diff\n- Warning removed\n```"
  }
]);

const rateLimit = new Map();

function limited(key, ms = 3000) {
  const now = Date.now();
  if (rateLimit.get(key) > now) return true;
  rateLimit.set(key, now + ms);
  return false;
}

if (limited(req.ip)) return res.sendStatus(429);

/* =======================
   SLASH COMMANDS
======================= */
const commands = [
  {
    name: "help",
    description: "List all moderation commands"
  },
  {
    name: "ban",
    description: "Globally ban a user",
    options: [
      { name: "userid", type: 4, required: true, description: "Roblox User ID" },
      { name: "reason", type: 3, required: false }
    ]
  },
  {
    name: "unban",
    description: "Remove global ban",
    options: [
      { name: "userid", type: 4, required: true }
    ]
  }
];

/* =======================
   SLASH HANDLER
======================= */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "help") {
    return interaction.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setTitle("📖 Commands")
          .setColor(0x00ffff)
          .setDescription(
            "/help\n" +
            "/ban <userid> [reason]\n" +
            "/unban <userid>"
          )
      ]
    });
  }

  if (commandName === "ban") {
    const userId = interaction.options.getInteger("userid");
    const reason = interaction.options.getString("reason") || "Rule violation";

    await pool.query(
      `insert into bans(network_id,user_id,reason,moderator)
       values ($1,$2,$3,$4)
       on conflict (network_id,user_id)
       do update set reason=$3, banned_at=now()`,
      [NETWORK_ID_DEFAULT, userId, reason, interaction.user.tag]
    );

    await sendWebhook(
      DISCORD_WEBHOOK_USERBANS,
      embed(0xff0000, "⛔ User Banned", [
        { name: "User ID", value: String(userId) },
        { name: "Reason", value: reason },
        { name: "Moderator", value: interaction.user.tag }
      ])
    );

    return interaction.reply({ content: "User banned.", ephemeral: true });
  }

  if (commandName === "unban") {
    const userId = interaction.options.getInteger("userid");

    await pool.query(
      `delete from bans where network_id=$1 and user_id=$2`,
      [NETWORK_ID_DEFAULT, userId]
    );

    await sendWebhook(
      DISCORD_WEBHOOK_USERBANS,
      embed(0x00ff00, "♻️ User Unbanned", [
        { name: "User ID", value: String(userId) }
      ])
    );

    return interaction.reply({ content: "User unbanned.", ephemeral: true });
  }
});

/* =======================
   AUTH MIDDLEWARE
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
app.get("/health", async (_, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

/* =======================
   ROBLOX JOIN / HEARTBEAT
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
      embed(
        count >= 3 ? 0xff0000 : 0x00ffcc,
        count >= 3 ? "🚨 MULTIPLE JOINS DETECTED" : "👤 Player Joined",
        [
          { name: "Username", value: p.username },
          { name: "User ID", value: String(p.userId) },
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
    embed(0x0099ff, "🫀 Heartbeat", [
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
    embed(0x5865f2, "💬 Chat Message", [
      { name: "User", value: `${m.username} (${m.userId})` },
      { name: "Display Name", value: m.displayName || "N/A" },
      { name: "Server", value: m.serverId },
      { name: "Message", value: m.text }
    ])
  );

  res.sendStatus(200);
});

app.post("/roblox/csv", verify, async (req, res) => {
  const { csv } = req.body;

  await fetch(DISCORD_WEBHOOK_CSV, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "📄 CSV Upload",
      files: [{ name: "logs.csv", file: csv }]
    })
  }).catch(() => {});

  res.sendStatus(200);
});

app.post("/roblox/csv", verify, async (req, res) => {
  const { csv } = req.body;

  await fetch(DISCORD_WEBHOOK_CSV, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "📄 CSV Upload",
      files: [{ name: "logs.csv", file: csv }]
    })
  }).catch(() => {});

  res.sendStatus(200);
});

app.post("/roblox/poll-commands", verify, (req, res) => {
  const { serverId } = req.body;
  const q = getQueue(serverId);

  res.json({ commands: [...q.values()] });
});

app.post("/roblox/ack", verify, (req, res) => {
  const { serverId, ids } = req.body;
  const q = getQueue(serverId);

  for (const id of ids) q.delete(id);

  res.json({ ok: true });
});

app.post("/roblox/poll-commands", verify, (req, res) => {
  const { serverId } = req.body;
  const q = getQueue(serverId);

  res.json({ commands: [...q.values()] });
});

app.post("/roblox/ack", verify, (req, res) => {
  const { serverId, ids } = req.body;
  const q = getQueue(serverId);

  for (const id of ids) q.delete(id);

  res.json({ ok: true });
});

app.get("/db/ping", async (_, res) => {
  try {
    await pool.query("select 1");
    await sendWebhook(
      DISCORD_HEALTH,
      embed(0x00ff00, "🟢 DB Ping OK")
    );
    res.send("OK");
  } catch {
    res.status(500).send("FAIL");
  }
});

app.get("/db/ping", async (_, res) => {
  try {
    await pool.query("select 1");
    await sendWebhook(
      DISCORD_HEALTH,
      embed(0x00ff00, "🟢 DB Ping OK")
    );
    res.send("OK");
  } catch {
    res.status(500).send("FAIL");
  }
});

