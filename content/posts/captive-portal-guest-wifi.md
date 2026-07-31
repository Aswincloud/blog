---
title: "A captive portal for my guest WiFi, and the four bugs that made it real"
date: 2026-07-31
description: "Replacing the router's built-in splash page with a real login portal took an afternoon. Making it trustworthy took the rest of the week: a hash I couldn't derive, an authentication step that stranded the people it had just let in, a test suite that passed while the site was unreachable, and an OTP flow I had to stop calling a security feature."
slug: "captive-portal-guest-wifi"
---

Guests at my house used to get the WiFi password on a scrap of paper. The upgrade sounded simple: a proper captive portal — that page which pops up when you join a café network — so I could hand out access without handing out the password to the network everything else lives on.

The portal itself is unremarkable. OpenWrt runs [openNDS](https://opennds.readthedocs.io/), which intercepts unauthenticated traffic; the login page is a small PHP container on my NAS. An afternoon's work.

Then I spent the rest of the week finding out what "working" actually means. Four bugs, each of which taught me something I'd have sworn I already knew.

## Bug 1: the hash the documentation says you can compute

openNDS in its "forwarding authentication service" mode hands your login page a bundle of facts about the client — their IP, their MAC, and a `gatewayhash` identifying which gateway they came through. Your page validates that hash, and later writes an authorisation into a queue directory *named after it*. A helper daemon on the router polls that directory and lets the client through.

The docs imply the hash is a SHA-256 of the configured gateway name. So I computed it, pinned it in my config, and tested. Logins hung forever at "Connecting…".

Nothing was broken, exactly. My page wrote a perfectly valid authorisation into a directory named after *my* hash. The daemon polled a directory named after *its* hash. Two processes, both convinced they were right, never once touching the same file.

The value is computed inside the C binary, from a format string that mixes in the bridge interface's MAC address. There is no documented way to derive it. The fix is four words long — **read it off the router**:

```sh
grep gatewayhash /tmp/ndscids/authmonargs
```

The lesson isn't "the docs were wrong." It's that a wrong-but-well-formed value is the worst kind. A garbage hash would have thrown an error on line one. A *plausible* hash sailed through every validation I'd written and failed silently, twenty seconds later, in a different process.

## Bug 2: the authentication that stranded people it had just authenticated

This one reached real guests, which is how I found it.

You'd type the password. You'd see "Connecting…". Three seconds later you'd be back at the login form. So you'd type it again. And again. Some devices got online eventually; some never did.

Three separate mistakes stacked into one failure:

**The page refreshed faster than the router polled.** My page waited 3 seconds before checking whether authentication had gone through. The daemon polls roughly every 6. So the first check was *always* too early — and my code treated "not authenticated yet" as "not authenticated," and redisplayed the login form.

**That invited a second submit, which was fatal.** openNDS refuses to authenticate a client it has already authenticated. Reasonable. But my page had queued a *second* authorisation for that client, and the router refused it — so the daemon never acknowledged it, so it stayed in the queue and was re-served on every single poll, forever.

**And I'd inferred state from an absence.** My "are they authenticated?" check was, essentially, *is their queue entry gone?* Which is true right up until a duplicate entry appears — at which point a fully-online client is permanently classified as logged out, staring at a login form that can no longer do anything for them.

The fixes, in order of how much they mattered:

1. **Latch the fact.** When authentication is confirmed, write a marker and keep it. The absence of a queue entry is not durable state — it's a race you happen to be winning.
2. **Keep waiting instead of falling through.** The page now retries with an attempt counter, showing "Connecting…" up to a limit, and shows a real error if it runs out. Never the login form again.
3. **Expire entries the router will never accept**, so a stuck one can't live forever.

There's a timing detail I want to record because it looks like a bug and isn't: **a normal login takes about 21 seconds.** The first real device needed seven "Connecting…" refreshes. That's just how long the polling round-trip is. My retry limit has about 9 seconds of headroom over the worst case I've measured — so it's now commented as a limit not to lower without raising the poll rate in the same change.

## Bug 3: 101 passing tests and a link that wouldn't load

I was pleased with the test suite. It exercises the real polling handshake, the stranding bug, the retry path, expiry, single-use codes. Everything green.

I sent myself the portal link. It spun forever.

The site is on a **split-horizon** setup: the same hostname resolves to a private address inside my network and a deliberately-unroutable one outside. I'd configured that on the router — so guests on the WiFi, who use the router as their DNS, resolved it fine. But every other device in the house uses my ad-blocking DNS server, which had no such record, so it asked the public internet and got the unroutable answer. Correct behaviour. Useless result.

Here's the part I actually want to write down. **My test suite could never have caught this**, and not by accident:

```sh
curl --resolve wifi.example.com:443:<the address I already knew>
```

Every single test pinned the hostname to the right address before connecting. That flag exists precisely to *bypass* DNS — I'd used it so the suite would work regardless of where it ran, which is a good reason. But it meant 101 assertions all agreed the portal was healthy while the one step between a person and the portal was broken.

A test that supplies the answer can't discover the question. I'd tested the portal thoroughly and the *path to* the portal not at all — and the path is most of what a captive portal is.

## Bug 4: the feature I had to stop calling security

Late on, I added a second door. A guest who doesn't know the password types a short reason into a box, and the portal issues them a single-use code good for one day, then sends me the reason, the code, and the device it's bound to over Telegram — with a ready-to-paste command to revoke it.

I built it, tested it, and then wrote this comment above the config, which is the most useful thing in the whole file:

> Be clear about what this is: it is **not** an approval gate. The code is issued immediately, so anyone within WiFi range can obtain access by typing anything into the box.

Because that's true, and it would have been so easy to let myself think otherwise. The flow *feels* like asking permission. It has a reason box and it notifies me. But nothing waits for my answer — the code appears the moment they hit submit. If I'd left that unstated, six months from now I'd have been treating it as a gate it never was.

What it actually provides is worth having, just not the thing the UI implies:

- Every grant is tied to a stated reason
- I'm notified in real time, not in a log I'll never read
- It's bound to one device and expires in a day
- I can revoke it before they connect

That's **accountability after the fact**, which is a real property. It just isn't authorisation.

The rate limiting made the same point. I'd written a per-device limiter, which is close to useless here — a self-service request always succeeds, and a MAC address takes seconds to spoof. What actually bounds the damage is a global daily cap. And its refusal message is deliberately vague, because naming the limit tells someone probing it exactly how many more requests they need to burn to shut the door for everyone.

## The last mile: making it look like it belongs

With it working, I finally made the portal wear the same identity as the rest of my sites — the same mark, the same emerald palette, the same ink colour.

One constraint shaped the whole job: **a guest who hasn't logged in yet can't fetch anything.** That's the entire point of a captive portal. My site is behind Cloudflare, whose edge addresses rotate, and the walled garden matches on IP — so a logo hotlinked from my own site would hang forever on exactly the page where first impressions happen. Every asset had to be a local file in the container. The mark is a 200-byte inline SVG.

For the same reason, the link to my site renders **only on the success page**, once the guest is genuinely online. There are two tests pinning that: absent before, present after.

And one small thing I nearly got wrong. My site's emerald is `#10b981`, which is lovely on a dark background and measures **3.0:1 on white** — below the 4.5:1 that body-sized text needs to stay readable. The light theme uses a darker step of the same hue at 5.48:1; the bright original still appears on dark surfaces and inside the mark, where it has contrast to spare. Brand colours are chosen against the brand's own background. Reused somewhere else, they're just colours, and they need re-checking.

## Takeaway

Every one of these bugs was silent. Not one threw an error.

The hash was well-formed and wrong. The stranding bug was three correct-looking behaviours composing into a trap. The DNS failure was invisible *because* my testing was disciplined about isolation. And the OTP flow worked exactly as built — the bug was in what I was tempted to believe about it.

The through-line, if there is one: **the failures that survive are the ones that look like success.** A crash gets fixed the day you ship. A plausible-looking wrong answer waits until there's a guest standing in your hallway holding a phone that won't connect.
