---
title: "I pasted the same crypto into four sites. Then I stopped."
date: 2026-07-05
description: "Every self-hosted site I built needed the same login plumbing — signed sessions, password hashing, a constant-time compare. I copy-pasted it four times before admitting that's a security bug waiting to happen, and extracted it into one zero-dependency package that's public on purpose."
slug: "auth-primitives-extracted"
---

Every small site I self-host eventually needs the same boring thing: let me — and only me — sign in. A signed session cookie, a hashed password, an owner allowlist. Nothing novel; the same forty lines of Web Crypto I'd already written.

So the first time, I wrote it. The second time, I copied it. The third time, I copied it again. The fourth time I went to paste it, I finally looked at what I was doing and stopped — because I'd noticed the specific way this ends badly.

## The moment it became a bug instead of a convenience

Here's the comment I eventually wrote at the top of one extracted file. It's the whole reason this project exists:

```typescript
/**
 * base64url encode/decode (no padding).
 *
 * This exact pair was copy-pasted into 4 places across the sites
 * (console/crypto.ts, shiptrack/passwords.ts, shiptrack/tokens.ts,
 * status/auth.ts). It lives here once now.
 */
```

Four copies of the same security-sensitive helper, in four repos. Think about what that means the day I find a bug in it — a padding mistake, a subtle decode issue. I fix it in the site I happened to be working in. The other three keep the flaw. There is no version, no changelog, no way to even *know* which sites have the fixed copy. Copy-paste turns one fix into three silent omissions, and for auth code specifically, a silent omission is a vulnerability sitting in production with my name on it.

The same rot had spread through everything security-critical: the PBKDF2 password hashing was "extracted verbatim from shiptrack," the HMAC token signing was "extracted from shiptrack and generalized," the constant-time compare was, in its own words, "re-implemented in 4 files across the sites." Four hand-copied implementations of *constant-time comparison* — the one function whose entire job is to be subtly, exactly correct.

That's when duplication stops being a code-smell and becomes a liability. So I pulled it all into one package, [`@aswincloud/auth`](https://github.com/Aswincloud/auth) — published, versioned, tested, **zero runtime dependencies** — and now every site imports the same audited copy. Fix it once, bump the version, every site gets it.

## The parts that are easy to get subtly wrong

Extracting it forced me to actually understand the code I'd been copying, and three pieces are worth showing because they're the ones people (me, four times) get *almost* right.

### Constant-time comparison

When you check a signature or a token, the naive `a === b` returns early at the first differing byte. That early-exit is a timing oracle: an attacker measuring response times can recover a secret one byte at a time. The fix is to compare *every* byte regardless, accumulating differences:

```typescript
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
```

No `break`, no early `return` inside the loop — it always walks the whole array and only tells you the answer at the end. It's four lines, and it's exactly the kind of thing you do not want four hand-copied versions of, because the "optimization" of returning early is *right there* tempting every future edit.

### PBKDF2, and the cap Cloudflare won't tell you about until you hit it

Passwords are hashed with PBKDF2-SHA256 via Web Crypto — no bcrypt, no native module, because a Cloudflare Worker doesn't have Node. The stored format carries its own parameters so old hashes stay verifiable if I change them later:

```typescript
// Stored format:  pbkdf2$<iterations>$<salt_b64url>$<hash_b64url>
const ITERATIONS = 100_000;   // Cloudflare Workers caps PBKDF2 at 100k
const SALT_BYTES = 16;
const HASH_BYTES = 32;

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000) return false;
  const salt = b64urlDecode(parts[2]);
  const expected = b64urlDecode(parts[3]);
  const actual = await derive(plain, salt, iterations);
  return constantTimeEqual(expected, actual);   // ← constant-time, again
}
```

Two things I learned the hard way. First, **Workers cap PBKDF2 at 100,000 iterations** — ask for more and it throws at runtime, not at deploy. You find out in production. Second, the verify reads the iteration count *out of the stored hash* rather than assuming the current constant, so raising the work factor later doesn't lock anyone out of their existing password. And the final comparison goes through the same constant-time function — because "did the password match" is exactly the check you must not leak timing on.

### A bad token is "invalid," not an error

Signed tokens are `base64url(payload).base64url(sig)`, HMAC-SHA256, with the token's **purpose bound into the signature** — so a password-reset link can never be replayed as a session cookie. The verify path has a detail that took me a beat to get right: a malformed token should quietly fail, not throw.

```typescript
export async function verifyToken(secret, token, purpose): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = await hmac(secret, body);
  let payload;
  try {
    // atob() throws a DOMException on garbage input. A bad token is "invalid",
    // not an exception, so swallow and return null.
    const actual = b64urlDecode(sig);
    if (!constantTimeEqual(expected, actual)) return null;
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (payload.p !== purpose) return null;                    // wrong purpose
  if (payload.e && payload.e < Math.floor(Date.now()/1000)) return null;  // expired
  return payload.s ?? null;
}
```

The whole surface of this function is "returns the subject, or `null`." A random string in the cookie, a truncated token, a signature over the wrong purpose, an expired link — all of them are just `null`, handled identically to "no token at all." An auth check that can *throw* on hostile input is an auth check with a second, uglier failure mode; collapsing every bad case to a single clean "not authenticated" is the point.

## Public on purpose

Here's the part that feels wrong the first time and is actually the whole design: **this package is open source, and that's a security feature, not a risk.**

> Security rests on your per-site `SESSION_SECRET`, not on this code being private.

Every consuming site brings its own D1 database and its own secret. Nothing in the package links sites together; there are no shared credentials baked in, nothing to leak by publishing it. If the security of the code depended on nobody reading it, it would already be broken — that's just obscurity, and obscurity is what you lean on when you're not sure the real mechanism holds. Making it public is a forcing function: the HMAC secret is the *only* thing standing between a forged cookie and my dashboard, which is exactly where the security should live.

And because "who's allowed in" is a per-site decision, that's a parameter, not a fork. One function, three modes, and a **safe default**:

```typescript
export function parseAccessMode(raw: string | undefined): AccessMode {
  const m = (raw ?? "").trim().toLowerCase();
  // Unknown or empty falls back to "owners" — the strict "only me".
  return m === "public" || m === "domain" || m === "owners" ? m : "owners";
}
```

A typo in the config, or an unset env var, doesn't fail *open* to `public` — it fails *closed* to `owners`, the most restrictive mode. The direction a default fails is a real decision, and for an access policy it must fail toward "locked."

## Takeaway

The code in this package isn't clever. Constant-time compare, PBKDF2, HMAC tokens, an allowlist — it's the standard stuff, and the standard stuff is standard precisely because it's the part you must not improvise. The lesson wasn't in writing it. It was in noticing that I'd written it *four times*, that four copies of security code is four chances to fix a bug in only three of them, and that the honest fix is the un-glamorous one: extract it, test it, version it, publish it, and let the per-site secret — not the secrecy of the code — be the thing that keeps me the only one who gets in.

It's the same instinct as everything else I self-host: a [battery check that only speaks when something changed](/posts/daily-battery-check/), a status page that refuses to show false-green, an auth library that fails closed. The interesting part is never the happy path. It's deciding, on purpose, how the thing behaves when something is wrong.
