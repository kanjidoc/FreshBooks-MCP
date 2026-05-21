# FreshBooks MCP — Setup Guide

This guide gets the FreshBooks MCP server running and connected to Claude, so you
can manage your FreshBooks accounting by just talking to Claude in plain English.

**It takes about 15 minutes. You do not need to know how to code.**

---

## 📖 How to use this guide

This guide has two kinds of reader. Find yourself:

**🧑 If you are a person:** follow the steps in order, top to bottom. Every step
tells you *what to do*, *how to know it worked* (✅), and *what to do if it
didn't* (⚠️). Don't skip ahead.

**🤖 If you are Claude** (someone pasted this project and asked you to install it):
treat this guide as a script. Follow it top to bottom. For each step:

- If you can do it yourself (running terminal commands, creating/editing files),
  do it — then tell the user what you did and what the success check showed.
- Some steps are marked **🧑 Your turn**. Those are interactive or happen in a web
  browser — you *cannot* do them. For those, give the user the exact command or
  the exact clicks, tell them what success looks like, and **wait** for them to
  confirm before you continue.
- If a step fails, stop and use the Troubleshooting table at the bottom before
  moving on.

---

## What you need before you start

- **Claude** — either:
  - **Claude Desktop** — the app you download from [claude.ai/download](https://claude.ai/download), or
  - **Claude Code** — Claude running in a terminal window or inside VS Code / a JetBrains IDE.

  Step 1 helps you tell which one you have.
- **A FreshBooks account** — any regular plan. You will create a free "developer
  app" inside it; that is normal and takes two minutes.
- **A computer** running macOS or Windows.

That's everything. No coding experience required.

---

## Step 1 — Which Claude do you have?

This guide works for both, but a few steps differ. Find yourself in this table:

| If you have… | You are using… |
|---|---|
| The **Claude app** you downloaded from claude.ai | **Claude Desktop** |
| Claude in a **terminal window**, or inside **VS Code / a JetBrains IDE** | **Claude Code** |

Remember your answer. Later steps are labelled **(Desktop)** or **(Code)** where
they differ.

> **The difference in one sentence:** with **Claude Code**, Claude can run most of
> the setup commands *for you*. With **Claude Desktop**, you run them yourself —
> this guide gives you every command to copy and paste.

---

## Step 2 — Make sure Node.js is installed

Node.js is the engine this server runs on. You need version **18 or newer**.

- **(Code)** You already have Node.js — Claude Code itself runs on it. **Skip to Step 3.**
- **(Desktop)** Open a Terminal (see the box below) and type this, then press Enter:

  ```
  node --version
  ```

  - ✅ You see a version like `v20.11.0` (any number **18 or higher**) — you're set.
  - ⚠️ You see "command not found" — install Node.js: go to
    [nodejs.org](https://nodejs.org), click the big **"LTS"** download button, run
    the installer with all the default options, then **close and reopen Terminal**
    and try `node --version` again.

> **How to open a Terminal**
> - **Mac:** press `Cmd + Space`, type `Terminal`, press Enter.
> - **Windows:** click the Start button, type `PowerShell`, press Enter.

---

## Step 3 — Get this project onto your computer

You need the project's files on your machine. Pick **one** option:

**Option A — Download a ZIP (easiest, needs no extra tools)**

1. Open [github.com/kanjidoc/FreshBooks-MCP](https://github.com/kanjidoc/FreshBooks-MCP).
2. Click the green **"Code"** button, then **"Download ZIP"**.
3. Unzip the downloaded file. You'll get a folder named `FreshBooks-MCP-main`
   (GitHub adds the `-main`). Move it somewhere you'll remember — your home folder
   is fine. You can rename it to just `FreshBooks-MCP` if you prefer.
4. Note the folder's full location — you'll need it in the next step.

**Option B — Clone with Git (if you already have Git installed)**

```
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
```

> **🤖 Claude (Code):** if you can run a terminal, do Option B yourself, then `cd`
> into the new `FreshBooks-MCP` folder. If `git` is not available, tell the user to
> use Option A and tell you where they unzipped the folder.

---

## Step 4 — Install the project's building blocks

Open a Terminal, go into the project folder, and install its dependencies:

```
cd path/to/FreshBooks-MCP
npm install
```

Replace `path/to/FreshBooks-MCP` with the real location from Step 3. (Tip: on Mac
you can type `cd `, then drag the folder onto the Terminal window — it fills in the
path for you.)

- ✅ It finishes with a line like `added 200 packages`. A few yellow warnings are normal.
- ⚠️ `npm: command not found` — Node.js isn't installed. Go back to Step 2.

---

## Step 5 — Create your FreshBooks "developer app"

This is how FreshBooks lets the server connect to your account securely. You only
do this once.

**🧑 Your turn** — this happens in your web browser, so Claude cannot do it for you:

1. Log in at [freshbooks.com](https://www.freshbooks.com).
2. Open the Developer Portal: [my.freshbooks.com/#/developer](https://my.freshbooks.com/#/developer).
3. Click **"Create an App"**.
4. Set **Application Type** to **"Private App"**.
5. Set the **Redirect URI** to exactly this (copy it precisely):

   ```
   https://localhost/callback
   ```

6. Save. **Keep this browser tab open** — the next step needs the **Client ID** and
   **Client Secret** shown on this page.

---

## Step 6 — Run the setup wizard

This is the main event. One command collects your FreshBooks credentials, logs you
in, finds your account IDs, saves everything, and builds the server.

**🧑 Your turn** — the wizard asks you questions and opens your browser, so **you**
run it. Open a **normal Terminal window** (not inside Claude), go to the project
folder, and run:

```
cd path/to/FreshBooks-MCP
npm run setup
```

> **🤖 Claude:** this step is interactive and opens a browser — you cannot run it.
> Tell the user to run `npm run setup` themselves in a regular Terminal window,
> explain what the wizard will ask (below), and wait for them to tell you it
> finished before you continue.

The wizard walks you through, in order:

1. **Paste your Client ID and Client Secret** — from the FreshBooks tab in Step 5.
2. **Authorize in your browser** — the wizard opens a FreshBooks page; click
   **"Allow"**. Your browser then jumps to a page that **fails to load** — *that is
   expected and correct*. Copy the **full web address** from your browser's address
   bar and paste it back into the wizard.
3. **Account detection** — the wizard finds your Account ID and Business ID for you.
4. **Saving and building** — it writes your settings and compiles the server.
5. **Claude Desktop install** — it asks if it should add the server to Claude
   Desktop automatically. **(Desktop)** answer **yes**. **(Code)** answer is up to
   you — see Step 7.

- ✅ The wizard ends with a line that says **`DONE!`**.
- ⚠️ Something went wrong — see the Troubleshooting table at the bottom of this guide.

> **Keep your credentials private.** The wizard saves your FreshBooks login in a
> file named `.env` inside the project folder. Don't share that file or upload it
> anywhere — it holds the keys to your accounting account. (It's already excluded
> from Git, so it won't be committed by accident.)

---

## Step 7 — Connect the server to Claude

**(Desktop)** If you answered **yes** to the auto-install in Step 6, this is already
done — **skip to Step 8.** If you answered no, see *Manual Claude Desktop setup* in
the Appendix.

**(Code)** The wizard created a file called `.mcp.json` inside the project folder.
Claude Code reads that file automatically when the project folder is open. So:

1. Open the project folder (the one you installed into — it contains a file named
   `.mcp.json`) as your project/workspace in Claude Code.
2. Claude Code will ask whether to enable the **"freshbooks"** MCP server — say yes.

To use FreshBooks from *any* Claude Code project (not just this folder), see *Manual
Claude Code setup* in the Appendix.

---

## Step 8 — Restart Claude and test it

1. **Quit Claude completely and reopen it.** This is required — Claude only notices
   a new server on a fresh start.
   - **(Desktop)** Quit the app entirely (don't just close the window) and relaunch it.
   - **(Code)** Start a new Claude Code session.
2. Ask Claude:

   > *"List my recent FreshBooks invoices"*

- ✅ Claude lists your invoices. **🎉 You're done — setup is complete.**
- ⚠️ Claude says it has no FreshBooks tools, or you get an error — see Troubleshooting.

---

## You're set up — now what?

Just talk to Claude in plain English. For example:

- *"How much did I invoice last month?"*
- *"Show me all my unpaid invoices."*
- *"Create an invoice for Acme Corp for 10 hours of consulting at $150/hour."*
- *"What were my biggest expenses this quarter?"*

There are **75 tools** in total. To see what's possible, ask Claude:
*"What FreshBooks tools do you have?"* or *"Show me the FreshBooks help."*

---

## Keeping it running

Your FreshBooks login token expires every so often, but the server **refreshes it
automatically** — at startup and before every action. You should never have to
think about it.

If FreshBooks ever stops working, run this in the project folder:

```
npm run refresh-tokens
```

If that reports `REFRESH FAILED`, your access was revoked (for example, the
developer app was deleted, or it went unused for about a month). Just re-run
`npm run setup` to reconnect.

> **(Code)** This project also ships a small "token refresh" helper for Claude Code.
> When the FreshBooks-MCP folder is open, you can simply ask Claude
> *"check my FreshBooks tokens"* and it will handle the rest.

---

## A couple of honest limitations

- **Creating credit notes and journal entries doesn't work yet.** This is caused by
  a bug in the FreshBooks SDK this project depends on, not by this project. *Reading*
  credit notes and journal-entry data works fine. See [CHANGELOG.md](CHANGELOG.md).
- **Bills, bill payments, and bill vendors** can only be *created* if your FreshBooks
  account has the **Accounts Payable** add-on enabled. *Listing* them always works.

Everything else — invoices, clients, expenses, payments, time tracking, items,
projects, reports, and more — works on a regular FreshBooks account.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| `node: command not found` or `npm: command not found` | Node.js isn't installed. See Step 2. |
| The setup wizard didn't open my browser | Copy the authorization URL the wizard printed in the Terminal and paste it into your browser yourself. |
| Browser shows "this page can't be reached" after I click Allow | That is expected. Copy the **full address** from the address bar and paste it into the wizard. |
| "OAuth callback timeout" or the code is rejected | Your app's Redirect URI must be **exactly** `https://localhost/callback`. Fix it in the FreshBooks Developer Portal and run `npm run setup` again. |
| `FRESHBOOKS_CLIENT_ID is not set` | The server has no credentials. Re-run `npm run setup`. |
| "401 Unauthorized" from FreshBooks | Your token expired. Run `npm run refresh-tokens`. If that says `REFRESH FAILED`, re-run `npm run setup`. |
| `invalid_grant` while refreshing | The login was revoked or expired. Re-run `npm run setup` for a fresh connection. |
| `Cannot find module .../dist/index.js` | The server wasn't built. Run `npm run build` in the project folder. |
| Claude has no FreshBooks tools after setup | Make sure you **fully quit and reopened** Claude. **(Desktop)** check the config path points to the real `dist/index.js`; look for the tools/hammer icon. **(Code)** make sure the project folder is open and the "freshbooks" server was enabled. |
| I have more than one FreshBooks business | The wizard uses the first one. To use a different one, open the `.env` file and change `FRESHBOOKS_ACCOUNT_ID` and `FRESHBOOKS_BUSINESS_ID`. |

Still stuck? Open an issue at
[github.com/kanjidoc/FreshBooks-MCP/issues](https://github.com/kanjidoc/FreshBooks-MCP/issues).

---

## Appendix — Advanced / manual setup

Most people only need Steps 1–8 above. This section is for people who want to wire
things up by hand or use Claude in other ways.

### Manual Claude Desktop setup

If you skipped the wizard's auto-install, add the server to Claude Desktop yourself.

1. Open Claude Desktop's config file (create it if it doesn't exist):
   - **Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the block below. Use the values from the `.env` file the wizard created, and
   the **absolute path** to `dist/index.js`:

```json
{
  "mcpServers": {
    "freshbooks": {
      "command": "node",
      "args": ["/absolute/path/to/FreshBooks-MCP/dist/index.js"],
      "env": {
        "FRESHBOOKS_CLIENT_ID": "your_client_id",
        "FRESHBOOKS_CLIENT_SECRET": "your_client_secret",
        "FRESHBOOKS_REDIRECT_URI": "https://localhost/callback",
        "FRESHBOOKS_ACCESS_TOKEN": "your_access_token",
        "FRESHBOOKS_REFRESH_TOKEN": "your_refresh_token",
        "FRESHBOOKS_ACCOUNT_ID": "your_account_id",
        "FRESHBOOKS_BUSINESS_ID": "your_business_id"
      }
    }
  }
}
```

3. Fully quit and reopen Claude Desktop.

### Manual Claude Code setup

The wizard writes a project-scoped `.mcp.json` (used when the FreshBooks-MCP folder
is your open project). To make FreshBooks available in **every** Claude Code
project, paste the same `"mcpServers"` block as above into your global Claude Code
settings at `~/.claude/settings.json`, then restart your Claude Code session.

### Setting up without the wizard

If you can't run `npm run setup`, you can configure everything by hand:

1. `cp .env.example .env` and fill in all seven values.
2. **Client ID / Client Secret** come from the Developer Portal app (Step 5).
3. **Access Token / Refresh Token** — complete the OAuth flow:
   - Visit (with your real Client ID):
     `https://auth.freshbooks.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=https://localhost/callback`
   - Click **Allow**, then copy the `code` value from the redirected URL.
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
4. **Account ID / Business ID** — call the identity endpoint:
   ```bash
   curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     https://api.freshbooks.com/auth/api/v1/users/me
   ```
   Use `business_memberships[0].business.account_id` and
   `business_memberships[0].business.id`.
5. Run `npm run build`, then add the server to Claude using one of the blocks above.

### Other ways to use the server

- **claude.ai/code (web):** add the `"mcpServers"` block to `.claude/settings.json`
  in your repository and push it, so the web environment can read it.
- **Claude Agent SDK (for developers):** import `freshbooksServer` from
  `src/server.ts` and pass it to `query()` as an MCP server. See
  [README.md](README.md) for a code example.

---

Once you're up and running, [README.md](README.md) explains how the server works
and lists every tool. Welcome aboard. 🎉
