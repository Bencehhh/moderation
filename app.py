import cmd
import os
import time
import uuid
import asyncio
from typing import Dict, List

import httpx
import psycopg
from fastapi import FastAPI, Request, Header, HTTPException 
from fastapi.responses import JSONResponse

import discord 
from discord import Embed 

# =====================
# ENV
# =====================
PORT = int(os.getenv("PORT", "10000"))
DATABASE_URL = os.getenv("DATABASE_URL")
WEBAPP_SHARED_SECRET = os.getenv("WEBAPP_SHARED_SECRET")

DISCORD_TOKEN = os.getenv("DISCORD_TOKEN")
DISCORD_WEBHOOK_LOGS = os.getenv("DISCORD_WEBHOOK_LOGS")
DISCORD_WEBHOOK_CSV = os.getenv("DISCORD_WEBHOOK_CSV")
DISCORD_WEBHOOK_USERBANS = os.getenv("DISCORD_WEBHOOK_USERBANS")
DISCORD_HEALTH = os.getenv("DISCORD_HEALTH")

NETWORK_ID = os.getenv("NETWORK_ID_DEFAULT", "global")

PREFIX = "!"

# =====================
# APP + DB
# =====================
app = FastAPI()
db = psycopg.connect(DATABASE_URL)

# =====================
# IN-MEMORY STATE
# =====================
user_to_server: Dict[int, dict] = {}
server_queues: Dict[str, Dict[str, dict]] = {}
join_counts: Dict[int, int] = {}

# =====================
# HELPERS
# =====================
async def send_webhook(url: str, embed: Embed):
    if not url:
        return
    async with httpx.AsyncClient() as c:
        await c.post(url, json={"embeds": [embed.to_dict()]})

def make_embed(color, title, fields):
    e = Embed(title=title, color=color)
    for f in fields:
        e.add_field(name=f["name"], value=f["value"], inline=f.get("inline", False))
    e.timestamp = discord.utils.utcnow()
    return e

def verify(req: Request):
    auth = (
        req.headers.get("authorization")
        or req.headers.get("Authorization")
    )

    if not auth:
        print("❌ Missing Authorization header")
        raise HTTPException(401)

    if auth.strip() != WEBAPP_SHARED_SECRET.strip():
        print("❌ Invalid Authorization:", auth)
        raise HTTPException(401)



def get_queue(server_id: str):
    if server_id not in server_queues:
        server_queues[server_id] = {}
    return server_queues[server_id]

# =====================
# DISCORD BOT
# =====================
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    await send_webhook(
        DISCORD_HEALTH,
        make_embed(0x00FF00, "🟢 Bot Online", [
            {"name": "Status", "value": "Running"}
        ])
    )
    print("Bot ready")

# =========================
# BAN (REWRITTEN - STABLE)
# =========================
@client.event
async def on_message(msg: discord.Message):
    if msg.author.bot or not msg.content.startswith(PREFIX):
        return

    parts = msg.content[len(PREFIX):].split()
    cmd = parts[0].lower()
    args = parts[1:]

    print("📩 Command received:", cmd, "Args:", args)

    # ----------------
    # HELP
    # ----------------
    if cmd == "help":
        await msg.reply(embed=make_embed(0x5865F2, "📘 Commands", [
            {"name": "!help", "value": "Show this menu"},
            {"name": "!warn <userid> <reason>", "value": "Warn player"},
            {"name": "!unwarn <userid>", "value": "Clear warning"},
            {"name": "!kick <userid> <reason>", "value": "Kick from server"},
            {"name": "!ban <userid> <reason>", "value": "Global ban"},
            {"name": "!unban <userid>", "value": "Remove global ban"},
            {"name": "!forceteleport <userid> <placeid>", "value": "Force teleport user"}
        ]))
        return

    if not args:
        await msg.reply("⚠️ Missing arguments.")
        return

    # ----------------
    # PARSE USER ID
    # ----------------
    raw_id = args[0].strip()
    if raw_id.startswith("<@") and raw_id.endswith(">"):
        raw_id = raw_id.replace("<@", "").replace(">", "").replace("!", "")

    try:
        user_id = int(raw_id)
    except:
        await msg.reply("❌ Invalid user ID.")
        return

    reason = " ".join(args[1:]) or "Rule violation"

    # ----------------
    # FORCE TELEPORT
    # ----------------
    if cmd == "forceteleport":

        if len(args) < 2:
            await msg.reply("Usage: !forceteleport <userid> <placeid>")
            return

        try:
            place_id = int(args[1])
        except:
            await msg.reply("❌ Invalid place ID.")
            return

        entry = user_to_server.get(user_id)
        if not entry:
            await msg.reply("❌ User not in any active server.")
            return

        command = {
            "id": str(uuid.uuid4()),
            "action": "forceteleport",
            "userId": user_id,
            "placeId": place_id
        }

        queue = get_queue(entry["serverId"])
        queue[command["id"]] = command

        print("🚀 FORCE TELEPORT ENQUEUED:", command)

        await msg.reply(
            f"🚀 Teleport command sent.\nUser: `{user_id}`\nPlace: `{place_id}`"
        )
        return

    # ----------------
    # WARN / UNWARN / KICK
    # ----------------
    if cmd in ("warn", "unwarn", "kick"):
        entry = user_to_server.get(user_id)
        if not entry:
            await msg.reply("❌ User not in any active server.")
            return

        command = {
            "id": str(uuid.uuid4()),
            "action": cmd,
            "userId": user_id,
            "reason": reason
        }

        queue = get_queue(entry["serverId"])
        queue[command["id"]] = command

        await msg.reply(f"Command `{cmd}` sent to server.")
        return

    # ----------------
    # BAN
    # ----------------
    if cmd == "ban":
        try:
            with db.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO bans(network_id,user_id,reason,moderator)
                    VALUES (%s,%s,%s,%s)
                    ON CONFLICT (network_id,user_id)
                    DO UPDATE SET reason=excluded.reason, banned_at=now()
                    """,
                    (NETWORK_ID, user_id, reason, str(msg.author))
                )
                db.commit()
        except Exception as e:
            await msg.reply("❌ Database error while banning.")
            print("❌ DB error:", e)
            return

        total_enqueued = 0
        for server_id in list(server_queues.keys()):
            queue = get_queue(server_id)
            command = {
                "id": str(uuid.uuid4()),
                "action": "ban",
                "userId": user_id,
                "reason": reason
            }
            queue[command["id"]] = command
            total_enqueued += 1

        await msg.reply(f"✅ User {user_id} globally banned.")
        return

    # ----------------
    # UNBAN
    # ----------------
    if cmd == "unban":
        try:
            with db.cursor() as cur:
                cur.execute(
                    "DELETE FROM bans WHERE network_id=%s AND user_id=%s",
                    (NETWORK_ID, user_id)
                )
                db.commit()
            await msg.reply(f"✅ User {user_id} unbanned.")
        except Exception as e:
            await msg.reply("❌ Database error while unbanning.")
            print("❌ DB error:", e)
        return

    # ----------------
    # UNKNOWN
    # ----------------
    await msg.reply("❌ Unknown command. Use `!help` to see available commands.")

# =====================
# ROBLOX ENDPOINTS
# =====================
@app.post("/roblox/register-server")
async def register(req: Request):
    verify(req)
    data = await req.json()
    server_id = data["serverId"]
    print("REGISTER CALLED:", data) 
    for p in data["players"]:
        user_to_server[p["userId"]] = {
            "serverId": server_id,
            "lastSeen": time.time()
        }

        join_counts[p["userId"]] = join_counts.get(p["userId"], 0) + 1

        await send_webhook(
            DISCORD_WEBHOOK_LOGS,
            make_embed(
                0xFF0000 if join_counts[p["userId"]] >= 3 else 0x55FFCC,
                "👤 Player Joined",
                [
                    {"name": "Username", "value": p["username"]},
                    {"name": "UserId", "value": str(p["userId"])},
                    {"name": "Server", "value": server_id},
                    {"name": "Joins", "value": str(join_counts[p["userId"]])}
                ]
            )
        )

    return JSONResponse({"ok": True})

@app.post("/roblox/chat")
async def chat(req: Request):
    verify(req)
    m = await req.json()
    await send_webhook(
        DISCORD_WEBHOOK_LOGS,
        make_embed(0x5865F2, "💬 Chat", [
            {"name": "User", "value": f"{m['username']} ({m['userId']})"},
            {"name": "Message", "value": m["text"]}
        ])
    )
    return JSONResponse({"ok": True})

@app.get("/roblox/poll-commands")
async def poll_commands(serverId: str, request: Request):
    verify(request)

    q = get_queue(serverId)

    print("📡 POLL FROM:", serverId)
    print("📤 RETURNING COMMANDS:", list(q.values()))

    return {"commands": list(q.values())}

@app.post("/roblox/ack")
async def ack(request: Request):
    verify(request)
    data = await request.json()

    server_id = data["serverId"]
    ids = data["ids"]

    q = get_queue(server_id)

    for cid in ids:
        q.pop(cid, None)

    return {"ok": True}

@app.get("/health")
async def health():
    return {"status": "ok", "uptime": time.time()}


@app.head("/health")
def health_head():
    return

@app.middleware("http")
async def debug_requests(request: Request, call_next):
    print("➡️ INCOMING:", request.method, request.url.path)
    print("Headers:", dict(request.headers))
    response = await call_next(request)
    return response

@app.get("/roblox/check-ban")
async def check_ban(userId: int, request: Request):
    verify(request)

    with db.cursor() as cur:
        cur.execute(
            "select reason from bans where network_id=%s and user_id=%s",
            (NETWORK_ID, userId)
        )
        row = cur.fetchone()

    if row:
        return {"banned": True, "reason": row[0]}

    return {"banned": False}

@app.post("/roblox/player-left")
async def player_left(request: Request):
    verify(request)
    data = await request.json()

    user_id = data["userId"]
    username = data["username"]
    server_id = data["serverId"]

    user_to_server.pop(user_id, None)

    await send_webhook(
        DISCORD_WEBHOOK_LOGS,
        make_embed(
            0xFFAA00,
            "🚪 Player Left",
            [
                {"name": "Username", "value": username},
                {"name": "UserId", "value": str(user_id)},
                {"name": "Server", "value": server_id}
            ]
        )
    )

    return {"ok": True}

@app.post("/roblox/teleport-attempt")
async def teleport_attempt(request: Request):
    verify(request)
    data = await request.json()

    user_id = data.get("userId")
    code = data.get("code")
    server_id = data.get("serverId")
    success = data.get("success")

    status_text = "✅ CORRECT CODE" if success else "❌ WRONG CODE"

    embed = make_embed(
        0x00FF00 if success else 0xFF0000,
        "🚪 Teleport Code Attempt",
        [
            {"name": "User ID", "value": str(user_id)},
            {"name": "Code Entered", "value": str(code)},
            {"name": "Server ID", "value": str(server_id)},
            {"name": "Result", "value": status_text}
        ]
    )

    await send_webhook(os.getenv("TELEPORT_SESSION"), embed)

    print("📨 TELEPORT ATTEMPT:", data)

    return {"ok": True}

# =====================
# START
# =====================

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(client.start(DISCORD_TOKEN))