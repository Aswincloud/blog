# blog.aswincloud.com

Personal homelab / home-automation blog. Static site built with [Hugo](https://gohugo.io).

## Local preview
```
hugo server -D
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
