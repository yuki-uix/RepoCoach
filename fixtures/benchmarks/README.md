# Benchmark fixtures

`real-repos.json` defines the repeatable cost-comparison benchmarks used by
`pnpm eval:bench` (`node dist/eval/bin.js bench`). Each entry pins a repository
to a commit SHA and a feature to a fixed `(featureId, featureGoal, entryFiles)`
triple plus scripted learner answers, so every run of a benchmark explores the
same code path. Without the pin, the model picks a different feature candidate
each run and the token totals are not comparable.

## Pinning a commit SHA

The `repositoryId` uses the `<url>#<sha>` form. The SHA is the 40-character
full commit hash; the reader fetches and checks out exactly that commit, so two
runs on different days read the same tree.

To (re)pin a benchmark to a release tag:

```
git ls-remote https://github.com/colinhacks/zod.git refs/tags/v3.24.1
git ls-remote https://github.com/honojs/hono.git refs/tags/v4.6.14
```

Paste the first 40-hex column of the matching line into the `repositoryId`
`#<sha>` suffix.

## Why this mode is manual

`eval:bench` is **not** wired into CI. Every run makes real provider calls and
spends real money, so it is a manually-triggered before/after tool: run it once
before a change and once after, then diff the two `bench-report.json` files.
