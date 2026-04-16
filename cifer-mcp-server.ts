#!/usr/bin/env npx tsx
/**
 * CIFER MCP Server
 *
 * Exposes quantum-resistant CIFER encryption tools over the Model Context
 * Protocol (MCP). Compatible with Claude Code, OpenClaw, and any MCP host.
 *
 * Usage:
 *   npx tsx cifer-mcp-server.ts          # stdio transport (default)
 *
 * Configure via .env:
 *   CIFER_PK=0x...            (required — agent wallet private key)
 *   CIFER_SECRET_ID=31        (required — secret to operate on)
 *   CIFER_BLACKBOX_URL=...    (optional)
 *   CIFER_RPC_URL=...         (optional)
 *   CIFER_CHAIN_ID=752025     (optional)
 */

import { join, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalEnvPath, loadEnv } from "./env-loader.js";

// Load .env relative to THIS script, not process.cwd(). MCP hosts (Hermes,
// Claude Desktop, OpenClaw) spawn the server from their own directory, so
// the old `import "dotenv/config"` silently missed the repo's .env.
const LOADED_ENV_PATH = loadEnv(import.meta.url);
import { Wallet } from "ethers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createCiferSdk,
  keyManagement,
  blackbox,
  isCiferError,
} from "cifer-sdk";
import type { SignerAdapter } from "cifer-sdk";

// ─── Config ──────────────────────────────────────────────────────────────────

const CHAIN_ID = Number(process.env.CIFER_CHAIN_ID ?? "752025");
const BLACKBOX_URL =
  process.env.CIFER_BLACKBOX_URL ?? "https://cifer-blackbox.ternoa.dev:3010";
const RPC_URL =
  process.env.CIFER_RPC_URL ?? "https://rpc-mainnet.zkevm.ternoa.network/";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSigner(pk: string): { signer: SignerAdapter; address: string } {
  const wallet = new Wallet(pk);
  const signer: SignerAdapter = {
    async getAddress() {
      return wallet.address as `0x${string}`;
    },
    async signMessage(message: string) {
      return (await wallet.signMessage(message)) as `0x${string}`;
    },
  };
  return { signer, address: wallet.address };
}

async function initSdk() {
  return createCiferSdk({
    blackboxUrl: BLACKBOX_URL,
    chainOverrides: {
      [CHAIN_ID]: { rpcUrl: RPC_URL },
    },
  });
}

/** JSON-safe bigint conversion. */
function toJson(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.startsWith("0x_your")) {
    throw new Error(
      `Missing or placeholder ${name} in .env. See .env.example for setup instructions.`
    );
  }
  return v;
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "cifer",
  version: "1.0.0",
});

// ── Tool: cifer_check_env ────────────────────────────────────────────────────

server.tool(
  "cifer_check_env",
  "Check if the CIFER environment is correctly configured. Returns whether CIFER_PK and CIFER_SECRET_ID are set, the resolved wallet address, and whether the agent is ready to encrypt/decrypt. Always call this first before any other CIFER tool.",
  {},
  async () => {
    const pk = process.env.CIFER_PK;
    const secretId = process.env.CIFER_SECRET_ID;
    const hasPk = !!pk && !pk.startsWith("0x_your");
    const hasSecretId = !!secretId && secretId.trim() !== "";

    let address: string | undefined;
    if (hasPk) {
      try {
        address = new Wallet(pk).address;
      } catch {
        // invalid key
      }
    }

    const result = {
      CIFER_PK: hasPk ? "set" : "MISSING",
      CIFER_SECRET_ID: hasSecretId ? secretId : "MISSING",
      CIFER_BLACKBOX_URL: BLACKBOX_URL,
      CIFER_CHAIN_ID: CHAIN_ID,
      walletAddress: address ?? null,
      ready: hasPk && hasSecretId,
      envFileLoaded: LOADED_ENV_PATH,
      envFileExpected: ENV_PATH,
    };

    if (!result.ready) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              toJson(result) +
              "\n\n⚠️ CIFER is not ready. The user needs to:\n" +
              `1. Make sure .env exists at ${ENV_PATH}\n` +
              "2. Set CIFER_PK (agent private key) and CIFER_SECRET_ID inside it.\n" +
              "   Use `node dist/cifer-tool.js init` to generate CIFER_PK automatically.\n" +
              "3. Do NOT put CIFER_PK in the MCP host config file — keep it in .env only.",
          },
        ],
      };
    }

    return { content: [{ type: "text" as const, text: toJson(result) }] };
  }
);

// ── Tool: cifer_check_secret ─────────────────────────────────────────────────

server.tool(
  "cifer_check_secret",
  "Check if a CIFER secret exists on-chain and is ready for use. Reports the secret state (owner, delegate, syncing status), and whether this agent's wallet is authorized to encrypt/decrypt with it.",
  {
    secretId: z
      .string()
      .optional()
      .describe(
        "Secret ID to check. Defaults to CIFER_SECRET_ID from .env."
      ),
  },
  async ({ secretId: idArg }) => {
    try {
      const pk = requireEnv("CIFER_PK");
      const idStr = idArg ?? requireEnv("CIFER_SECRET_ID");
      const secretId = BigInt(idStr);
      const sdk = await initSdk();
      const controllerAddress = sdk.getControllerAddress(CHAIN_ID);
      const params = {
        chainId: CHAIN_ID,
        controllerAddress,
        readClient: sdk.readClient,
      };

      const state = await keyManagement.getSecret(params, secretId);
      const { address } = buildSigner(pk);
      const authorized = await keyManagement.isAuthorized(
        params,
        secretId,
        address as `0x${string}`
      );

      return {
        content: [
          {
            type: "text" as const,
            text: toJson({
              secretId: secretId.toString(),
              owner: state.owner,
              delegate: state.delegate,
              isSyncing: state.isSyncing,
              ready: !state.isSyncing,
              publicKeyCid: state.publicKeyCid || null,
              walletAddress: address,
              walletAuthorized: authorized,
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: isCiferError(e)
              ? `Error: ${e.message} (code: ${e.code})`
              : `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: cifer_get_quota ────────────────────────────────────────────────────

server.tool(
  "cifer_get_quota",
  "Get the remaining encryption and decryption data quota (in GB) for this agent's wallet on the CIFER Blackbox.",
  {},
  async () => {
    try {
      const pk = requireEnv("CIFER_PK");
      const { signer } = buildSigner(pk);
      const sdk = await initSdk();

      const quota = await blackbox.jobs.dataConsumption({
        chainId: CHAIN_ID,
        signer,
        readClient: sdk.readClient,
        blackboxUrl: sdk.blackboxUrl,
      });

      return {
        content: [{ type: "text" as const, text: toJson({ quota }) }],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: isCiferError(e)
              ? `Error: ${e.message} (code: ${e.code})`
              : `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: cifer_encrypt ──────────────────────────────────────────────────────

server.tool(
  "cifer_encrypt",
  "Encrypt a plaintext message using quantum-resistant CIFER encryption (ML-KEM-768 + AES-256-GCM). Returns a `cifer` and `encryptedMessage` pair — BOTH must be stored together for later decryption. Max payload: 16KB.",
  {
    plaintext: z
      .string()
      .describe("The plaintext message to encrypt. Maximum 16KB."),
  },
  async ({ plaintext }) => {
    try {
      const pk = requireEnv("CIFER_PK");
      const secretId = BigInt(requireEnv("CIFER_SECRET_ID"));
      const { signer } = buildSigner(pk);
      const sdk = await initSdk();

      const result = await blackbox.payload.encryptPayload({
        chainId: CHAIN_ID,
        secretId,
        plaintext,
        signer,
        readClient: sdk.readClient,
        blackboxUrl: sdk.blackboxUrl,
        outputFormat: "hex",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: toJson({
              secretId: secretId.toString(),
              cifer: result.cifer,
              encryptedMessage: result.encryptedMessage,
              plaintextLength: plaintext.length,
              note: "Store BOTH cifer and encryptedMessage — you need both to decrypt.",
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: isCiferError(e)
              ? `Error: ${e.message} (code: ${e.code})`
              : `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: cifer_decrypt ──────────────────────────────────────────────────────

server.tool(
  "cifer_decrypt",
  "Decrypt a previously encrypted CIFER payload. Requires both the `cifer` and `encryptedMessage` hex strings returned by cifer_encrypt. The agent wallet must be the secret owner or a delegate.",
  {
    cifer: z
      .string()
      .describe(
        "The cifer hex string from the encrypt result (ML-KEM-768 ciphertext)."
      ),
    encryptedMessage: z
      .string()
      .describe(
        "The encryptedMessage hex string from the encrypt result (AES-GCM ciphertext)."
      ),
  },
  async ({ cifer, encryptedMessage }) => {
    try {
      const pk = requireEnv("CIFER_PK");
      const secretId = BigInt(requireEnv("CIFER_SECRET_ID"));
      const { signer } = buildSigner(pk);
      const sdk = await initSdk();

      const result = await blackbox.payload.decryptPayload({
        chainId: CHAIN_ID,
        secretId,
        encryptedMessage,
        cifer,
        signer,
        readClient: sdk.readClient,
        blackboxUrl: sdk.blackboxUrl,
        inputFormat: "hex",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: toJson({
              secretId: secretId.toString(),
              decryptedMessage: result.decryptedMessage,
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: isCiferError(e)
              ? `Error: ${e.message} (code: ${e.code})`
              : `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: cifer_encrypt_file ─────────────────────────────────────────────────

server.tool(
  "cifer_encrypt_file",
  "Encrypt a file using CIFER. Starts an async encryption job, polls until complete, and saves the encrypted result as <filename>.cifer. Use this for files larger than 16KB (for small text, use cifer_encrypt instead).",
  {
    filePath: z.string().describe("Absolute or relative path to the file to encrypt."),
  },
  async ({ filePath }) => {
    try {
      const pk = requireEnv("CIFER_PK");
      const secretId = BigInt(requireEnv("CIFER_SECRET_ID"));
      const { signer } = buildSigner(pk);
      const sdk = await initSdk();

      const absPath = resolve(filePath);
      const buffer = readFileSync(absPath);
      const blob = new Blob([new Uint8Array(buffer)]);

      const job = await blackbox.files.encryptFile({
        chainId: CHAIN_ID,
        secretId,
        file: blob,
        signer,
        readClient: sdk.readClient,
        blackboxUrl: sdk.blackboxUrl,
      });

      const final = await blackbox.jobs.pollUntilComplete(
        job.jobId,
        sdk.blackboxUrl,
        { intervalMs: 2000, maxAttempts: 120 }
      );

      if (final.status !== "completed") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Encrypt job failed: ${final.error ?? final.status}`,
            },
          ],
          isError: true,
        };
      }

      const encrypted = await blackbox.jobs.download(job.jobId, {
        blackboxUrl: sdk.blackboxUrl,
      });

      const outPath = absPath + ".cifer";
      writeFileSync(outPath, Buffer.from(await encrypted.arrayBuffer()));

      return {
        content: [
          {
            type: "text" as const,
            text: toJson({
              jobId: job.jobId,
              inputFile: absPath,
              outputFile: outPath,
              originalSize: buffer.length,
              encryptedSize: encrypted.size,
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: isCiferError(e)
              ? `Error: ${e.message} (code: ${e.code})`
              : `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: cifer_decrypt_file ─────────────────────────────────────────────────

server.tool(
  "cifer_decrypt_file",
  "Decrypt a .cifer file. Starts an async decryption job, polls until complete, and saves the decrypted result (strips the .cifer extension). The agent wallet must be the secret owner or delegate.",
  {
    filePath: z
      .string()
      .describe("Path to the .cifer file to decrypt."),
  },
  async ({ filePath }) => {
    try {
      const pk = requireEnv("CIFER_PK");
      const secretId = BigInt(requireEnv("CIFER_SECRET_ID"));
      const { signer } = buildSigner(pk);
      const sdk = await initSdk();

      const absPath = resolve(filePath);
      const buffer = readFileSync(absPath);
      const blob = new Blob([new Uint8Array(buffer)]);

      const job = await blackbox.files.decryptFile({
        chainId: CHAIN_ID,
        secretId,
        file: blob,
        signer,
        readClient: sdk.readClient,
        blackboxUrl: sdk.blackboxUrl,
      });

      const final = await blackbox.jobs.pollUntilComplete(
        job.jobId,
        sdk.blackboxUrl,
        { intervalMs: 2000, maxAttempts: 120 }
      );

      if (final.status !== "completed") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Decrypt job failed: ${final.error ?? final.status}`,
            },
          ],
          isError: true,
        };
      }

      const decrypted = await blackbox.jobs.download(job.jobId, {
        blackboxUrl: sdk.blackboxUrl,
        chainId: CHAIN_ID,
        secretId,
        signer,
        readClient: sdk.readClient,
      });

      const outPath = absPath.endsWith(".cifer")
        ? absPath.slice(0, -".cifer".length)
        : absPath + ".decrypted";
      writeFileSync(outPath, Buffer.from(await decrypted.arrayBuffer()));

      return {
        content: [
          {
            type: "text" as const,
            text: toJson({
              jobId: job.jobId,
              inputFile: absPath,
              outputFile: outPath,
              decryptedSize: decrypted.size,
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: isCiferError(e)
              ? `Error: ${e.message} (code: ${e.code})`
              : `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ── Tool: cifer_init ─────────────────────────────────────────────────────────

/** Canonical .env path — always the repo root, never inside dist/. */
const ENV_PATH = canonicalEnvPath(import.meta.url);
const DASHBOARD_URL =
  process.env.CIFER_DASHBOARD_URL ?? "https://cifer.ternoa.dev";

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const raw = readFileSync(ENV_PATH, "utf-8");
  const map: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

function writeEnvFile(next: Record<string, string>) {
  const knownOrder = [
    "CIFER_PK",
    "CIFER_SECRET_ID",
    "CIFER_BLACKBOX_URL",
    "CIFER_RPC_URL",
    "CIFER_CHAIN_ID",
  ];
  const lines: string[] = [
    "# Generated by cifer_init. Safe to edit by hand.",
    "# Never commit this file — it contains your agent's private key.",
    "",
  ];
  for (const k of knownOrder) {
    if (next[k] !== undefined) lines.push(`${k}=${next[k]}`);
  }
  const extras = Object.keys(next).filter((k) => !knownOrder.includes(k));
  if (extras.length) {
    lines.push("");
    for (const k of extras) lines.push(`${k}=${next[k]}`);
  }
  lines.push("");
  writeFileSync(ENV_PATH, lines.join("\n"));
}

server.tool(
  "cifer_init",
  "Onboard the agent to CIFER: generate an agent wallet (if one doesn't already exist) and write it to .env. If a `secretId` is provided, save it and verify on-chain that this wallet is authorized. Call this tool first when the agent has no CIFER_PK / CIFER_SECRET_ID yet. It returns the wallet address and concrete next-step instructions the agent can relay to the user.",
  {
    secretId: z
      .string()
      .optional()
      .describe(
        "Optional secret ID to save and verify. Omit on the first call to just generate the wallet; then come back with the ID after the user has delegated the secret."
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "If true, regenerate the wallet even if CIFER_PK already exists. Use with extreme care — you will lose access to any secret currently delegated to the old wallet."
      ),
  },
  async ({ secretId, force }) => {
    try {
      const env = readEnvFile();
      const hadPk =
        !!env.CIFER_PK && !env.CIFER_PK.startsWith("0x_your");

      let wallet: Wallet;
      let generatedNewWallet = false;
      if (!hadPk || force) {
        const random = Wallet.createRandom();
        wallet = new Wallet(random.privateKey);
        env.CIFER_PK = random.privateKey;
        generatedNewWallet = true;
      } else {
        wallet = new Wallet(env.CIFER_PK);
      }

      if (secretId) env.CIFER_SECRET_ID = secretId;
      writeEnvFile(env);

      const address = wallet.address;
      const currentSecretId = env.CIFER_SECRET_ID ?? null;

      // Verify on-chain if we have a secretId
      let verified = false;
      let authorized = false;
      let isSyncing: boolean | null = null;

      if (currentSecretId && currentSecretId.trim() !== "") {
        try {
          const sdk = await initSdk();
          const controllerAddress = sdk.getControllerAddress(CHAIN_ID);
          const params = {
            chainId: CHAIN_ID,
            controllerAddress,
            readClient: sdk.readClient,
          };
          const state = await keyManagement.getSecret(
            params,
            BigInt(currentSecretId)
          );
          authorized = await keyManagement.isAuthorized(
            params,
            BigInt(currentSecretId),
            address as `0x${string}`
          );
          isSyncing = state.isSyncing;
          verified = true;
        } catch (err) {
          // Verification failed (RPC issue, secret doesn't exist yet, etc.)
          // Not fatal — agent can retry later.
        }
      }

      const nextStep =
        !currentSecretId
          ? `Ask the user to open ${DASHBOARD_URL}, create a CIFER secret, delegate it to ${address}, and share the secret ID. Then call cifer_init again with secretId=<N>.`
          : !verified
            ? `Secret ID saved (${currentSecretId}) but could not verify on-chain. Ask the user to confirm the secret exists and has been delegated to ${address}.`
            : !authorized
              ? `Secret #${currentSecretId} is NOT delegated to ${address}. Ask the secret owner to delegate it via ${DASHBOARD_URL}.`
              : isSyncing
                ? `Ready — but secret #${currentSecretId} is still syncing. Wait 30–60 seconds before the first encrypt/decrypt call. If the MCP host is already configured, no restart is needed (the .env is reloaded on each tool call via dotenv).`
                : `Ready. Agent can now encrypt and decrypt with secret #${currentSecretId}. If this is the first install, register the server with the MCP host using the CLI: 'node dist/cifer-tool.js config <host> --apply' (hosts: hermes, claude-desktop, claude-code, openclaw, cursor), then restart the host.`;

      return {
        content: [
          {
            type: "text" as const,
            text: toJson({
              walletAddress: address,
              generatedNewWallet,
              envFile: ENV_PATH,
              secretId: currentSecretId,
              verified,
              authorized,
              isSyncing,
              dashboardUrl: DASHBOARD_URL,
              nextStep,
            }),
          },
        ],
      };
    } catch (e) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${e instanceof Error ? e.message : String(e)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
