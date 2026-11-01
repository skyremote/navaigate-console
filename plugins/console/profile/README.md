# Profile

Everything personal (machines and their roles, addresses, restricted workloads,
owner name, paths, pinned ids, feature picks) is read from one profile file that
lives outside the repositories, so it survives updates:

- `$NAVAIGATE_CONSOLE_PROFILE`, else
- `${XDG_CONFIG_HOME:-~/.config}/navaigate-console/profile.json`

No file means the community defaults in `community.defaults.json`: this Mac only,
every remote feature off until configured. The Console's setup screen writes the
file. Secrets never go in it; it only names the bb secret or environment variable
to read.

Precedence, highest first: the plugin's own bb settings, then the profile, then
the community defaults.

`schema.ts` (pure, browser-safe), `load.ts` (server only), `community.defaults.json`,
`profile.test.ts` and this README are byte-identical in the Console, Fleet and
Helper Desk. Change the canonical copy, copy it to all three, and update
`SHARED.sha256` (`shasum -a 256 schema.ts load.ts community.defaults.json profile.test.ts README.md > SHARED.sha256`).
Plugin-specific keys go under `plugins.<name>` and are validated in that plugin's
own module, never here.
