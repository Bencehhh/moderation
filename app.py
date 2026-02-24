import os
import time
import uuid
import asyncio
from typing import Dict, List

import httpx
import psycopg
from fastapi import FastAPI, Request, HTTPException
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

@app.middleware("http")
async def debug_requests(request: Request, call_next):
    print("➡️ INCOMING:", request.method, request.url.path)
    print("Headers:", dict(request.headers))
    response = await call_next(request)
    return response

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
    if req.headers.get("authorization") != WEBAPP_SHARED_SECRET:
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

@client.event
async def on_message(msg: discord.Message):
    if msg.author.bot or not msg.content.startswith(PREFIX):
        return

    parts = msg.content[len(PREFIX):].split()
    cmd = parts[0].lower()
    args = parts[1:]

    if cmd == "help":
        await msg.reply(embed=make_embed(0x5865F2, "📘 Commands", [
            {"name": "!help", "value": "Show this menu"},
            {"name": "!warn <userid> <reason>", "value": "Warn player"},
            {"name": "!unwarn <userid>", "value": "Clear warning"},
            {"name": "!kick <userid> <reason>", "value": "Kick from server"},
            {"name": "!ban <userid> <reason>", "value": "Global ban"},
            {"name": "!unban <userid>", "value": "Remove global ban"}
        ]))
        return

    if not args:
        return

    user_id = int(args[0])
    reason = " ".join(args[1:]) or "Rule violation"

    entry = user_to_server.get(user_id)

    if cmd in ("warn", "unwarn", "kick") and not entry:
        await msg.reply("User not in any active server.")
        return

    if cmd == "ban":
        with db.cursor() as cur:
            cur.execute(
                """insert into bans(network_id,user_id,reason,moderator)
                   values (%s,%s,%s,%s)
                   on conflict (network_id,user_id)
                   do update set reason=excluded.reason, banned_at=now()""",
                (NETWORK_ID, user_id, reason, msg.author.tag)
            )
            db.commit()

        await send_webhook(
            DISCORD_WEBHOOK_USERBANS,
            make_embed(0xFF0000, "🔨 USER BANNED", [
                {"name": "User ID", "value": str(user_id)},
                {"name": "Reason", "value": reason}
            ])
        )
        await msg.reply("User banned.")
        return

    if cmd == "unban":
        with db.cursor() as cur:
            cur.execute(
                "delete from bans where network_id=%s and user_id=%s",
                (NETWORK_ID, user_id)
            )
            db.commit()
        await msg.reply("User unbanned.")
        return

    # queue roblox command
    command = {
        "id": str(uuid.uuid4()),
        "action": cmd,
        "userId": user_id,
        "reason": reason
    }
    get_queue(entry["serverId"])[command["id"]] = command
    await msg.reply(f"Command `{cmd}` sent to server.")

# =====================
# ROBLOX ENDPOINTS
# =====================
@app.post("/roblox/register-server")
async def register(req: Request):
    verify(req)
    data = await req.json()
    server_id = data["serverId"]

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

@app.post("/roblox/poll-commands")
async def poll(req: Request):
    verify(req)
    server_id = (await req.json())["serverId"]
    q = list(get_queue(server_id).values())
    return {"commands": q}

@app.post("/roblox/ack")
async def ack(req: Request):
    verify(req)
    data = await req.json()
    q = get_queue(data["serverId"])
    for cid in data["ids"]:
        q.pop(cid, None)
    return {"ok": True}

@app.get("/health")
async def health():
    return {"status": "ok", "uptime": time.time()}

# =====================
# START
# =====================

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(client.start(DISCORD_TOKEN))