# FreshBooks MCP — Setup Guide

This guide connects the FreshBooks MCP server to Claude, so you can run your
accounting by talking to Claude in plain English — *"who owes me money?"*,
*"create an invoice for Acme for 10 hours of consulting"*, *"how much did I
spend on software this year?"*

**You do not need to know how to code.** You need a FreshBooks account, a Mac or
Windows computer, and Claude installed on that computer.

## Two readers, one guide

Every step below is written for two readers at once, and says which one it is
talking to.

**If you are a person:** work top to bottom. Each step says **who does this** —
you, or Claude, or either — how to check it worked, and what to do when it
doesn't. Nothing assumes you have done anything like this before.

**If you are Claude, installing this for someone:** this guide is your script.
Follow it exactly, in order. Each step carries two sections — *If Claude can run
commands on your computer* (what you do, and the wording to use) and *If you are
typing every command yourself* (the exact text to relay when you cannot act).
Do every step you can do yourself; for the rest give exact clicks or exact text,
one step at a time, and wait for the person to confirm. When the screen doesn't
match the guide, do not invent a method — use that step's troubleshooting table.

## Start by asking Claude

The shortest path is to let Claude drive. Open a fresh chat with the Claude you
want to use FreshBooks from, and paste [the kickoff prompt in README.md](README.md#install-it-by-asking-claude) — it tells Claude to fetch this
guide and follow it, including the parts only you can do.

Claude's first reply should quote this guide's opening heading and its final
line. That is how you know it is reading the real guide, all the way to the end,
instead of remembering an older version of this project.

You can also simply work through the steps yourself. Both paths end in the same
place, and the steps are the same either way.

## What you need before you start

- **Claude on your computer** — the Claude desktop app (from
  [claude.ai/download](https://claude.ai/download)), or Claude Code in a
  terminal window or IDE. This server runs on your machine, so a browser-only
  claude.ai tab cannot use it; the first step below sorts this out.
- **A FreshBooks account** — any regular plan. You will create a free
  "developer app" inside it. That is normal, and it is the longest step.
- **A Mac or Windows computer**, and some time. How much depends on who does the
  typing:
  **15 minutes if Claude can run commands for you; up to an hour your first time by hand.**
  Most of that hour is the one-time developer-app form below — the rest of the
  guide is short either way.

## The setup steps

Do these in order. A step that only applies to some people says so in its first
line, and the three per-login steps (naming, signing in, saving) repeat once for
every FreshBooks login you connect — most people connect exactly one.

<!-- The step blocks below are GENERATED from src/setup-flow.ts — the same data
     the setup program itself runs on. Never edit inside a marker pair; change
     the Book and run `npx ts-node scripts/generate-setup-docs.ts`. -->

<!-- setup-step:choose-claude BEGIN -->
## Which Claude will you use?

Ask which Claude the user chats with — the desktop app or a browser tab — because that is the install target.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

Ask the target question exactly; never infer the target from your own runtime. If the answer is claude.ai-web, deliver the isn't-supported script honestly (kickoff rule 4's exception). If the user pastes SETUP.md instead of you fetching it, confirm the paste by quoting its opening heading and final line — and if you received the wrong file say: "that looks like the project README — I need the file called SETUP.md; on the repository page click it, then use the copy button."

### If you are typing every command yourself:

Do you open Claude as its own app from your Dock or taskbar, or in a browser tab?

If you chat at claude.ai in a browser tab: this server runs on your computer, and a browser-only Claude isn't supported for chatting with it. Download the Claude desktop app from claude.ai/download, then come back and continue from here — this guide gets you ready for it.

**How to check it worked:** You know which Claude the server will be installed into.

**If something goes wrong**

| If you see | Do this |
|---|---|
| Claude can't read the web | If Claude says it can't read the web: on the repository page click the file named `SETUP.md`, press the copy button (two overlapping squares, top right of the file), and paste it into the chat. |
<!-- setup-step:choose-claude END -->

---

<!-- setup-step:get-project BEGIN -->
## Get the project onto the computer

Get the project folder onto the computer, by ZIP download or by the blessed fetch command.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

"I'll ask your approval between eight and ten times during this install — each time, I'll tell you first what the dialog will say and why it's safe." (State this BEFORE the first command; number every later pre-brief "approval N of about 9"; if the degraded path adds dialogs, say so and restate the remaining count.)

Fetch without git: `mkdir FreshBooks-MCP && curl -L https://github.com/kanjidoc/FreshBooks-MCP/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 -C FreshBooks-MCP`. Re-extracting over an existing folder is credential-safe (`.env`/`profiles/` are not in the tarball).

### If you are typing every command yourself:

Download: on the repository page click Code → Download ZIP, unzip it, and remember where the folder is. Mac tip: to point Terminal at it later, type cd, then a space, then drag the folder onto the Terminal window — then press Enter. Windows: type cd, a space, paste the folder's path from the Explorer address bar, then press Enter.

**How to check it worked:** A folder containing package.json exists.

**If something goes wrong**

| If you see | Do this |
|---|---|
| git asks to install developer tools | You don't need git — use the download command above (or the ZIP). |
<!-- setup-step:get-project END -->

---

<!-- setup-step:node-install BEGIN -->
## Install Node.js (the engine)

Check for Node.js 18 or newer and install it from nodejs.org if it is missing.

**Who does this:** you.

### If Claude can run commands on your computer:

Run the check yourself where you can; relay the install steps verbatim and wait.

### If you are typing every command yourself:

Open Terminal: press Cmd+Space, type Terminal, press Enter (Windows: open the Start menu, type cmd, press Enter).

First check: type `node --version` and press Enter. If it prints a version of 18 or higher, skip the rest of this step. If it says command not found — that's the expected answer, not something broken; it just means Node isn't installed yet.

Install: go to nodejs.org, click the big LTS button, open the downloaded file, and keep clicking Continue. Your Mac will ask for your password — that's the normal installer, not me. Then check again.

**How to check it worked:** `node --version` prints v18 or higher.

**If something goes wrong**

| If you see | Do this |
|---|---|
| still command not found after installing | Close the Terminal window completely and open a new one — it reads the new installation only on startup. |
<!-- setup-step:node-install END -->

---

<!-- setup-step:npm-install BEGIN -->
## Install the building blocks and build

Install the project's dependencies and build it, as one combined command.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

One pre-briefed approval for the combined command.

### If you are typing every command yourself:

In the project folder run: `npm install && npm run build` — one command, a few minutes. Near the end npm may print a line about vulnerabilities; that's a routine npm notice, not a problem with your setup.

**How to check it worked:** It ends without red ERR lines; a dist folder now exists.

**If something goes wrong**

| If you see | Do this |
|---|---|
| Cannot find module 'ts-node'... MODULE_NOT_FOUND | npm install hasn't run (or didn't finish) in this folder — run `npm install` and retry. |
<!-- setup-step:npm-install END -->

---

<!-- setup-step:build BEGIN -->
## Build the server

Compile the server so that dist/index.js exists.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

Normally folded into npm-install's combined command.

### If you are typing every command yourself:

If you ran the combined command above, this already happened. Otherwise: `npm run build`.

**How to check it worked:** dist/index.js exists.

**If something goes wrong**

| If you see | Do this |
|---|---|
| Cannot find module .../dist/index.js | Run `npm run build` in the project folder. |
<!-- setup-step:build END -->

---

<!-- setup-step:developer-app BEGIN -->
## Create your FreshBooks app connection

Create the FreshBooks developer app and collect its Client ID and Client Secret.

**Who does this:** you.

### If Claude can run commands on your computer:

Relay one numbered item at a time; wait for confirmation each time.

### If you are typing every command yourself:

Sign in at freshbooks.com with your normal FreshBooks email — if FreshBooks emails you a code, that's their sign-in check, not part of this setup.

Open the Developer Portal: my.freshbooks.com/#/developer, click Create New App.

Application name: My Claude Connection — the name doesn't matter.

The form asks for an Application Type — choose Private App ("Not listed in the app store").

The Description box is optional (140 characters max) — any short sentence works, try: Lets me manage my own FreshBooks from Claude.

Scopes control what your connection can reach. The form starts with user:profile:read already added; click Add Scope and add every scope that starts with user: — one at a time, 46 more. It is a few minutes of clicking, one time, and it is what lets every FreshBooks feature work from chat.

Set the Redirect URI to exactly: https://localhost/callback — then read it back to yourself character by character.

Any field these steps don't mention: leave it as-is.

After saving, the page shows your Client ID and Client Secret. The Client Secret is hidden behind a Reveal (eye) toggle — click it before copying.

Already created this app once? Open it instead of creating another — click the Reveal (eye) toggle, and confirm the Redirect URI is still exactly https://localhost/callback.

Keep this page open — the next step needs both values.

**How to check it worked:** The app page shows a Client ID and a revealed Client Secret, and the Redirect URI reads exactly https://localhost/callback.

**If something goes wrong**

| If you see | Do this |
|---|---|
| the form shows something these steps don't mention | Read any red text to Claude first, then the labels of the boxes you're asked to fill, top to bottom — skip menus and banners. |
<!-- setup-step:developer-app END -->

---

<!-- setup-step:app-credentials BEGIN -->
## Hand over the app credentials

Hand the app credentials to the setup program without putting them in the chat.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

The reassurance line, delivered at exactly the paste prompt: "The portal tells you to keep this secret — correct. This is the one credential designed to be handed to me: I'll pass it straight to the setup program, never repeat it, and it can't touch your books by itself."

Then the secret-file pre-brief: "one longer command; your secret is read from a scratch file the setup program deletes itself — the dialog will not contain it."

Secret-file choreography (single approval, blessed shape): the agent writes the secret to `<project folder>/.client-secret.tmp` (covered by `.gitignore`'s `*.tmp`; `--doctor` warns if one is found lingering), then one approved command run from `<project folder>`: `npx ts-node scripts/setup.ts --headless --init --client-id <id> --client-secret-file .client-secret.tmp` — the CLI reads the file once and immediately deletes it (before doing anything else with the secret; the delete runs unconditionally, success or failure, and the CLI errors loudly if it fails) — so the secret's on-disk lifetime ends the moment the CLI starts, and a crash-before-read leftover is caught by `--doctor`'s lingering-tmp check. Honest window: between the agent's file-write and the CLI run the file sits at default permissions for seconds — unavoidable with agent file tools (a shell-side `umask` write would put the secret into the approval dialog, which is worse).

Confirm receipt by shape, never echo: "that looks right — about 32 characters — I won't repeat it again."

If the user volunteers the secret in chat on rung 3: acknowledge, never repeat it, and offer rotation — before the credentials are entered into the setup program, rotate freely; after, rotate and then redo this step.

Rung-3 wizard handoff (this is the first wizard-owned stretch): "The setup program is the guide now — follow its questions; I'll stand by until it prints DONE! or something surprises you." Never pre-narrate the wizard's prompts.

### If you are typing every command yourself:

In the same Terminal window type `npm run setup` and press Enter — the setup program starts and asks its questions right there.

Copy the Client ID and Client Secret from the portal page and paste these only into the setup window — never into this chat.

**Where each credential may go**

| Credential | If Claude can run commands on your computer | If you are typing every command yourself |
|---|---|---|
| Client ID + Secret | User pastes into chat **by design** (reassurance line at exactly that prompt); agent passes the secret to `--init` via **`--client-secret-file`** (preferred — the CLI reads, uses, and shreds the file itself, so a failed cleanup is a loud CLI error, not a forgotten agent step) or `--client-secret-stdin`; never argv. Agent confirms by shape, never echoes. | Only into the wizard's terminal prompt; humanScript: *"paste these only into the setup window — never into this chat"*; volunteered-slip script per `app-credentials`. |
| Authorization code | Transits chat; single-use, minutes-lived. It also appears inside the `--add-login` approval dialog — pre-briefed (see `save-login`). | Pasted into the wizard. |
| Access/refresh tokens | **Never** in chat, stdout, or argv, any rung. | Same. |

**Not sure which column is yours?** has Claude been asking permission to run things, or only telling you what to type?

**Honest notes on the above:**

- The durable transcript residue is the app-credential pair — its long-term weight is that it converts any future token-file leak into full API access (a refresh needs client id + secret + refresh token) and enables a convincing re-consent phish via the app's own auth flow; the residual controls are the fresh browser Allow every grant requires and kickoff rule 6's no-transmit hard stop.
- The secret-transport claim, stated precisely: the secret never appears in argv, `ps`, shell history, or the Bash approval dialog; it appears once in the agent's file-write (the same exposure class as the user's own paste into chat).

**How to check it worked:** The setup program (or --init) reports the credentials saved.

**If something goes wrong**

| If you see | Do this |
|---|---|
| pasted value much shorter than ~32 characters | The paste truncated — reveal the secret again and copy the whole value. |
<!-- setup-step:app-credentials END -->

---

<!-- setup-step:migrate-legacy BEGIN -->
## Move an older single-login setup into a named profile

The setup program shows this step only if it applies to you.

Move tokens from an older single-login setup file into a named profile file.

**Who does this:** you.

### If Claude can run commands on your computer:

Headless verbs refuse this state (exit 9); tell the user to run `npm run setup`, wait for their confirmation, then resume with `--doctor`. Never pre-narrate the wizard's prompts.

### If you are typing every command yourself:

You have tokens from an older version of this project stored in the main .env file; the setup moves them into their own profile file, keeping everything you had.

Before saying yes: fully quit Claude (and any other program running this FreshBooks server). Here's why, in plain terms: FreshBooks hands out a one-time key that gets swapped for a new one every time it's used. If two programs hold the same key and both try to use it, FreshBooks locks the whole chain and you'd have to reconnect from scratch. Quitting first makes sure only the setup holds the key.

Answering no just skips the move for now — nothing is deleted.

**How to check it worked:** The wizard prints Migrated existing tokens → profiles/<name>.env.

**If something goes wrong**

| If you see | Do this |
|---|---|
| migration says a server appears to be running | Something still holds the tokens — fully quit Claude Desktop (Cmd+Q) and any Claude Code sessions, then re-run `npm run setup`. |
<!-- setup-step:migrate-legacy END -->

---

<!-- setup-step:nickname BEGIN -->
## Name this login

Pick the short name this FreshBooks login will be known by.

**Who does this:** you or Claude.

This step repeats once for every FreshBooks login you connect.

### If Claude can run commands on your computer:

First login: choose `main` yourself and inform ("I'll call this login main — you'd only ever type it if you add a second account"); ask only when profiles already exist. Validate + check availability BEFORE issuing the auth URL.

### If you are typing every command yourself:

Pick a short nickname for this FreshBooks login — lowercase letters and digits, like acme. From then on, when you have more than one login, you'll use it in chat: 'list unpaid invoices for acme'. With a single login you'll never need to type it.

**How to check it worked:** The name is accepted (no already-exists message).

**If something goes wrong**

| If you see | Do this |
|---|---|
| name already taken | That login may already be connected — ask Claude to run the setup doctor, and to reconnect it if needed. |
<!-- setup-step:nickname END -->

---

<!-- setup-step:authorize BEGIN -->
## Sign in and approve the connection

Sign in at FreshBooks, approve the connection, and copy the one-time code back.

**Who does this:** you.

This step repeats once for every FreshBooks login you connect.

### If Claude can run commands on your computer:

Issue `--auth-url` only after the nickname is validated; never open a browser yourself. After relaying the checklist, add (rungs 1–2 only — an approval dialog follows the paste there): "After you paste, stay with me — I need one more approval from you within a minute or two."

### If you are typing every command yourself:

1. Open the sign-in link the setup program just printed — copy it into your browser (or hold Cmd and double-click it).

2. Sign in (use a private/incognito window if connecting a second account) and click Allow.

3. Your browser will land on a page that CAN'T BE REACHED — that's normal and means it worked. The address bar now holds a one-time code.

4. Click once inside the address bar so the whole address highlights, press Cmd+C (Ctrl+C on Windows), and paste it back.

**How to check it worked:** You pasted a long address starting with https://localhost/callback?code=...

**If something goes wrong**

| If you see | Do this |
|---|---|
| Closed the tab before copying? | Click the sign-in link again and re-Allow — no harm done. |
| the wizard says the address looks incomplete | That was only part of the address — click once in the address bar so the whole thing highlights, then copy again. |
<!-- setup-step:authorize END -->

---

<!-- setup-step:save-login BEGIN -->
## Save the login

Exchange the code, look up the account details, and save the login into its own profile file.

**Who does this:** you or Claude.

This step repeats once for every FreshBooks login you connect.

### If Claude can run commands on your computer:

Run `--add-login` immediately upon receiving the pasted address — the code lives minutes. Pre-brief its approval dialog: "the dialog will show the address you just pasted, including the long code — that's expected; it works only once and only with this approval."

If it asks which business (exit 6): relay labels only, numbered, never IDs — "Which business is this for: (1) …, (2) …?" — and map the answer to `--business-id` yourself.

If it reports the company is already connected (exit 8): relay the question exactly — This FreshBooks company (<company>) is already connected as '<existing profile>'. Is this a **different person's** login for the same company, are you **reconnecting** the login you already added — or did we pick the **wrong business** a moment ago? — and obey its directive: do not pass `--distinct-login` without an affirmative human reply in this conversation; anything short of a clear 'different person' is a no — re-ask once, then run `--doctor`.

### If you are typing every command yourself:

The setup finds this login's account details and saves them into its own profile file.

**How to check it worked:** It prints the login's nickname, company, and account ID (never tokens).

**If something goes wrong**

| If you see | Do this |
|---|---|
| exit 11 / could not look up the account details | Retry first — lookups usually fail transiently. If it keeps failing, ask Claude to run the setup doctor. Need to find the Account ID yourself? In FreshBooks, open any invoice — the web address becomes my.freshbooks.com/#/invoice/XXXXXX-123, and the letters and digits between /invoice/ and the dash are the Account ID. |
| quarantined profile mentioned | Two profiles share one company; the extra safety stays on until the duplicate is resolved — the doctor explains which file to remove or mark. |
<!-- setup-step:save-login END -->

---

<!-- setup-step:install-config BEGIN -->
## Connect the server to your Claude

Add the server entry to the chosen Claude's configuration file.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

Target: on agent rungs, take it from choose-claude; on the wizard surface this step asks its own target questions.

Pre-brief: "this next dialog will mention a file outside this folder — it's Claude's own settings file; this one Allow adds one entry to it, and approving it means you never edit a file by hand."

On deny, re-ask once, verbatim: "No problem — that dialog mentions a file outside this folder because it's Claude's own settings file. If you'd rather not approve it, I'll walk you through pasting one file in Claude's Settings screen instead — about five extra minutes. Or approve it once and I do it in five seconds. Want me to ask again?"

Degraded path (second deny, or exit 10, or sandbox): raw material from `--print-config` (denied-permission case) or the exit-10 payload — both emit command/args via the SAME command-selection rule as `--install` (probes + `--command-path` + `"node"` caveat); the degraded path is exactly where a sandboxed `process.execPath` would poison the host config by hand.

Disclosure first: "your Claude settings file may contain access keys for other connectors you've installed; showing it to me puts those in this chat." The agent keeps every foreign entry byte-identical in the merged file and never quotes their `env` values back outside the returned file itself.

Then the two-branch merge protocol: (1) pre-brief a read-only peek ("this dialog is me looking at the file — it changes nothing on disk"); if granted and the file is absent/empty → hand the user a COMPLETE file; if it has content → the agent merges and hands back the complete merged file; (2) if the read is denied too → the reveal script: "open Claude's Settings, choose Developer, then click Edit Config — a Finder window appears with a file highlighted; double-click that file (it opens in TextEdit); select everything you see and paste it to me" → agent returns the merged complete file.

Both branches end with the same self-contained insertion script: "open Claude's Settings, choose Developer, click Edit Config, and double-click the highlighted file — then in TextEdit select all, paste over everything, press Cmd+S" (Windows: the file opens in Notepad — select all, paste, Ctrl+S) (branch (2) already has the file open; repeating the open is harmless). A complete file is NEVER synthesized from the block alone when the current contents are unknown — that wipes existing `mcpServers` entries. If the degraded branch adds dialogs beyond the promised range, the agent says so and restates the remaining count.

Rung-2 mandatory confirmation: after a successful `--install desktop` under Cowork, the agent has the user visually confirm the entry via the Edit-Config door before the restart step. Three touchpoints; the alternative is the doctor→install→doctor sandbox loop. If the user reports the entry is NOT there, that IS the virtualized-sandbox signal: enter the degraded path immediately and never re-run `--install`.

### If you are typing every command yourself:

Manual Claude Desktop setup — if you skipped the automatic install, add the server to Claude Desktop yourself.

1. Open Claude Desktop's config file (create it if it doesn't exist). Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`. Windows: `%APPDATA%\Claude\claude_desktop_config.json`.

2. Add the block below, with the absolute path to your `dist/index.js`. It holds no credentials — the server reads those from `.env` itself:

```json
{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["<project folder>/dist/index.js"]
    }
  }
}
```

3. Fully quit and reopen Claude Desktop.

Manual Claude Code setup — the setup writes a project-scoped `.mcp.json` into the project folder; that's the file Claude Code reads when this folder is your open project.

To make FreshBooks available in every Claude Code project, register it at "user" scope with the `claude` command-line tool:

```bash
claude mcp add-json freshbooks '{"type":"stdio","command":"node","args":["<project folder>/dist/index.js"]}' --scope user
```

(Claude Code stores user-scoped servers in `~/.claude.json` — note that an `mcpServers` block in `~/.claude/settings.json` does not work.)

**How to check it worked:** Claude's config lists the freshbooks server (the install prints the exact file path it wrote).

**If something goes wrong**

| If you see | Do this |
|---|---|
| Edit Config opened a folder window, not an editor | That's right — double-click the highlighted file and it opens in TextEdit. |
<!-- setup-step:install-config END -->

---

<!-- setup-step:verify BEGIN -->
## Check everything

Run the setup doctor and confirm every check passes.

**Who does this:** you or Claude.

### If Claude can run commands on your computer:

Run `--doctor`; read failing checks' fix texts aloud; act only within them.

### If you are typing every command yourself:

Ask Claude to run the setup doctor — or do it yourself in Terminal. First point Terminal at the project folder: type cd, then a space, then drag the project folder onto the Terminal window — then press Enter.

Then run: `npx ts-node scripts/setup.ts --headless --doctor`. Every line should say pass.

**How to check it worked:** Doctor exits with all checks passing.

**If something goes wrong**

| If you see | Do this |
|---|---|
| Cannot find module './setup.ts' | Terminal isn't in the project folder — type cd, then a space, drag the project folder onto the Terminal window, press Enter, and run the command again. |
| config entry missing but a previous session said install succeeded | The write was virtualized by the sandbox — use the manual Edit Config route now; do NOT re-run `--install`. |
| command isn't an absolute path | Either a legacy entry (re-run `--install`) or the deliberate sandbox fallback ('node') — the doctor's line says which. |
<!-- setup-step:verify END -->

---

<!-- setup-step:restart BEGIN -->
## Restart Claude and say hello

Restart Claude and confirm the FreshBooks tools answer.

**Who does this:** you.

### If Claude can run commands on your computer:

Deliver the ENTIRE parting note before the user restarts (your session may end with it). Failure lines, per rung — rung 2: "open a new chat in this folder and paste: Run the FreshBooks setup doctor and follow SETUP.md's troubleshooting for whatever it reports." Rung 3: "open a new chat, paste the same kickoff prompt you started with, and add: The install finished but the test failed after restart."

### If you are typing every command yourself:

(Desktop) Our conversation is saved — nothing is lost when you quit.

1. Quit Claude completely: Cmd+Q, not just closing the window (Windows: quit from the system-tray icon).

2. Reopen it and open this same chat.

3. The first time a FreshBooks tool runs you'll see one more permission dialog — Allow it.

4. Type: List my recent FreshBooks invoices.

(Code) Start a new session in this folder; if asked to enable the freshbooks server, say yes; then type: List my recent FreshBooks invoices.

**How to check it worked:** Claude lists your invoices.

**If something goes wrong**

| If you see | Do this |
|---|---|
| no FreshBooks tools after restart | Make sure you fully quit (Cmd+Q) — then check the doctor; its config check names the file and path to inspect. |
<!-- setup-step:restart END -->

---

## You're set up — now what?

Talk to Claude in plain English. For example:

- *"How much did I invoice last month?"*
- *"Show me all my unpaid invoices."*
- *"Create an invoice for Acme Corp for 10 hours of consulting at $150/hour."*
- *"What were my biggest expenses this quarter?"*
- *"Show me a balance sheet as of June 30, compared to a year ago."*
- *"Run a profit & loss for this year on a cash basis."*
- *"Who owes me money, and how overdue are they?"* (accounts aging)
- *"Does my ledger balance?"* (trial balance)

There are **97 tools** in total. To see what is possible, ask Claude *"what
FreshBooks tools do you have?"* or *"show me the FreshBooks help."*

## Connecting more than one FreshBooks account

One server can manage several FreshBooks logins at once — useful if you keep
separate books for more than one company, or have been granted access to a
client's account. Each login is called a **profile**, and lives in its own
`profiles/<name>.env` file.

- **Add a login.** Run the setup again (or ask Claude to). It keeps the logins
  you already have and walks through authorizing another one — its own browser
  Allow, its own business selection. That is the naming / signing-in / saving
  trio of steps above, once more.
- **Name the account in your request.** With two or more logins configured, tell
  Claude which one you mean: *"list unpaid invoices for acme"*, *"add an expense
  to beta"*. With a single login you never need to name it.
- **Forgot the names?** Ask *"what FreshBooks accounts are configured?"* — Claude
  calls `freshbooks_list_accounts`, which lists each profile's name, company, and
  token health. (If you forget to name one when several exist, the server answers
  with the list of valid names rather than guessing.)

## Keeping it running

Each login's access expires every so often, and the server **refreshes it
automatically** — at startup and before every action. You should never have to
think about it.

If FreshBooks ever stops answering, run this in the project folder:

```
npm run refresh-tokens
```

It checks every configured login and refreshes the ones that need it (add
`-- --profile <name>` to do just one; `npm run check-tokens` reports without
changing anything). If a login says `REFRESH FAILED`, that login's access was
revoked — for example the developer app was deleted, or it went unused for about
a month. Reconnect it by running the setup again.

## Honest limitations

- **Setup needs you at the keyboard, even when Claude drives it.** On the path
  where Claude can run commands, expect a floor of roughly **35–40 user actions**
  that only you can take: permission dialogs to read and approve, boxes to fill
  in on the FreshBooks developer-app form, a browser sign-in and Allow for each
  login, a few copy-pastes, and one full quit-and-reopen of Claude. (The
  developer app's scope list is several minutes of repeated clicking on top of
  that — it is one step, not forty.) Claude cannot take those actions for you.
  What it can do, and what this guide asks it to do, is tell you what each
  dialog will say before it appears, and never ask you for the same thing twice.
- **Creating credit notes and journal entries doesn't work yet.** This is a bug
  in the FreshBooks SDK this project depends on, not in this project. *Reading*
  credit notes and journal-entry data works fine. See [CHANGELOG.md](CHANGELOG.md).
- **Bills, bill payments, and bill vendors** can only be *created* if your
  FreshBooks account has the **Accounts Payable** add-on enabled. *Listing* them
  always works.
- **Some reports depend on your FreshBooks plan.** A report tool returning a
  **403** means that feature isn't included in that login's plan or role (for
  example, accounts-*payable* aging needs the AP add-on). That is a FreshBooks
  entitlement, not a bug — retrying won't change it.

Everything else — invoices, clients, expenses, payments, time tracking, items,
projects, reports and more — works on a regular FreshBooks account.

## Troubleshooting

Each step above has its own **If something goes wrong** table; read that one
first, because it is written for exactly where you are. This table is for
problems that turn up later, or that belong to no single step.

| Problem | What to do |
|---|---|
| The setup says the authorization code was rejected | Codes are short-lived — paste a fresh address and retry first. If it keeps failing, your app's Redirect URI must be **exactly** `https://localhost/callback`; fix it in the FreshBooks Developer Portal and try again. |
| `FRESHBOOKS_CLIENT_ID is not set` | The server has no app credentials yet — run the setup again. |
| "401 Unauthorized" from FreshBooks | The access token expired. Run `npm run refresh-tokens`. If that says `REFRESH FAILED`, reconnect that login by running the setup again. |
| `invalid_grant` while refreshing | That login was revoked or expired. Run the setup again for a fresh connection. |
| Claude Desktop shows only *some* of the tools after an update (often just the newest ones) | A known Claude Desktop bug: it caches a server's tool list by name and doesn't refresh it when the list changes — restarting the app or toggling tools in settings won't help. Fully quit Claude Desktop → remove the `"freshbooks"` entry from `claude_desktop_config.json` → open Claude Desktop once → quit it again → put the entry back exactly as it was → reopen. Claude Code and claude.ai web are unaffected. |
| Claude picked the wrong account, or asks which account | With two or more logins configured, name the account in your request (e.g. "for acme"). Ask *"what FreshBooks accounts are configured?"* to see the valid names. |
| Claude asks permission for every FreshBooks action | Deliberate: the recommended allowlist names each tool instead of wildcarding all of them, so every money-touching write keeps a human gate. Allow the read-only tools you use often; keep approving writes one at a time. |
| A report answer starts with `WARNING_INCOMPLETE` | The listing stopped early at a safety limit, so totals computed from it would be wrong. Ask again with a narrower date range or filter. |

Still stuck? Open an issue at
[github.com/kanjidoc/FreshBooks-MCP/issues](https://github.com/kanjidoc/FreshBooks-MCP/issues).

## Other ways to use the server

- **claude.ai in a browser:** the web environment cannot launch a program on your
  computer, and your tokens live in local `profiles/<name>.env` files that must
  never be committed to a repository — so this server is run locally, from the
  Claude desktop app or Claude Code.
- **Claude Agent SDK (for developers):** import `freshbooksServer` from
  `src/server.ts` and pass it to `query()` as an MCP server. [README.md](README.md)
  has a code example, and explains how the server works.

## Appendix — manual setup (humans only)

Almost nobody needs this section. The manual configuration blocks for Claude
Desktop and Claude Code live in the *Connect the server to your Claude* step
above, where they belong — this appendix is only for wiring up the credentials
themselves by hand.

### Manual token exchange (raw tokens, by hand)

Installing agents must never use this section — it handles raw tokens. Ask the
person to run the setup program instead; it does all of this without a token
ever passing through a chat.

If you cannot run the setup at all, you can do its job yourself. Credentials
split across two kinds of file: the base `.env` holds only your shared **app**
credentials, and each FreshBooks login's tokens go in its own
`profiles/<name>.env`.

1. `cp .env.example .env` and fill in the three app values
   (`FRESHBOOKS_CLIENT_ID`, `FRESHBOOKS_CLIENT_SECRET`, `FRESHBOOKS_REDIRECT_URI`).
   Do **not** put tokens here. The Client ID and Client Secret come from the
   developer app you created above.
2. **Access token / refresh token** — complete the OAuth flow yourself:
   - Visit (with your real Client ID):
     `https://auth.freshbooks.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://localhost/callback`
   - Click **Allow**, then copy the `code` value out of the address bar.
   - Exchange it for tokens:
     ```bash
     curl -X POST https://api.freshbooks.com/auth/oauth/token \
       -H "Content-Type: application/json" \
       -d '{
         "grant_type": "authorization_code",
         "client_id": "YOUR_CLIENT_ID",
         "client_secret": "YOUR_CLIENT_SECRET",
         "code": "THE_CODE",
         "redirect_uri": "https://localhost/callback"
       }'
     ```
3. **Account ID / business ID** — call the identity endpoint:
   ```bash
   curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     https://api.freshbooks.com/auth/api/v1/users/me
   ```
   Use `business_memberships[0].business.account_id` and
   `business_memberships[0].business.id`.
4. Create `profiles/<name>.env` (a short lowercase `<name>`, e.g.
   `profiles/main.env`) holding the four per-login values:

   ```
   FRESHBOOKS_ACCESS_TOKEN=...
   FRESHBOOKS_REFRESH_TOKEN=...
   FRESHBOOKS_ACCOUNT_ID=...
   FRESHBOOKS_BUSINESS_ID=...
   ```

   Repeat for each additional login — one file per login. Every `profiles/*.env`
   is already excluded from Git.
5. Run `npm run build`, then connect the server to Claude with the blocks in the
   *Connect the server to your Claude* step above.

---

— end of setup guide —
