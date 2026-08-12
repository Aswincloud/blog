---
title: "Giving a Bluetooth receipt printer a public API, and the hop I never tested"
date: 2026-08-12
description: "My thermal printer speaks Bluetooth and ships with a Windows-and-Android-only app. My invoicing app is a Cloudflare Worker with no Bluetooth and no LAN. Closing that gap took four hops and a lot of signatures — plus a security hole I'd built in by accident, a queue that allowed one more job than I designed it to, and a test that passed because the request never arrived."
slug: "ble-printer-on-the-edge"
---

I have a 58mm thermal printer on the desk for handing customers a receipt. It speaks Bluetooth Low Energy, and its only official driver is a phone app. Printing meant: generate the invoice, download the PDF, open it on my phone, print from there. Fine once. Tedious every day.

The invoicing app is a Cloudflare Worker. It has no Bluetooth radio, no route into my LAN, and no idea my desk exists. That's the whole problem in one sentence: **the thing that knows what to print can't reach the thing that prints, and never will.**

What follows is how I closed that gap, and three things I got wrong doing it. I paired on this with an AI agent in my terminal, the same way I [rebuilt my portfolio](/posts/rebuilding-portfolio-with-ai/) — and as before, the useful parts are the mistakes.

## The chain

Four hops, each authenticating separately:

```
browser (anywhere)
  │  POST /api/print   { pdfBase64 }        session cookie
  ▼
Cloudflare Worker      session, then allowlist, then HMAC over the exact bytes
  │  POST https://print.example.com/print
  │  x-print-signature: <hex>
  ▼
cloudflared tunnel     already running for other services
  ▼
relay on 127.0.0.1     verifies the HMAC, queues, shells out to the printer
  ▼
ESP32-C3 → BLE → printer
```

Nothing about the printer is exposed. The relay binds to localhost only; the sole way in is the tunnel, and the tunnel's only caller is the Worker, which signs every request.

The relay is deliberately boring: about 250 lines of Python, standard library only, no pip dependencies to keep patched. It verifies an HMAC-SHA256 over the **raw request body** before parsing anything, because the signature covers the exact bytes sent and re-serialising parsed JSON produces different ones. Same reason the Worker builds its payload as a string exactly once and sends that same string:

```js
const raw = JSON.stringify({ pdfBase64: pdf, ts: Date.now(), by: user.email });
const sig = await hmacHex(raw, env.PRINT_RELAY_SECRET);
// send `raw` verbatim — never re-stringify
```

## Being signed in is not permission to use my printer

Here's the hole I built without noticing.

The Worker route sat below the session gate, so it required a logged-in user. That felt like authorisation. It isn't — because **anyone can create an account**. My sign-in is a magic link: enter an email, click the link, you're in. There's no allowlist on signup.

So the actual security property was: *anyone on the internet who can receive email can make paper come out of a machine in my house, as many times as they like.* Not a data breach. Just a stranger with remote control of my paper supply and thermal head.

The fix is small, which is what makes it easy to miss:

```js
function mayPrint(env, email) {
  const who = String(email || "").trim().toLowerCase();
  if (!who) return false;
  const list = String(env.PRINT_ALLOWED_EMAILS || env.INVOICE_OWNER_EMAIL || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(who);
}
```

The general shape is worth naming: **"authenticated" and "authorised" are different questions, and an open signup turns the first one into no question at all.** I'd internalised that for admin panels and then walked straight past it for a printer, because a printer doesn't feel like a privileged resource until you picture it running all night.

## "Printed" should mean printed

Two ways to build the button. Fire-and-forget: accept the job, return 200, hope. Or wait: hold the request open until the paper is out, and report what actually happened.

I went with waiting, and I'd choose it again. A thermal printer fails in mundane physical ways — powered off, out of paper, Bluetooth link refusing to come up — and every one of those is something the person pressing the button needs to know *now*. Fire-and-forget converts all of them into silence.

The cost is a request held open for about fifteen seconds. The relay's HTTP handler enqueues a job and blocks on a per-job event; the printer thread sets it when the job finishes. If anything fails, the browser gets the reason **and** downloads the PDF, so a dead printer costs a download rather than the receipt.

That queue is where I made my second mistake. One printer means jobs must serialise — two overlapping raster streams interleave into garbage. So: a queue with one worker thread, and a bound, because unbounded means a few impatient clicks at a switched-off printer bank up minutes of doomed work and then print all of it when it wakes.

I wanted "one printing, one waiting" and wrote `maxsize=2`. That allows three. The job being printed has already been `get()`-ed — it is no longer *in* the queue — so the bound counts only what's waiting. It's `maxsize=1`:

```python
JOBS: "queue.Queue" = queue.Queue(maxsize=1)
```

Off by one, in the direction of accepting work I'd decided not to accept. It took writing a test that fired three jobs at once to see it.

There's a second staleness rule that only works if you put it in the right place. A job can be fresh when it arrives and pointless by the time the printer reaches it — the caller may have given up. So the check happens **at dequeue, not at enqueue**:

```python
waited = time.monotonic() - job.queued_at
if waited > STALE_JOB:
    job.ok, job.error = False, f"gave up after waiting {waited:.0f}s"
    continue
```

## The tunnel that 404'd for a reason I'd have never guessed

With everything built, the public hostname returned a flat `404`.

The relay was healthy on localhost. DNS resolved. The tunnel was up and carrying nine other services. I went looking for a typo in the ingress rule and found something better: **the hostname wasn't in the tunnel's config at all** — and the config's last rule is a catch-all `http_status:404`. The 404 wasn't an error. It was the tunnel doing exactly what it was told for a hostname it had never heard of.

The reason it wasn't there: my Cloudflare token can see two accounts, and the tunnel belongs to the second one. Every read I'd done had gone to the first, which cheerfully reported "configuration not found" — a message I'd misread as "this tunnel is locally managed" rather than "you are asking the wrong account."

Two things I'd do differently. First, when an API says *not found*, check you're pointed at the right tenant before theorising about the resource. Second — and this one has teeth — the tunnel ingress API takes **the entire rule list in one PUT**. Adding a hostname is a read-modify-write, and a careless write drops the other nine services. My script reads first, inserts before the catch-all, and writes all of them back:

```python
new = [r for r in rules if r.get("hostname")]      # keep every existing rule
catchall = [r for r in rules if not r.get("hostname")]
new.append({"hostname": host, "service": service})
cfg["ingress"] = new + catchall                    # catch-all stays last
```

Append after the catch-all and your new rule is unreachable, because matching stops there.

## The test that passed because the request never arrived

This is the one I keep thinking about.

Once the tunnel worked, I wrote a check for the security property that matters most: a request with a **wrong signature must be refused**. It reported `PASS`. Refused with a 403.

Then the correctly-signed request also came back 403, with body `error code: 1010`.

That's Cloudflare's browser integrity check rejecting a bare `Python-urllib` user agent. Neither request had reached my machine. And the "bad signature refused" test had passed for a reason that had nothing to do with signatures — I'd written the assertion as *any error means refused*, so a request blocked two thousand kilometres away looked identical to one my relay had correctly rejected.

The relay answers **401** for a bad signature. Asserting on the exact code turns a vague test into a specific one:

```python
ok = e.code == 401
print(f"{'PASS' if ok else 'FAIL'}  bad signature -> {e.code} "
      f"(relay says 401; 403 = Cloudflare blocked it before the tunnel)")
```

That single change also gave me the diagnosis for free the next time it happens.

It raised a real question too: the Worker's own `fetch` sets no user agent — would Cloudflare block *it*? I checked instead of assuming, and only that specific library UA is on the list; no-UA, empty-UA and curl's default all sail through. But I'd been one plausible guess away from either a broken feature or a pointless workaround.

## What I'd tell myself at the start

**Test the hop, not the chain.** Every "end to end" test I ran before the tunnel existed hit the relay directly on localhost. They all passed. They proved the relay worked and said nothing about the path to it — and the path was the entire remaining problem. The first time the Worker's own code talked to the public hostname was after everything else was declared done.

**A test that can't distinguish two failures is testing neither.** "Any error means refused" is not an assertion, it's a shrug.

**Ask what the resource is worth to a stranger, not what it's worth to you.** A receipt printer sounds trivial until it's a device in your house that anyone with an email address can operate remotely, overnight, in a loop.

The system works now: press the button anywhere, and about fifteen seconds later there's a receipt on my desk. The satisfying part isn't the printing. It's that four hops each refuse to trust the one before them, and I can say which failure each of them produces — because I finally made the tests tell those failures apart.

Next up: the printer's own protocol, which is where I spent [considerably longer being wrong](/posts/thermal-printer-measure-dont-infer/).
