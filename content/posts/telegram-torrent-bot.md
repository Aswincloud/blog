---
title: "Torrents by Telegram: a login that lies, and a rename button wired to SSH"
date: 2026-07-05
description: "A Telegram bot that adds torrents to my qBittorrent box — trivial. The parts worth writing down: getting a session that survives Cloudflare and doesn't trust its own login, and safely letting a chat reply rename files on my home server over SSH."
slug: "telegram-torrent-bot"
---

The gadget: text a magnet link to a Telegram bot, and it queues the download on the qBittorrent box at home. `/status` shows progress, send a `.torrent` file and it uploads. The happy path is about ten lines of [Pyrogram](https://pyrogram.org).

Two things earned the writeup, and neither is in the ten lines: **getting a qBittorrent session that actually stays authenticated**, and **letting a chat message rename a file on my server without that being a terrible idea.**

## Part 1: the session that fights Cloudflare and won't trust its own login

The qBittorrent Web UI lives behind a Cloudflare-proxied hostname. That's great for me typing the URL in a browser, and a problem for a bot: a plain `requests` session hits Cloudflare's bot challenge and gets a challenge page instead of the API. So the bot talks to it through [`cloudscraper`](https://github.com/VeNoMouS/cloudscraper), a drop-in `requests` replacement that transparently clears the challenge.

That gets you *to* the API. Then qBittorrent's login hands you the next surprise.

You'd expect `POST /api/v2/auth/login` to tell you whether it worked. It's slippery: on success it may answer `Ok.` with a `200`, or a bare `204`; the body text and status vary across versions and setups. Branching on "did the login response look right?" is exactly the kind of thing that works on your machine and silently breaks after an update.

So the bot doesn't trust the login response at all. It **proves the session by using it** — makes one authenticated call and checks that *that* succeeds:

```python
_qb_session = None

def get_qb_session():
    global _qb_session
    # Reuse the cached session, but only if it still authenticates.
    if _qb_session:
        try:
            r = _qb_session.get(f"{QB_URL}/api/v2/app/version", timeout=10)
            if r.status_code == 200:
                return _qb_session
        except Exception:
            pass  # fall through and re-login

    # A plain requests session trips Cloudflare's bot check; cloudscraper clears it.
    session = cloudscraper.create_scraper()
    try:
        # creds = qBittorrent username + password, from env
        session.post(f"{QB_URL}/api/v2/auth/login", data=creds, timeout=30)
        # Don't parse the login reply. Verify with a real authenticated call —
        # works whether login returned "Ok." (200) or 204.
        v = session.get(f"{QB_URL}/api/v2/app/version", timeout=10)
        if v.status_code == 200:
            _qb_session = session
            return session
    except Exception as e:
        print(f"qB login error: {e}")
    return None
```

Two reliability details fall out of that shape:

- **The session is cached, but never trusted on faith.** Before reusing it, the bot pings `/app/version`; if the cookie expired or qBittorrent restarted, that probe fails and it re-logs-in. No "why did my bot start returning 403 after a day" mystery.
- **Login success is defined as "an authenticated request works,"** not "the login endpoint said a magic word." That's the generalizable lesson: **for any auth flow, verify by doing the thing you're authenticating for — don't pattern-match the login response.** The login handshake is the least reliable place to detect login success.

The rest of Part 1 is unremarkable on purpose — every qBittorrent call goes through `get_qb_session()`, so re-auth is automatic and lives in exactly one place.

## Part 2: a rename button that runs `mv` on my server

Here's the part I actually enjoy. When a download finishes, a completion hook on the home server sorts it into the media library and drops a `token → path` line into a small queue file. It also pings me on Telegram with a **Rename** button — because "torrent finished as `Some.Movie.2024.1080p.WEBRip.x265`" is not what I want Jellyfin to show.

Tap the button, and the bot replies with a [ForceReply](https://core.telegram.org/bots/api#forcereply) prompt showing the current filename. I type `Some Movie (2024)`, and the bot renames the file on the server — keeping the original extension if I didn't type one — and Jellyfin rescans.

The thing is: this is a chat message causing a `mv` to run on my home server. That sentence should make you nervous, and the whole design is about earning it back.

### It's stateless — the token rides in the message

There's no server-side map of "user is currently renaming file X." The token that identifies the file is embedded in the prompt's text, and the reply handler reads it back out:

```python
@app.on_callback_query(_filters.regex(r"^rn:"))
async def on_rename_button(client, cq):
    token = cq.data.split(":", 1)[1]
    path = await asyncio.to_thread(_lookup_path, token)
    if not path:
        await cq.answer("File not found (already renamed or removed).", show_alert=True)
        return
    await cq.answer()
    # The token travels inside the prompt text; the reply handler reads it back.
    await client.send_message(
        cq.message.chat.id,
        f"Current name:\n`{posixpath.basename(path)}`\n\n"
        f"Reply with the new name.\nrn-token:{token}",
        reply_markup=ForceReply(placeholder="Title (Year)"),
    )
```

I did this deliberately, and it's the same lesson as a [previous automation of mine](/posts/good-night-alert/): **anything that stashes "in-progress" state in memory gets stuck when the process restarts.** Here the state lives in two durable places — the queue file on the server and the Telegram message itself — so a bot restart mid-rename changes nothing. Tap the button an hour and a redeploy later; it still works.

### It assumes the input is hostile

The token gets looked up by `awk`-ing the queue file over SSH, which means it's about to become part of a shell command. So before it goes anywhere near a shell, everything that isn't alphanumeric is dropped — which strips every shell metacharacter (quotes, spaces, `;`, `$`, `` ` ``, `/`) an injection would need:

```python
def _lookup_path(token):
    # .isalnum() keeps only letters/digits, so no shell metacharacters survive.
    safe = "".join(c for c in token if c.isalnum())
    if not safe:
        return None
    rc, out, _ = _ssh_run(
        f"awk -F'\\t' '$1==\"{safe}\"{{print $2; exit}}' '{RENAME_QUEUE}' 2>/dev/null"
    )
    return out.strip() or None
```

The new *name* you type is treated with the same suspicion. Path separators and null bytes are stripped so a name can't climb out of its directory, the original extension is reattached (so you can't accidentally turn a `.mkv` into something Jellyfin ignores), and then **both** paths are single-quote-escaped before the `mv`:

```python
def _do_rename(old_path, new_base):
    # No traversal, no null bytes, no slashes in the requested name.
    new_base = new_base.strip().strip("/").replace("/", "").replace("\x00", "")
    if not new_base:
        return (False, "empty name")
    d = posixpath.dirname(old_path)
    _, ext = posixpath.splitext(old_path)
    if not posixpath.splitext(new_base)[1]:     # reattach ext if user omitted it
        new_base = new_base + ext
    new_path = posixpath.join(d, new_base)

    def q(s):  # single-quote for the shell, escaping embedded quotes
        return "'" + s.replace("'", "'\\''") + "'"

    # Guarded + non-clobbering: only move if the source exists and the target doesn't.
    cmd = (f"test -e {q(old_path)} && ! test -e {q(new_path)} "
           f"&& mv -n {q(old_path)} {q(new_path)} && echo OK")
    rc, out, err = _ssh_run(cmd)
    return (True, new_base) if "OK" in out else (False, (err or out or "failed")[:200])
```

The `test -e old && ! test -e new && mv -n` chain is the part I'd call non-negotiable: it refuses to run unless the source is really there and the destination is really free, and `mv -n` is a second belt on top of that suspenders. A rename should never silently clobber another file — especially one triggered from a phone, where it's easy to fat-finger a name that already exists.

None of this is exotic. It's just the discipline that the boundary between "a chat message" and "a shell command on my server" deserves: **sanitize what becomes a shell token, quote what becomes a path, and never overwrite.**

## A small correctness note: don't block the event loop

Pyrogram is `asyncio`. `cloudscraper`, `paramiko`, and the qBittorrent calls are all blocking. Call them directly from a handler and they freeze the bot's event loop for *every* user until the SSH round-trip or HTTP request returns. So each blocking call is pushed to a thread:

```python
path = await asyncio.to_thread(_lookup_path, token)     # SSH, off the event loop
r    = await asyncio.to_thread(_add)                     # qB HTTP, off the event loop
```

Cheap to do, and it's the difference between "the bot is responsive while a slow rename runs" and "the bot appears dead for ten seconds every time I touch it."

## Takeaway

Adding a torrent from a magnet link is the ten-line part. What made this worth keeping — and worth writing down — is everything wrapped around it: a session that clears Cloudflare, re-logs-in on its own, and defines success as *doing the thing* rather than trusting the login handshake; and a rename feature that treats a chat message as exactly what it is — untrusted input about to touch a shell — and stays stateless so a restart never strands it.

The bot is a remote control. The engineering is all in making it a remote control I can trust to run commands on my server while I'm not watching.
