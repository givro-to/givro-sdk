# Givro — Chrome Extension (Dev)

A minimal Chrome extension for testing Givro sends locally.

## Setup

```bash
npm install
npm run build      # produces popup.js
# or
npm run dev        # watch mode
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this directory
4. Click the extension icon to open the popup

## Usage

1. Open **Settings** (⚙)
2. Set **RPC URL** → `http://localhost:9545` (Anvil / local node)
3. Set **Portal API URL** → `http://localhost:3100` (Givro dev server)
4. Set **Contract address** → the deployed settlement escrow (`HfiPayIntentBlinded`) address
5. Paste a **dev private key** (never use a key with real funds)
6. Your address and GO balance appear automatically
7. Enter recipient (email or @x_handle) + amount → **Send**

The extension calls the portal server to get a quote, then sends the deposit transaction directly to the pinned escrow via your local node.

> **Security**: this extension stores the private key in `localStorage`. It is intended for local development only.
