# tuipr

**Terminal review workstation for agent-generated pull requests.**

Coding agents can open PRs faster than you can read them. The bottleneck is no
longer writing code or even reviewing mechanics — it is human attention and
spend discipline. tuipr is a TUI that puts a human gate in front of the
merge: a PR queue with computed landability, hunk-level diff review, budgeted
AI review runs, and approvals that leave an attestation in the audit trail.

## Status

Early extraction in progress. The tool exists and is in daily use in a private
setting; it is being generalized and published here piece by piece. Not yet
installable — watch the repo if you're interested.

## What it does

- **Queue** — every open PR with its computed status (landable / conflicted /
  blocked / draft), reconstructed from git and the GitHub API, stacked PRs
  rendered under their base.
- **Review** — hand the terminal to a hunk-level diff viewer, comment inline,
  upload findings as a single GitHub review.
- **AI review, budgeted** — run a coding agent on the selected PR in the
  background with an explicit spend cap; findings land as notes in the diff
  viewer. Deliberate friction against accidental double spend.
- **Gates** — merge behind independent gates; approvals write an attestation
  body into the GitHub audit trail so intent survives outside shell history.

## Design principles

- Fail closed. Silent success is a bug class, not a convenience.
- Spend is a decision, not a side effect.
- Provenance over convenience: what happened must be reconstructible from the
  audit trail alone.

## License

MIT
