# CIFER MCP Server

> MCP server + CLI that gives AI agents quantum-resistant encryption powers via [CIFER](https://sdk.cifer-security.com/) on Ternoa zkEVM.

Any MCP-compatible agent framework (Nous Research Hermes, OpenClaw, Claude Code, Claude Desktop, Cursor, Zed…) can plug this in and instantly gain 8 tools: encrypt / decrypt messages and files using ML-KEM-768 (NIST post-quantum) + AES-256-GCM, plus env / secret / quota introspection — and an `init` tool that onboards the agent itself.

## Features

- **8 MCP tools** — init, check env, check secret, read quota, encrypt text, decrypt text, encrypt file, decrypt file
- **Self-onboarding** — `cifer_init` generates the agent wallet and tells the user exactly what to do on the dashboard
- **stdio transport** — no ports, no daemons, the host spawns it on demand
- **CLI fallback** — same commands as a plain shell tool for agents that don't speak MCP
- **Private-key signer** — server-side wallet from `.env` (never browser-bound)
- **Ternoa mainnet** by default, chain / RPC / Blackbox URL all overridable

## Agent Onboarding (the short version)

An agent you give this repo to can bring itself online in two stages:

```bash
git clone https://github.com/natural-eaglets/cifer-mcp-server.git
cd cifer-mcp-server && npm install && npm run build
node dist/cifer-tool.js init
```

`init` generates a fresh wallet, writes it to `.env`, and prints something like:

```
🔑 Generated a new agent wallet.
   Address: 0xAbC…def

👉 NEXT STEP — delegate a secret to this wallet:
   1. Open https://cifer.ternoa.dev
   2. Connect your own wallet, create a CIFER secret
   3. Click 'Delegate' and paste:  0xAbC…def
   4. Share the secret ID back with the agent

   Then run:  node dist/cifer-tool.js init --secret-id <N>
```

The agent relays the wallet address to you, you do the dashboard steps, paste the secret ID back, the agent finalizes its own setup. The same flow is exposed as the `cifer_init` MCP tool so agents using MCP don't need shell access — they just call the tool.

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

### Nous Research Hermes

Add to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  cifer:
    command: node
    args: ["/absolute/path/to/skills/cifer/dist/cifer-mcp-server.js"]
    env:
      CIFER_PK: "0x_your_agent_private_key"
      CIFER_SECRET_ID: "31"
```

Hermes auto-discovers the tools at startup. Use `tools.include` / `tools.exclude` to whitelist / blacklist specific tools per server.

### OpenClaw

Add to `openclaw.json`:

```json
{
  "mcpServers": {
    "cifer": {
      "command": "node",
      "args": ["/absolute/path/to/skills/cifer/dist/cifer-mcp-server.js"],
      "env": {
        "CIFER_PK": "0x_your_agent_private_key",
        "CIFER_SECRET_ID": "31"
      }
    }
  }
}
```

### Claude Code / Claude Desktop

Add to `~/.claude/settings.json` (or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cifer": {
      "command": "node",
      "args": ["/absolute/path/to/skills/cifer/dist/cifer-mcp-server.js"],
      "env": {
        "CIFER_PK": "0x_your_agent_private_key",
        "CIFER_SECRET_ID": "31"
      }
    }
  }
}
```

### Cursor / Zed / Any other MCP host

Same pattern — point them at `node /absolute/path/to/dist/cifer-mcp-server.js` with the two env vars.

### Development mode (tsx, no build step)

If you're iterating on the server source:

```json
"command": "npx",
"args": ["tsx", "/absolute/path/to/skills/cifer/cifer-mcp-server.ts"]
```

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
