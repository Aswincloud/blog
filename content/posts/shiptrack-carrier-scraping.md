---
title: "Tracking my own parcels: three carriers, three fights, one interface"
date: 2026-07-05
description: "Self-hosted shipment tracking for Indian couriers. Every carrier resists being tracked in a different way — one wants a phone call for API access, one only admits to its own shipments — so the real work is a uniform adapter over three hostile, inconsistent upstreams, plus a poller that only emails when something actually changed."
slug: "shiptrack-carrier-scraping"
---

I wanted one page where I could paste any tracking number — Blue Dart, Delhivery, whatever — and see where my parcel is, without bouncing between five courier sites that each look like they were built in 2009. Most of the "universal tracking" options are paid SaaS aggregators. For a handful of my own shipments, that's absurd.

So I built a small self-hosted one. The surprise — and the reason it's worth writing up — is that **the hard part isn't tracking a parcel. It's that every carrier resists being tracked in a completely different way**, and the only sane response is to hide each fight behind one boring interface.

## The one interface everything hides behind

Every carrier, however it actually gets its data, has to produce the same shape. That contract is the whole architecture:

```typescript
export interface Carrier {
  id: string;
  name: string;
  // Set when the carrier can only track shipments booked under the
  // operator's OWN account (not arbitrary public AWBs).
  privateOnly?: boolean;
  track(trackingNumber: string, opts?: TrackOptions): Promise<TrackingResult>;
}
```

A `TrackingResult` is a normalized status, an estimated delivery, origin/destination, and a list of `TrackingEvent`s. The rest of the app — the API route, the dashboard, the background poller — only ever sees *that*. It has no idea whether the data came from a JSON API or a scraped HTML table, and that's the point: **the mess is quarantined inside each carrier module.** Adding a courier is writing one file that satisfies this interface and registering it. Nothing else changes.

Here's how differently the three currently fight.

## Blue Dart: the "official API" is a phone call

Blue Dart *has* a commercial Tracking API. To use it you need a LoginID and a tracking-API License Key — issued by a Blue Dart **account manager**. It's not free, and (the part that surprised me) it is **not** obtainable through the DHL Developer Portal, despite DHL owning Blue Dart. A developer-portal app on its own gets you nothing; you need a commercial relationship with a human.

For tracking parcels I already have, that's ridiculous. But their public website tracks any waybill for free, and — crucially — **it renders everything server-side**. No JavaScript, no XHR to reverse-engineer: the shipment details and scan history are right there in the HTML. So the "adapter" is an HTTP GET and some parsing:

```typescript
const url = `${TRACK_URL}?trackFor=0&trackNo=${encodeURIComponent(cleaned)}`;
const res = await fetch(url, {
  headers: { "User-Agent": UA, Accept: "text/html" },
  cache: "no-store",
});
if (res.status === 429) throw new CarrierError("Blue Dart rate-limited", "rate_limited", 429);
if (!res.ok) throw new CarrierError(`Blue Dart upstream error (${res.status})`, "upstream_error", 502);
const html = await res.text();
```

Two things about scraping this page taught me something.

### The page always says 200 — so "did it work?" is the wrong question

My first not-found check was the obvious one: look for the "no information on this Waybill" message. It never fired. Every lookup, valid or garbage, looked successful.

The reason is a pattern I've now hit in two different projects: **the endpoint returns `200` unconditionally.** The "no information on this Waybill" copy lives in a hidden `<div>` that's present in the markup of *every* response, shown or hidden by the front-end — so searching for that text matched every time, valid waybill or not. The trick is to stop looking for the error and look for *success*: a result panel whose `id` is keyed to the waybill itself, which only exists when there's a real shipment:

```typescript
// Existence is signalled by a result panel keyed to the waybill
// (id="{awb}-rdrmv") — a POSITIVE signal, not the absence of the
// "no information" copy (which is in the markup of every response).
const panelRe = new RegExp(`id="${cleaned}-rdrmv"[\\s\\S]*?(?=<!--\\s*AWB${cleaned}\\s*-->|$)`, "i");
const panel = html.match(panelRe);
if (!panel) {
  throw new CarrierError("Tracking number not found", "not_found", 404);
}
```

It's a lesson I keep relearning across projects: **a `200`, or the presence of a page, is not proof the thing you asked for exists.** You have to check for the positive signal — the actual result panel — not the absence of an error, because the error text might be baked into every response.

### Selectors that expect to be broken

Scraping HTML is a promise that someone else's redesign will eventually break you. You can't prevent that, but you can decide *how* it breaks. Rather than brittle positional selectors ("the third `<td>` in the fifth table"), the parser matches on **label text** — find the `<th>` that says "Status," take the `<td>` next to it:

```typescript
// Escape regex metacharacters in the label (NOT the deprecated global escape()).
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Pull the value cell next to a <th> whose text matches the given label.
function fieldByLabel(html: string, label: string): string | undefined {
  const re = new RegExp(`<th[^>]*>\\s*${escapeRegex(label)}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i");
  const m = html.match(re);
  return m ? stripTags(m[1]) || undefined : undefined;
}
```

If Blue Dart reshuffles their table layout, restyles it, or adds columns, label-matching survives. It only breaks if they rename the labels themselves — the least likely change, and the one that'd be obvious to fix. When you know a dependency is fragile, **spend your effort making it fail gracefully and legibly, not on pretending it won't fail.**

## Delhivery: an API that only admits to its own shipments

Delhivery is the opposite shape. It *does* have a clean token-gated JSON API — no scraping. But there's a catch that dictates the whole adapter: **the token only returns shipments booked under that account.** There's no credential-free public endpoint (the public track page mints a short-lived runtime token you can't reliably replay). So this carrier can only ever answer for *my* AWBs, and for anyone else's it correctly returns not-found.

That single fact is a first-class property on the interface — `privateOnly: true` — so the UI can show an honest note instead of looking broken:

```typescript
export const delhivery: Carrier = {
  id: "delhivery",
  name: "Delhivery",
  privateOnly: true,      // only the operator's own AWBs; surfaced in the UI
  async track(trackingNumber, opts) {
    const token = opts?.delhiveryToken;
    if (!token) throw new CarrierError("Delhivery tracking is not configured.", "not_configured", 503);
    // ... Authorization: `Token ${token}`, parse JSON envelope ...
  },
};
```

Notice the credential comes in through `opts`, not from `process.env` inside the module. The carrier files stay pure — no environment coupling, no Cloudflare bindings — so they're trivially testable and the same code runs in the web app and the background poller. The one place that knows about secrets is the caller.

## The unglamorous glue: everyone's words for "delivered" are different

Blue Dart writes free-text English on a web page. Delhivery returns a coarse status code (`DL` delivered, `RT` returned, `PU` pickup) *plus* free text. Neither agrees with the other, and neither agrees with a third carrier. If the app is going to render one consistent timeline — and if the poller is going to reason about "did the status change" — everything has to funnel into a single vocabulary:

```typescript
export type ShipmentStatus =
  | "pending" | "picked_up" | "in_transit" | "out_for_delivery"
  | "delivered" | "exception" | "returned" | "unknown";
```

Each carrier owns a `mapStatus()` that translates its dialect into these eight words — Delhivery preferring its explicit code and falling back to keyword-matching the free text, Blue Dart matching phrases like "out for delivery" and "undelivered." It's tedious, unglamorous code, and it is the actual product. **A tracker's value isn't fetching a page; it's turning three carriers' incompatible notions of "where's my parcel" into one thing you can read at a glance.** The normalization layer is where that value lives.

## The poller: only email me when something changed

The web lookup is on-demand. The nicer feature is *watching* a shipment — I add it once and get an email when it moves. That's a separate Cloudflare Worker on a cron, and its one job is restraint: it must email me on a real status change and stay silent otherwise. An "your parcel is still in transit" email every hour is how you train someone to filter you to spam.

So on each poll it fingerprints the latest event and compares it to the last one it saw:

```typescript
const latest = result.events[result.events.length - 1];
const hash = await sha256Hex(`${latest.timestamp}|${latest.rawCode ?? ""}|${latest.description}`);
if (hash === w.last_event_hash) {
  await markPolled(env.DB, w.id);      // nothing new — record the poll, stay quiet
  return;
}
// ...changed → record the event, email the transition, store the new hash
```

Hashing timestamp + code + description means "changed" is precise: a new scan, a status flip, an exception. Re-fetching the same event a hundred times produces the same hash and zero emails. It's the exact same discipline as my [daily battery check](/posts/daily-battery-check/) — **only speak when there's something to act on** — just applied to parcels instead of batteries.

A few more touches that make it something I actually leave running:

- **Failures never cascade.** Each watch is polled independently and wrapped so one carrier being down (or one scrape breaking) can't sink the whole batch — `Promise.allSettled`, per-watch `try/catch`, a bad poll just logs and moves on.
- **It cleans up after itself.** Once a shipment is `delivered` or `returned`, it's marked terminal and purged a week later. No table full of parcels that arrived months ago.
- **The cleanup can't break the run.** The purge sweep is fired with `ctx.waitUntil` and its own `.catch` — a failure there must never block the actual polling.

## Takeaway

The naive version of this project is "fetch a tracking page and show it." The real version is an admission that **you don't control any of your upstreams and they don't want to cooperate** — one gatekeeps its API behind a sales call, one only tells you about its own shipments, all of them describe the world in different words, and any of them can change or break tomorrow.

The engineering is the containment: one interface every carrier must satisfy, each carrier's specific fight sealed inside its own module, a normalization layer that turns three dialects into one, and a poller built to stay quiet until there's genuinely something to say. The parcels are incidental. The design is entirely about not letting three uncooperative third parties leak their mess into the rest of the app — or into my inbox.
