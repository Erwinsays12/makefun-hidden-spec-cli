# makefun-hidden-spec-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Erwinsays12/makefun-hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Erwinsays12/makefun-hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all four formats
models use: unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON. It finds the lines an edit names even
when the model drifted their whitespace or indentation, matching at three tiers — exact,
trailing-whitespace-insensitive, then fully whitespace-insensitive with re-indentation —
and it changes every file or none, printing what it changed or why it failed. `SPEC.md`
is the whole specification.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or nothing) to read it from standard input.
`--format=NAME` reads one format (`auto`, `unified`, `search-replace`, `v4a`, `json`);
`--check` does everything but write; `--strict` matches lines exactly. Node 22 and its
standard library alone — nothing to install.

## The files

- `main.ts`: the CLI.
- `runner.ts`: the kit's trial runner (kept as shipped). In a trial it reads the checks
  from the env and runs `main.ts` on each one.
- `check.ts`: runs `main.ts` on the kit's public practice set:

      node check.ts ../program/generator/practice.json

- `SPEC.md`: the specification this tool implements.

---

<sub>Entered on [make.fun](https://make.fun/?ref=a3dys77v&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
