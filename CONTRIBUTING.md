# Contributing

Thanks for your interest in improving FreshBooks MCP. This is a small project — bug
reports, fixes, and new tools are all welcome.

## Setup

Requires Node.js 18 or newer.

```bash
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
npm run setup    # interactive: OAuth flow + config generation
npm run build
```

`npm run setup` walks you through the FreshBooks OAuth flow and writes your
credentials. If you prefer, copy `.env.example` to `.env` and fill it in by hand.

## Dev scripts

```bash
npm run dev       # run the server with ts-node (no build step)
npm run lint      # ESLint
npm run format    # Prettier
npm test          # test suite
npm run build     # compile to dist/ — run this before opening a PR
```

## Adding a new tool

1. Define the tool with the `tool()` helper in the relevant
   `src/tools/<domain>.ts` file (create a new file for a new resource domain).
2. Register it in `src/tool-registry.ts`.
3. Run `npm run build` to confirm it compiles cleanly.

The `freshbooks_help` tool has an "extending" topic that walks through this in
detail, and `CLAUDE.md` documents the FreshBooks SDK gotchas worth knowing — read
both before writing a tool. In short: handlers must never throw, payloads must be
typed against the SDK model interfaces (no `as any`), and monetary amounts are
strings (use `big.js` for arithmetic).

## Commits and pull requests

- Branch off `main` for your work.
- Use prefixed commit messages: `fix:`, `feat:`, `docs:`, `chore:` — one logical
  change per commit.
- Run `npm run build` and `npm run lint` before pushing.
- Open a PR against `main` describing what changed and why. If you fixed a tool,
  note how you verified it.
