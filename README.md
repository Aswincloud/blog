# blog.aswincloud.com

Personal homelab / home-automation blog. Static site built with [Hugo](https://gohugo.io).

Custom theme (no external Hugo theme): a Swiss-modernist editorial layout —
Inter + JetBrains Mono, a slate palette with a terminal-green accent, light/dark
modes (follows the OS, remembers your choice), terminal-framed code blocks with
copy buttons, heading anchors, and a reading-progress bar. Layouts live in
`layouts/`; styles/JS in `assets/` (bundled + fingerprinted via Hugo Pipes).

## Local preview
Requires the **Hugo _extended_** binary. Match the deployed version — it's pinned
in `.hugo-version` (currently `0.163.3`):
```
hugo server -D
```
No Hugo installed? Grab the pinned extended build (Linux x86-64) without sudo:
```
VER=$(cat .hugo-version)
mkdir -p ~/bin   # ensure it exists and is on your PATH
curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${VER}/hugo_extended_${VER}_linux-amd64.tar.gz" \
  | tar -xz -C ~/bin hugo
```

## Deploy
Hosted on **Cloudflare Pages** — every push to `main` auto-builds and publishes to https://blog.aswincloud.com.

Build settings (set in Cloudflare Pages):
- Framework preset: **Hugo**
- Build command: `hugo --gc --minify`
- Build output directory: `public`
- Environment variable: `HUGO_VERSION = 0.163.3`

## Writing a post
Add a markdown file under `content/posts/`, e.g. `content/posts/my-post.md`, with front matter:
```
---
title: "..."
date: 2026-07-04
description: "..."
slug: "my-post"
---
```

## Secret scanning (pre-commit)

A pre-commit hook blocks commits that look like they contain secrets (tokens,
private IPs, `password:` lines, private keys) plus any exact strings you list in
a gitignored `.secrets-denylist`.

**Activate after cloning (once):**
```
./setup-hooks.sh
```
This sets `core.hooksPath=.githooks` and makes the hook executable.

Bypass a false positive (rare, review first): `git commit --no-verify`.

