# Contributing to Spoolfree

Thanks for helping! Issues and pull requests are welcome.

## Development setup

See *Quick start* in the [README](README.md). In short:

```bash
pnpm install
docker compose up -d postgres
cp .env.example .env && pnpm keygen --env >> .env   # then set DEV_FAKE_AD=1, DEV_LOGIN=1, AUTH_SECRET
pnpm seed:dev && pnpm dev:printers & pnpm dev
```

## Before opening a PR

```bash
pnpm typecheck
pnpm lint
pnpm test                      # Vitest: resolution, IPP encoder, manifest signing, mocked LDAP
pwsh -c "Invoke-Pester agent/tests"   # or Windows PowerShell 5.1 with Pester 5+
```

CI runs the same checks.

## Ground rules

- **UI:** use official [shadcn/ui](https://ui.shadcn.com) components only, added with `pnpm dlx shadcn@latest add <component>`. Don't hand-roll primitives or edit `src/components/ui/*`. Compose them in `src/components/app` or the page instead.
- **Pure logic first.** Policy resolution (`src/lib/resolve.ts`), IPP encoding (`src/lib/ipp`), and manifest building and signing are pure and unit-tested. Keep new logic testable the same way.
- **Agent:** must stay compatible with Windows PowerShell 5.1.
  - Keep script files ASCII; PS 5.1 reads BOM-less files as ANSI.
  - Put logic in `Spoolfree.Agent.psm1`, with Pester tests.
- **Security-sensitive changes** (auth, manifest format, agent token handling) need an update to [SECURITY.md](SECURITY.md).
- **Database changes:** edit `src/lib/db/schema.ts`, then `pnpm db:generate` and commit the migration in `drizzle/`.
- **No organisation-specific data** in code, docs or tests. Use `example.org` and `192.0.2.0/24`.
- **Commits:** small and focused, with a clear message. By contributing you agree your work is licensed under the MIT licence.
