# Contributing to SchemaLoom

Contributions are welcome: bug reports, fixes, features, and docs.

1. Open an issue first for anything larger than a small fix.
2. Fork, branch, and open a pull request.
3. Run `pnpm typecheck && pnpm lint && pnpm test` before you push.

## CI remote cache (maintainers)

CI shares Turborepo's build cache when the repository has it set up, which skips any task
whose inputs haven't changed since a previous run (roadmap 20). Once per repository:

1. Create a token at vercel.com → Account Settings → Tokens, and note the team's slug.
2. In GitHub → Settings → Secrets and variables → Actions, add the secret `TURBO_TOKEN` and
   the variable `TURBO_TEAM`.

Without them CI runs uncached, as before. Locally, `pnpm exec turbo login && pnpm exec turbo
link` uses the same cache.

## License of contributions

SchemaLoom is licensed under the PolyForm Noncommercial License 1.0.0 with the
additional terms in [LICENSE](LICENSE).

By submitting a contribution, you confirm that you wrote it (or have the right to
submit it), and you grant Kasra Karami a perpetual, worldwide, irrevocable,
royalty-free license to use, modify, sublicense, and distribute your contribution
as part of SchemaLoom under any license terms, including commercial ones. You keep
the copyright in your contribution.
