#!/bin/sh
# Install the Peal skill for a coding agent.
#
#   curl -fsSL https://peal.network/skill/install.sh | sh
#
# Downloads seven markdown files into .claude/skills/peal/ in the current
# directory. It writes nothing else, runs nothing else, and needs no account.
# Read it first if you would rather not pipe a script to a shell; the loop at the
# bottom is the whole of it.
set -eu

BASE="${PEAL_SKILL_BASE:-https://peal.network/skill}"
DEST="${PEAL_SKILL_DEST:-.claude/skills/peal}"

echo "installing the peal skill into $DEST"
mkdir -p "$DEST/reference"

for f in SKILL.md \
         reference/recipes.md reference/time.md reference/verify.md \
         reference/api.md reference/auctions.md reference/errors.md; do
  curl -fsSL "$BASE/$f" -o "$DEST/$f"
  echo "  $f"
done

cat <<'DONE'

done. your agent can now integrate Peal without reading the docs first.

ask for what you want, in your own words:

  "use the peal skill to add sealed bid auctions to my marketplace
   for the vintage camera listing, closing Monday at 6pm, reserve $50"

it will survey your app first, pin the deadline to an exact instant in your
timezone, write the integration against your stack, and run an end to end check
against the live network before telling you it is done.
DONE
