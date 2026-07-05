---
title: "A status page that survives its own death"
date: 2026-07-05
description: "A self-hosted uptime page for my home network — built on the one rule that makes monitoring trustworthy: 'no news' has to mean down, not up. The gadget is a Cloudflare Worker; the interesting part is the four ways it refuses to lie to me."
slug: "status-page-that-survives-home"
---

I wanted a little green-dot status page for my home network — is the torrent box up, is the internet actually fast right now, when did that last outage start. [BetterStack](https://betterstack.com/) and friends do this beautifully, but it felt silly to pay a SaaS to watch a machine sitting three feet from me.

So I built one. The gadget is small: a Cloudflare Worker, a SQLite database, and a tiny prober in a container. What took the thought — and what's worth writing down — is that **a status page is only useful if you can trust it when everything else is on fire.** That one requirement drove four design decisions, and those decisions are the real content.

## The one rule: "no news" must mean down

Here's the failure that kills most home-grown monitors. You write a checker that pings your box and records "up" or "down." Then one day the *checker itself* dies — the server it runs on reboots, the process crashes, the power blips. No more checks arrive. Your page shows the **last thing it heard**, which was "up." It sits there glowing green while your house is offline.

That's worse than no status page, because now it's actively lying to you.

The rule I built everything around: **the absence of a heartbeat has to be treated as an outage, not as continuity.** Silence is not "still fine." Silence is "I don't know," and for a status page, "I don't know" must render red.

Everything below is downstream of that one sentence.

## Decision 1: the page can't live where the thing it's watching lives

A status page hosted at home dies *with* home. Power cut, ISP down, router wedged — the exact moments you want the page are the moments it's unreachable. Useless.

So the page runs on **Cloudflare's edge**, nowhere near my house:

- a **Worker** serves the page and a small JSON API,
- a **D1** (SQLite) database stores checks and incidents,
- an **external always-on server** (not at home) runs a **Docker prober** that checks home every 30s and POSTs a heartbeat in.

```
 ┌─ external server (not home) ─┐        ┌────────── Cloudflare edge ──────────┐
 │  prober (Docker)             │  HTTPS │  Worker · D1 · per-minute cron       │
 │   every 30s: check home ────────────▶ │  POST /api/ingest → record + detect  │
 │              push heartbeat  │(Bearer)│  GET  /api/status → JSON for the page│
 └──────────────────────────────┘        │  scheduled()      → watchdog + prune │
   visitor ─ GET / ──────────────────────▶  static page from the edge           │
                                         └──────────────────────────────────────┘
```

The edge stays up even when both my home *and* the prober are down. That independence is the whole point — and it sets up the next problem.

## Decision 2: a cron watchdog, because the prober will eventually die

Moving the page to the edge means the prober is now a separate box that can fail on its own. If it does, heartbeats stop — and per the one rule, stopped heartbeats must read as an outage, not as a frozen green dot.

Cloudflare Workers can run on a cron trigger, so I gave the Worker a heartbeat-of-last-resort. Every minute it looks at each monitor's newest check, and if the most recent one is stale — older than two minutes — *and* the monitor is still recorded as up, it writes a synthetic "down":

```typescript
// scheduled() runs every minute (crons: ["* * * * *"])
for (const m of monitors) {
  const last = await latestCheck(env.DB, m.id);
  // Newest check is stale and we still think we're up → the prober went
  // dark. Record a synthetic watchdog "down" so a dead prober surfaces
  // as an outage instead of a frozen green dot.
  if (last && now - last.ts > STALE_MS && last.up === 1) {
    await applyCheck(env, m, false, null, now, "watchdog");
  }
}
```

The check gets tagged with its source — `'prober'` for real checks, `'watchdog'` for these synthetic ones — so I can always tell "home is actually down" apart from "I stopped hearing from the prober." Both are outages; they just have different causes, and the timeline should say which.

The prober pushes every 30s; the watchdog fires at 2 minutes. That gap is deliberate: it's four missed heartbeats, wide enough that a single slow cycle or one dropped POST doesn't trip a false alarm, tight enough that a genuinely dead prober surfaces fast. And it means the two layers cover *each other* — if home goes down the prober reports it in seconds; if the prober goes down the watchdog reports it in two minutes. There is no state in which the page silently stays green while something is wrong.

## Decision 3: the check that looked up but wasn't

The starter monitor watches my torrent box, which sits behind a Cloudflare-proxied domain. My first instinct was a `ping` check — simplest thing that could work.

It reported **up**. Always. Even with the home machine unplugged.

The reason is obvious in hindsight: a proxied hostname resolves to **Cloudflare's** IP, not mine. A ping to it is answered by Cloudflare's edge, which is essentially never down. I wasn't monitoring my house at all — I was monitoring Cloudflare's uptime, which is not a service I need to keep an eye on.

The fix is to use a check that has to travel *all the way through* to the home origin — an HTTP request:

```javascript
async function checkHttp(url, timeoutSec = 8) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
    return { up: res.status < 500, latency_ms: Date.now() - t0 };
  } catch {
    return { up: false, latency_ms: null };   // aborted / refused = down
  } finally {
    clearTimeout(timer);
  }
}
```

When home is up, the request passes through Cloudflare to my origin and comes back `200`. When home is down, Cloudflare can't reach the origin and returns a `52x` — which is `≥ 500`, so it reads as down. The request being *forced through the proxy to the origin* is exactly what makes it honest. (For a direct, non-proxied host, `ping` or a `tcp` connect are fine — the prober supports all three. The trap is specifically proxied hosts.)

**Lesson:** a health check that can be satisfied by something other than the thing you're checking isn't a health check. Always ask what, exactly, is answering.

## Decision 4: never page me for a blip

Home internet flickers. A single dropped packet, a two-second Wi-Fi hiccup, a momentary DNS stall — none of these are outages, and none should open an incident or fire an alert. An early version of this happily emailed me every time a stray packet went missing. That's how you train yourself to ignore the status page entirely.

So the prober doesn't trust any single sample. Each cycle it samples the monitor several times across a short window and only reports a **flip** when the window is *unanimous* — a genuine outage requires the whole window offline, a recovery requires the whole window healthy. A mixed window is a blip, and a blip **holds the previous state**:

```javascript
// Sample across a ~5s window; only flip on a unanimous verdict.
async function confirmedCheck(mon) {
  const prev = lastState.has(mon.id) ? lastState.get(mon.id) : true;
  const first = await runCheck(mon, SAMPLE_TIMEOUT);

  for (let i = 1; i < CONFIRM_SAMPLES; i++) {
    await sleep(gap);
    const r = await runCheck(mon, SAMPLE_TIMEOUT);
    if (r.up !== first.up) {
      // Window disagrees → a blip. Hold previous state; don't flip.
      lastState.set(mon.id, prev);
      return { up: prev, flapped: true };
    }
  }
  // Whole window agreed → trust it.
  lastState.set(mon.id, first.up);
  return { up: first.up, flapped: false };
}
```

It short-circuits the moment the window disagrees, so a healthy monitor still finishes in a single sample — the extra sampling cost is only paid when something actually looks wrong. And because a flip only ever happens on a unanimous window, one transient failure can never open an incident.

There's a second, independent guard on the Worker side: when a check *does* flip down, it opens an incident only if one isn't already open, and a recovery resolves the open one. Duplicate "down" reports can't stack up duplicate incidents or duplicate alerts:

```typescript
if (wasUp && !up) {                       // up → down
  if (!(await openIncident(env.DB, monitor.id))) {
    await startIncident(env.DB, monitor.id, ts);
    await notify(env, monitor, { kind: "down", since: ts });
  }
} else if (!wasUp && up) {                 // down → up
  const open = await openIncident(env.DB, monitor.id);
  if (open) {
    await resolveIncident(env.DB, open.id, ts);
    await notify(env, monitor, { kind: "recovered", durationMs: ts - open.started_at });
  }
}
```

Debounce at the edge of the system (the prober's confirm window), idempotency at the core (the incident guard). One stops noise from being generated; the other stops noise that slips through from being amplified.

## The bit I didn't expect to care about: two boxes, on purpose

The reachability prober runs **outside** home — it has to, to tell when home is down. But I also wanted a graph of my actual internet speed, and that's the exact opposite requirement: a speed test only means anything if it runs **at** home, on the connection I'm actually paying for. A speed test from a datacenter measures the datacenter.

So there are two agents on two different boxes, and which side of the front door each one lives on is not an accident — it's the whole reason each one is trustworthy:

| Agent | Runs | Because |
|---|---|---|
| Reachability prober | **Outside** home | To detect that home is down, you must be able to see it from the outside. |
| Speed agent | **Inside** home | To measure the real connection, you must be on it. |

It's the same lesson as the ping trap, wearing different clothes: **where you measure from decides what you're actually measuring.**

## Takeaway

The Worker, the database, the little green dots — that part is an afternoon. Everything memorable came from taking one requirement seriously: *a status page must never lie, and its most tempting lie is silence-as-green.*

Edge-hosting so it outlives what it watches. A watchdog so a dead prober can't fake calm. An HTTP check so a proxy can't answer for the origin. Two-layer flap damping so a hiccup isn't an incident. None of it is clever code. It's just refusing, in four specific places, to let the system quietly tell me everything's fine when it doesn't actually know.

That's the difference between a status page you glance at during an outage and one you learn to ignore.
