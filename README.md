# CIFER MCP Server

> MCP server + CLI that gives AI agents quantum-resistant encryption powers via [CIFER](https://sdk.cifer-security.com/) on Ternoa zkEVM.

Any MCP-compatible agent framework (Nous Research Hermes, OpenClaw, Claude Code, Claude Desktop, Cursor, Zed…) can plug this in and instantly gain 8 tools: encrypt / decrypt messages and files using ML-KEM-768 (NIST post-quantum) + AES-256-GCM, plus env / secret / quota introspection — and an `init` tool that onboards the agent itself.

## Quick Start — copy, paste, run

From zero to encrypted secrets in roughly 5 commands. Replace `<host>` with one of: **`hermes`**, **`claude-desktop`**, **`claude-code`**, **`openclaw`**, **`cursor`**.

### 1. Clone, install, build

```bash
git clone https://github.com/natural-eaglets/cifer-mcp-server.git
cd cifer-mcp-server
npm install
npm run build
```

### 2. Generate the agent wallet

```bash
node dist/cifer-tool.js init
```

This prints your agent's new EVM address, e.g.:
```
🔑 Generated a new agent wallet.
   Address:  0xAbC1234…def
```

### 3. Delegate a CIFER secret to that address (only step that needs you on-chain)

1. Open **https://cifer.ternoa.dev**
2. Connect your own wallet, click **Create secret**
3. Click **Delegate…** on that secret and paste the agent's address from step 2
4. Copy the secret ID from the dashboard

### 4. Save + verify the secret ID

```bash
node dist/cifer-tool.js init --secret-id <N>     # replace <N> with the ID
```

Expected: `"authorized": true` in the output.

### 5. Register the MCP server with your host

```bash
node dist/cifer-tool.js config <host> --apply
```

This merges a correctly-shaped entry into the host's config file with a timestamped backup. It also **auto-repairs** a malformed existing entry (e.g. Hermes' `mcp_servers:` accidentally being a YAML list instead of a mapping).

### 6. Restart the host

| Host | Command |
|---|---|
| **Hermes** | `kill $(cat ~/.hermes/gateway.pid) 2>/dev/null; hermes gateway run &>/dev/null & ; sleep 2 ; hermes` |
| **Claude Desktop** | Quit and reopen the app (Cmd-Q / File → Quit) |
| **Claude Code** | `/restart` inside the CLI, or kill and relaunch |
| **OpenClaw** | `openclaw restart` (or kill + relaunch) |
| **Cursor** | Quit and reopen the app |

### 7. Verify

In the host's chat, ask the agent: *"Run `cifer_check_env` and `cifer_check_secret`."* You should see `ready: true`, `authorized: true`, and `envFileLoaded` pointing at `<repo>/.env`. From here the agent can call `cifer_encrypt` / `cifer_decrypt` on any sensitive data.

### Giving it to an agent to do on its own

Hand your agent this prompt — it can run every step except the on-chain delegation:

> Clone `https://github.com/natural-eaglets/cifer-mcp-server.git` into my home directory, install and build it, then run `node dist/cifer-tool.js init`. Tell me the agent wallet address it generated and wait for me to reply with a secret ID. Once I do, run `node dist/cifer-tool.js init --secret-id <ID>` to verify, then `node dist/cifer-tool.js config <host> --apply` to register yourself with my MCP host (use `hermes` / `claude-desktop` / `claude-code` / `openclaw` / `cursor` as appropriate). Finally, tell me exactly how to restart the host and, after I do, verify with `cifer_check_env` and `cifer_check_secret`. Do not edit any config files by hand — always use the `config` command.

## Features

- **8 MCP tools** — init, check env, check secret, read quota, encrypt text, decrypt text, encrypt file, decrypt file
- **Self-onboarding** — `cifer_init` generates the agent wallet and tells the user exactly what to do on the dashboard
- **stdio transport** — no ports, no daemons, the host spawns it on demand
- **CLI fallback** — same commands as a plain shell tool for agents that don't speak MCP
- **Private-key signer** — server-side wallet from `.env` (never browser-bound)
- **Ternoa mainnet** by default, chain / RPC / Blackbox URL all overridable

## Why `config <host> --apply` and not hand-written YAML

Every MCP host expects a slightly different shape in its config file:

- **Hermes** wants a YAML mapping under `mcp_servers:` (not a list!)
- **Claude / OpenClaw / Cursor** want a JSON object under `mcpServers`
- Each has its own default path

Small mistakes — for example Hermes' `mcp_servers:` accidentally being a YAML sequence — crash the host at startup. The `config` command always emits the right shape, writes to the right path, backs up the existing file, and auto-repairs malformed entries. Agents should prefer it over ever touching those files directly. The same flow is also exposed as the `cifer_init` MCP tool, so agents running over MCP don't need shell access either — they just call the tool.

## Installation

```bash
git clone https://github.com/natural-eaglets/cifer-mcp-server.git
cd cifer-mcp-server
npm install
npm run build
node dist/cifer-tool.js init      # generates wallet, writes .env
# …you delegate a secret via the dashboard…
node dist/cifer-tool.js init --secret-id <N>   # save + verify
```

## Configuration

**Do not write the MCP-server config by hand.** Each host expects a slightly different shape (Hermes wants a YAML mapping under `mcp_servers`, Claude/OpenClaw/Cursor want a JSON object under `mcpServers`, etc.), and subtle mistakes — like writing `mcp_servers` as a list — will crash the host at startup.

Instead, use the built-in `config` command. It emits the exact block for the host you want, with the absolute path to *this* install's MCP server pre-filled, and can safely merge itself into the host's config file.

### One-liner: auto-install

```bash
# Pick your host and let the tool handle the rest:
node dist/cifer-tool.js config hermes           --apply
node dist/cifer-tool.js config claude-desktop   --apply
node dist/cifer-tool.js config claude-code      --apply
node dist/cifer-tool.js config openclaw         --apply
node dist/cifer-tool.js config cursor           --apply
```

This will:

1. Back up your existing config (`<file>.cifer-backup.<timestamp>`)
2. Parse it with a real YAML/JSON parser (no regex hackery)
3. Merge a `cifer` entry alongside any other MCP servers you already have
4. **Refuse to proceed** if the existing config has a malformed shape (e.g. `mcp_servers` as a list) and tell you what's wrong — re-run with `--force` to auto-repair.

Then restart the host to pick up the new server.

### Dry-run: print the snippet instead

Drop `--apply` to print the correct block to stdout — useful if you'd rather paste manually, or if the host config lives in a non-default location.

```bash
node dist/cifer-tool.js config hermes
# → prints YAML block
node dist/cifer-tool.js config claude-desktop
# → prints JSON block
```

### Custom config location

```bash
node dist/cifer-tool.js config hermes --apply --path /custom/path/to/config.yaml
```

### What the resulting entry looks like

The tool always emits a minimal entry — `command`, `args`, nothing else. Secrets are read from the repo's `.env` file (via `dotenv`), never hard-coded in the host config:

```yaml
# Hermes
mcp_servers:
  cifer:
    command: node
    args:
      - /absolute/path/to/cifer-mcp-server/dist/cifer-mcp-server.js
```

```json
// Claude / OpenClaw / Cursor
{
  "mcpServers": {
    "cifer": {
      "command": "node",
      "args": ["/absolute/path/to/cifer-mcp-server/dist/cifer-mcp-server.js"]
    }
  }
}
```

> ⚠️ **Never** put `CIFER_PK` directly in the host config. Keep it in `.env` next to the repo — it's not committed, it's not visible to other agents or tools, and it's easier to rotate. The MCP server auto-loads `.env` from its own directory regardless of the host's working directory, so you do not need to pass env vars through the host config.

### How `.env` is resolved (v1.1+)

The server finds `.env` via this order (first hit wins):

1. `$CIFER_ENV_FILE` — explicit override via env var
2. `<server-script-dir>/.env` — running via `tsx` from source
3. `<server-script-dir>/../.env` — running `dist/cifer-mcp-server.js`, `.env` in repo root
4. `<cwd>/.env` — legacy fallback

This means Hermes, Claude Desktop, OpenClaw etc. can spawn the server from anywhere — it will always find the `.env` you wrote with `init`. You can verify which file was loaded by calling `cifer_check_env` (MCP) or `check-env` (CLI) — the response includes `envFileLoaded` and `envFileExpected`.

### Development mode (tsx, no build step)

If you're iterating on server source, swap the `command` / `args`:

```
command: npx
args: [tsx, /absolute/path/to/cifer-mcp-server.ts]
```

### Default config paths

The `config` command knows each host's default config location:

| Host | Default path |
|---|---|
| `hermes` | `~/.hermes/config.yaml` |
| `claude-desktop` | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`, Linux: `~/.config/Claude/claude_desktop_config.json` |
| `claude-code` | `~/.claude/settings.json` |
| `openclaw` | `~/.openclaw/config.json` |
| `cursor` | `~/.cursor/mcp.json` |

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CIFER_PK` | **Yes** | EVM private key of the agent wallet. Must be owner or delegate of the secret. |
| `CIFER_SECRET_ID` | **Yes** | The numeric secret ID this agent operates on (e.g. `31`). |
| `CIFER_BLACKBOX_URL` | No | Blackbox endpoint. Default: `https://cifer-blackbox.ternoa.dev:3010` |
| `CIFER_RPC_URL` | No | Ternoa RPC. Default: `https://rpc-mainnet.zkevm.ternoa.network/` |
| `CIFER_CHAIN_ID` | No | Chain ID. Default: `752025` (Ternoa mainnet) |

To get `CIFER_SECRET_ID`:
1. Open the CIFER Agent Console dashboard
2. Create a secret (or use an existing one you own)
3. Delegate it to this agent's wallet address
4. Copy the secret ID

## Available Tools

### `cifer_init`
Onboard the agent. Generates a wallet if one doesn't exist, writes `.env`, and (if given a secret ID) verifies on-chain that the wallet is authorized. The tool's response includes a `nextStep` field with exactly what the agent should tell the user.

| Param | Type | Description |
|---|---|---|
| `secretId` | string (optional) | Save and verify this secret ID. Omit on first call; provide after the user delegates. |
| `force` | boolean (optional) | Regenerate the wallet even if `CIFER_PK` already exists. **Destructive** — you'll lose access to any secret delegated to the old wallet. |

### `cifer_check_env`
Check if `CIFER_PK` / `CIFER_SECRET_ID` are set and the wallet is valid. **Call this first.**

### `cifer_check_secret`
On-chain state of the secret. Reports owner, delegate, syncing status, and whether this wallet is authorized.

| Param | Type | Description |
|---|---|---|
| `secretId` | string (optional) | Secret ID override. Defaults to `CIFER_SECRET_ID`. |

### `cifer_get_quota`
Remaining encryption / decryption data quota (GB) for this wallet on the Blackbox.

### `cifer_encrypt`
Encrypt a plaintext message (max 16KB).

| Param | Type | Description |
|---|---|---|
| `plaintext` | string | The message to encrypt. |

Returns `{ cifer, encryptedMessage }` — **store BOTH** for decryption.

### `cifer_decrypt`
Decrypt a payload.

| Param | Type | Description |
|---|---|---|
| `cifer` | string | Cifer hex string from encrypt result. |
| `encryptedMessage` | string | EncryptedMessage hex string from encrypt result. |

### `cifer_encrypt_file`
Async file encryption. Saves `<filename>.cifer` alongside the original.

| Param | Type | Description |
|---|---|---|
| `filePath` | string | Absolute or relative path to the file. |

### `cifer_decrypt_file`
Async file decryption. Strips the `.cifer` extension on the output.

| Param | Type | Description |
|---|---|---|
| `filePath` | string | Path to the `.cifer` file. |

## CLI (non-MCP fallback)

For agent frameworks without MCP support, use the CLI directly. All commands output JSON on stdout.

```bash
npx tsx cifer-tool.ts init                          # generate wallet + write .env
npx tsx cifer-tool.ts init --secret-id 42           # save & verify secret ID
npx tsx cifer-tool.ts config hermes --apply         # wire into host config safely
npx tsx cifer-tool.ts check-env
npx tsx cifer-tool.ts check-secret
npx tsx cifer-tool.ts get-quota
npx tsx cifer-tool.ts encrypt --text "API_KEY=sk-abc"
npx tsx cifer-tool.ts decrypt --cifer 0x... --message 0x...
npx tsx cifer-tool.ts encrypt-file --file ./secrets.json
npx tsx cifer-tool.ts decrypt-file --file ./secrets.json.cifer
```

After `npm run build`, swap `npx tsx cifer-tool.ts` for `node dist/cifer-tool.js` for faster startup.

## Typical Agent Workflow

```
1. cifer_check_env         → Confirm env is ready
2. cifer_check_secret      → Confirm secret is ready + wallet authorized
3. cifer_encrypt("X")      → Get { cifer, encryptedMessage }
4. Store both values        → Save to file, DB, or config
   ...later...
5. cifer_decrypt(...)       → Recover plaintext
```

## When Agents Should Use CIFER

Encrypt **before** storing / transmitting:
- API keys, tokens, credentials
- Sensitive data to files, databases, logs
- Private information over the network
- User secrets that shouldn't be in plaintext

Decrypt **when** needed:
- Reading previously encrypted credentials
- Using an API key that was stored encrypted
- Processing a `.cifer` file

## Error Handling

| Error | Action |
|---|---|
| `Missing CIFER_PK` | Set the private key in `.env` or MCP server env block |
| `Secret is syncing` | Wait 30–60 s after creation, retry |
| `Not authorized` | Wallet is not owner/delegate — ask the secret owner to delegate |
| `Block number is too old` | RPC stale data — SDK auto-retries 3× |

## Security Notes

- `CIFER_PK` stays in the agent's environment; CIFER only uses it to sign authentication challenges (EIP-191).
- Secret private-key shards live in an enclave cluster using threshold cryptography — neither the agent nor the Blackbox can reconstruct them alone.
- Payload limit: 16 KB for `cifer_encrypt`; use `cifer_encrypt_file` for larger data.
- All encryption: ML-KEM-768 (post-quantum KEM) + AES-256-GCM (symmetric).

## Development

```bash
npm install        # Install deps
npm run build      # Compile to dist/
npm run mcp        # Run MCP server from source (tsx)
npm run mcp:dist   # Run MCP server from dist/
npm run cifer      # CLI from source
```

## License

MIT — see [LICENSE](LICENSE).

## Links

- [CIFER SDK reference](https://sdk.cifer-security.com/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Ternoa zkEVM explorer](https://explorer-mainnet.zkevm.ternoa.network/)
