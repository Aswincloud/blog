#!/usr/bin/env bash
# Run once after cloning to activate the secret-scanning pre-commit hook.
git config core.hooksPath .githooks
echo "✓ pre-commit secret scanner active (.githooks/pre-commit)"
echo "  Optional: cp .secrets-denylist.example .secrets-denylist and add exact secrets."
