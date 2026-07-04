#!/usr/bin/env bash
# Run ONCE after cloning to activate the secret-scanning pre-commit hook.
set -e
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit
echo "✓ pre-commit secret scanner active"
[ -f .secrets-denylist ] || { cp .secrets-denylist.example .secrets-denylist 2>/dev/null && \
  echo "✓ created .secrets-denylist (edit it: add your exact secret strings)"; }
echo "  Test it:  echo 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' > /tmp/t && git add -A && git commit -m x"
