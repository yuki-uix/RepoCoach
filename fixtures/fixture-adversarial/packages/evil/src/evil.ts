// A sub-package so the malicious workspace globs in the root package.json /
// pnpm-workspace.yaml are actually evaluated against a real directory. The
// `../../**` and `/` patterns must match nothing; `**` may match this in-repo
// package but must never escape the repository.
export function evil(): void {}
