# FreshBooks MCP — Setup Guide (Simplified)

Follow these steps once on your Mac. After that, it just works — you won't have to touch tokens or re-authenticate.

---

## What you need before starting

- A FreshBooks login
- Claude Desktop installed ([download](https://claude.ai/download) if you don't have it)
- About 15 minutes

---

## Step 1 — Install Node.js (only if you don't have it)

Open **Terminal** (Applications → Utilities → Terminal).

Paste this and hit Enter:

```
node -v
```

- If you see a version number like `v20.x.x`, you're good. Skip to Step 2.
- If you see "command not found," go to https://nodejs.org, click the big green "LTS" download button, install it, then come back.

---

## Step 2 — Create your FreshBooks Developer App

This is a one-time thing that gives the MCP server permission to talk to your FreshBooks account.

1. Go to https://my.freshbooks.com/#/developer and log in if asked.
2. Click **"Create an App"** (top right).
3. Fill it in:
   - **Application Name:** `Claude MCP` (anything is fine)
   - **Application Type:** Select **Private App**
   - **Redirect URI:** paste exactly `https://localhost/callback`
4. Click **Save**.
5. Click on your new app. You'll see a **Client ID** and **Client Secret**. Keep this tab open — you'll paste these in a minute.

---

## Step 3 — Clone and set up the MCP server

Back in Terminal, paste these one at a time (hit Enter after each):

```
cd ~
git clone https://github.com/kanjidoc/FreshBooks-MCP.git
cd FreshBooks-MCP
npm install
npm run setup
```

The last command (`npm run setup`) is interactive. It will:

1. **Ask for your Client ID** — paste from the FreshBooks tab, hit Enter.
2. **Ask for your Client Secret** — paste from the FreshBooks tab, hit Enter.
3. **Open your browser** to a FreshBooks authorization page. Click **Allow**.
4. Your browser will try to load a page that won't load (says "can't connect"). **That's expected.** Copy the entire URL from the address bar (it starts with `https://localhost/callback?code=...`).
5. **Paste the URL** back into Terminal and hit Enter.
6. It will auto-detect your Account ID and Business ID, build everything, and ask:
   > `Add the FreshBooks MCP server to Claude Desktop automatically? [Y/n]:`
7. Press Enter to accept (Y is default). Done.

---

## Step 4 — Restart Claude Desktop

Completely quit Claude Desktop (Cmd+Q, not just close the window) and reopen it.

---

## Step 5 — Try it

Start a new conversation in Claude Desktop and ask:

> "List my recent FreshBooks invoices"

If you see your invoices, you're done. If not, see "Something went wrong" below.

---

## After setup: you don't have to do anything

- The MCP server refreshes its access token automatically every time Claude starts, so you won't get locked out.
- If you ever see an authentication error and restarting Claude Desktop doesn't fix it, open Terminal and run:
  ```
  cd ~/FreshBooks-MCP
  npm run setup
  ```
  and go through the OAuth prompts again. Takes about 2 minutes.

---

## Something went wrong

**"I don't see the FreshBooks tools in Claude Desktop"**
- Make sure you fully quit Claude Desktop (Cmd+Q) and reopened it.
- Check that Step 3 said "Build successful!" and "Claude Desktop config updated."

**"401 Unauthorized" or "invalid_grant"**
- Run `npm run setup` again from `~/FreshBooks-MCP`. This re-does the OAuth dance.

**"I accidentally deleted the app in the FreshBooks Developer Portal"**
- Create a new one (Step 2) and re-run `npm run setup` (Step 3). Your old tokens are dead but you can get new ones.

**Anything else**
- Ask Tony.
