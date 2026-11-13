---
title: "A PR I didn't open, a stealer I didn't write, and why it got almost nothing"
date: 2026-11-13
draft: true
description: "A token I'd forgotten about let an automated campaign push a CI credential stealer straight onto main in two of my repos. Here's how I spotted it, what it actually ran and stole, the one thing that leaked it seven months earlier, and the boring habits that kept the damage small."
slug: "a-forgotten-token-and-a-supply-chain-stealer"
---

It started with a pull request I didn't remember opening.

`docs: dependency audit notes`. One new file, three lines of markdown about "routine supply-chain review." Authored by me. Approved, within seconds, by my own auto-approve bot, because I'm an admin and that's what the bot does for admins.

I hadn't written it. And when I went looking, there were four of them, in four repos, about four minutes apart.

## The decoy and the real thing

The markdown PRs were harmless on purpose. They were a probe: *can this token write here, and does anything stop it?* My auto-approve workflow answered that question very helpfully.

The real payload never went through a PR at all. In two repos, the same identity pushed straight to `main`:

```text
chore: add ci helper      <- adds .ci-k801y6.sh (1,493 lines)
chore: add ci helper      <- adds "postinstall": "sh ./.ci-k801y6.sh" to package.json
ci: restore               <- removes the hook
ci: cleanup               <- removes the script
```

Four commits in about thirty seconds, and the net diff was zero. In between, the CI run that executed the script was deleted, logs and all.

The trick is the `postinstall` hook. npm runs it automatically after every install, so any build that does `npm install` runs the attacker's script with whatever credentials that build has, and with its output sent to `/dev/null`.

## What the script actually does

I pulled the script out of git history before cleaning up and read all 1,493 lines. It's a general-purpose CI credential harvester, and a well-engineered one:

- every environment variable of every process on the runner;
- a memory scan of running processes for anything token-shaped (GitHub, AWS, Anthropic, OpenAI, Hugging Face, JWTs);
- credential files for AWS, Azure, GCP, Docker, Kubernetes, npm, PyPI;
- login files for AI coding tools: Claude Code, Codex, Gemini and friends;
- a copy of the repo, keeping anything that looks like a secret;
- if the workflow is allowed to mint cloud OIDC tokens, it tries to turn them into AWS/GCP/Azure sessions and escalate from there.

Then it zips everything and POSTs it to a server. One detail made the forensics easy: **it exits 0 if the upload worked and 42 if it didn't, which fails the build.** So a green build after that commit means the upload *succeeded*.

This turned out to be one small corner of a much larger campaign. StepSecurity has [a detailed write-up of "WFX Phantom"](https://www.stepsecurity.io/blog/wfx-phantom-the-github-actions-secret-stealer): tens of thousands of probe PRs and thousands of repos since 10 November, all using the same playbook. Searching GitHub code for the collection server's address found hundreds of repositories carrying the identical script, all committed the same day.

## Where it ran, and what it got

This is the part I care about most, because the answer was "a lot less than it could have."

| Where the script could run | Did it run? | What it could take |
|---|---|---|
| GitHub CI, repo A | No: CI installs with `--ignore-scripts` | nothing |
| GitHub CI, repo B | **Yes** | the job's short-lived token, plus any org secrets that job could see |
| Cloudflare Workers build, repo A | **Yes**, and the build went green | **the Cloudflare build token** |
| The deployed app | No | runtime secrets never enter a build |

The same repo was protected in one pipeline and not in the other. GitHub CI had `npm ci --ignore-scripts`, a habit from months ago. Cloudflare's build ran a plain `npm clean-install`, so the hook fired there and took the build's API token.

What it **didn't** get is everything that matters: payment keys, the bot's API keys, customer data. Those live only as runtime secrets on the deployed Workers, set with `wrangler secret put`, and no build ever sees them. The stealer can only take what's in the room, and I'd kept the valuable things out of the room.

## The root cause was seven months old

The token the attacker used was a classic GitHub PAT with `public_repo` scope. I went looking for where it could have come from, and found it in an old chat log.

In April, an AI coding agent was wiring up a quote form on my 3D-printing site. The form needed to trigger a GitHub workflow, the agent asked for a `public_repo` token, and I pasted one in. It then **injected that token into the site's client-side JavaScript at deploy time**, so the browser could call GitHub directly.

Anyone who opened the page source could read it.

The site later moved off GitHub Pages to a Cloudflare Worker, with a server-side endpoint and a code comment explaining exactly why the old approach was dangerous. But the token itself was never revoked. It sat in caches and archives of the old JavaScript, valid and unexpiring, until somebody's scraper found it.

> A token in client-side code is a published token. And a token you stop using is still a token until you revoke it at the source.

## The clean-up, in the order that mattered

1. **Revoke.** I revoked every personal access token on the account at once, within two minutes of the attacker's last push. All further activity stopped.
2. **Roll what was stolen.** The Cloudflare build token was rolled and builds were moved to a fresh one.
3. **Find what else it touched.** I compared run numbers across every workflow in the org. Deleted runs leave gaps, and there were exactly two, matching the two pushes I already knew about. I also searched every repo for the campaign's commit messages, branch names and script names.
4. **Assume the wider blast radius.** The write-up pointed out something I'd underestimated: the script reads the runner's memory, which holds *every secret the job could access*, not only the ones the workflow names. So I'm rotating every organisation secret those two jobs could see, even though none show signs of use.
5. **Undo the damage.** I closed the decoy PRs, deleted the branches, reverted a deployment-protection rule they'd emptied, removed the attacker's commits from `main`, and cleared CI caches written while the script was running.
6. **Report it.** I reported the server to its host and upstream networks, and filed the incident with my national CERT.

## What I changed so it can't happen the same way again

- **Install scripts off in every build**, not just GitHub CI: `NPM_CONFIG_IGNORE_SCRIPTS=true` on every Cloudflare Workers build trigger. I tested every repo's build first; none actually needed install scripts.
- **No secrets in front-end code, ever.** If a browser needs to trigger something privileged, it calls my server, and my server holds the secret.
- **GitHub Apps instead of personal tokens** for automation. App tokens are minted per run and expire within an hour. My daily security scan now authenticates this way instead of with a long-lived PAT.
- **Harden-Runner on CI jobs**, in audit mode for now, to learn what each job normally talks to before switching to an egress allowlist. With an allowlist in place, the stealer's upload would have been refused.
- **Pinned actions to commit SHAs**, and least-privilege `permissions:` blocks on every workflow.
- **Admins can't push to `main` directly.** My rulesets let admins bypass "require a pull request", which is exactly the door the attacker walked through with my token.

## The part I want to remember

I spotted this because one PR looked wrong. That was luck. Everything after that was not: the damage stayed small because of decisions made months earlier for unrelated reasons. `--ignore-scripts` in CI. Runtime-only secrets. A token scoped to public repos instead of "select all."

The lesson isn't "be quicker next time." It's to make the room boring: few secrets in builds, short-lived credentials, nothing valuable reachable by the code that installs dependencies. Then when something does get in, there's nothing much to take.
