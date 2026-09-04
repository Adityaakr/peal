// Copies skills/ into the explorer's public directory, so the skill is served
// from the same origin as the API it describes and the install script needs no
// registry, no package and no account.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const explorer = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = dirname(dirname(explorer));
const to = join(explorer, 'public', 'skill');

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
// Flattened: the skill files sit at /skill/SKILL.md rather than
// /skill/peal/SKILL.md, so the URLs read as addresses rather than as a
// directory listing, and the installer needs no nested base path.
cpSync(join(repo, 'skills', 'peal'), to, { recursive: true });
cpSync(join(repo, 'skills', 'install.sh'), join(to, 'install.sh'));
console.log('skill copied to public/skill');
