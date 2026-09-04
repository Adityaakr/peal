#!/bin/sh
# Install the Peal skill for a coding agent.
#
#   curl -fsSL https://peal.network/skill/install.sh | sh
#
# Downloads four markdown files into .claude/skills/peal/ in the current
# directory. It writes nothing else, runs nothing else, and needs no account.
# Read it first if you would rather not pipe a script to a shell; the four curl
# commands at the bottom are the whole of it.
set -eu

BASE="${PEAL_SKILL_BASE:-https://peal.network/skill}"
DEST="${PEAL_SKILL_DEST:-.claude/skills/peal}"

echo "installing the peal skill into $DEST"
mkdir -p "$DEST/reference"

for f in SKILL.md reference/api.md reference/auctions.md reference/errors.md; do
  curl -fsSL "$BASE/$f" -o "$DEST/$f"
  echo "  $f"
done

cat <<'DONE'

done. your agent can now integrate Peal without reading the docs first.

  ask it: "add a sealed bid auction to this app using peal"

the skill covers rounds, seals, auctions, the money rules, the limits and the
error codes, and the mistakes that produce code which looks right and is wrong.
DONE
