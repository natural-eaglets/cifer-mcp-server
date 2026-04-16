#!/usr/bin/env npx tsx
/**
 * cifer-tool.ts — Standalone CLI for AI agents to use CIFER encryption.
 *
 * Usage:  npx tsx cifer-tool.ts <command> [flags]
 *
 * Commands:
 *   check-env                       Validate that .env is configured
 *   check-secret [--id <N>]         Check if a secret exists and is ready
 *   get-quota                        Show remaining encrypt/decrypt quota
 *   encrypt --text "msg"             Encrypt a plaintext message
 *   decrypt --cifer <hex> --message <hex>   Decrypt a payload
 *   encrypt-file --file <path>       Encrypt a file (async job → downloads .cifer)
 *   decrypt-file --file <path>       Decrypt a .cifer file (async job → downloads result)
 *
 * All output is JSON on stdout so any agent framework can parse it.
 * Errors go to stderr and set a non-zero exit code.
 */

import "dotenv/config";
import { resolve, basename, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Wallet } from "ethers";
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

function ok(data: Record<string, unknown>) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }, replacer, 2) + "\n");
  process.exit(0);
}

function fail(message: string, details?: Record<string, unknown>) {
  process.stderr.write(
    JSON.stringify({ ok: false, error: message, ...details }, replacer, 2) + "\n"
  );
  process.exit(1);
}

/** JSON.stringify can't handle bigints natively. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "" || v.startsWith("0x_your")) {
    fail(`Missing or placeholder ${name} in .env. See .env.example.`);
  }
  return v!;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

// ─── Signer (private-key based, server-side) ─────────────────────────────────

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

// ─── SDK factory ─────────────────────────────────────────────────────────────

async function initSdk() {
  return createCiferSdk({
    blackboxUrl: BLACKBOX_URL,
    chainOverrides: {
      [CHAIN_ID]: { rpcUrl: RPC_URL },
    },
  });
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdCheckEnv() {
  const pk = process.env.CIFER_PK;
  const secretId = process.env.CIFER_SECRET_ID;
  const hasPk = !!pk && !pk.startsWith("0x_your");
  const hasSecretId = !!secretId && secretId.trim() !== "";

  let address: string | undefined;
  if (hasPk) {
    try {
      const wallet = new Wallet(pk);
      address = wallet.address;
    } catch {
      // invalid key format
    }
  }

  ok({
    CIFER_PK: hasPk ? "set" : "MISSING",
    CIFER_SECRET_ID: hasSecretId ? secretId : "MISSING",
    CIFER_BLACKBOX_URL: BLACKBOX_URL,
    CIFER_RPC_URL: RPC_URL,
    CIFER_CHAIN_ID: CHAIN_ID,
    walletAddress: address ?? null,
    ready: hasPk && hasSecretId,
  });
}

async function cmdCheckSecret(args: string[]) {
  const pk = requireEnv("CIFER_PK");
  const idStr = parseFlag(args, "--id") ?? requireEnv("CIFER_SECRET_ID");
  const secretId = BigInt(idStr);

  const sdk = await initSdk();
  const controllerAddress = sdk.getControllerAddress(CHAIN_ID);

  try {
    const state = await keyManagement.getSecret(
      { chainId: CHAIN_ID, controllerAddress, readClient: sdk.readClient },
      secretId
    );

    const { address } = buildSigner(pk);
    const authorized = await keyManagement.isAuthorized(
      { chainId: CHAIN_ID, controllerAddress, readClient: sdk.readClient },
      secretId,
      address as `0x${string}`
    );

    ok({
      secretId: secretId.toString(),
      owner: state.owner,
      delegate: state.delegate,
      isSyncing: state.isSyncing,
      ready: !state.isSyncing,
      publicKeyCid: state.publicKeyCid || null,
      walletAddress: address,
      walletAuthorized: authorized,
    });
  } catch (e) {
    if (isCiferError(e)) fail(e.message, { code: e.code });
    throw e;
  }
}

async function cmdGetQuota() {
  const pk = requireEnv("CIFER_PK");
  const { signer } = buildSigner(pk);
  const sdk = await initSdk();

  try {
    const quota = await blackbox.jobs.dataConsumption({
      chainId: CHAIN_ID,
      signer,
      readClient: sdk.readClient,
      blackboxUrl: sdk.blackboxUrl,
    });
    ok({ quota });
  } catch (e) {
    if (isCiferError(e)) fail(e.message, { code: e.code });
    throw e;
  }
}

async function cmdEncrypt(args: string[]) {
  const pk = requireEnv("CIFER_PK");
  const secretIdStr = requireEnv("CIFER_SECRET_ID");
  const secretId = BigInt(secretIdStr);
  const { signer } = buildSigner(pk);
  const sdk = await initSdk();

  const text = parseFlag(args, "--text");
  let plaintext: string;

  if (text) {
    plaintext = text;
  } else if (args.includes("--stdin")) {
    plaintext = readFileSync("/dev/stdin", "utf-8");
  } else {
    fail("Provide --text \"message\" or --stdin to read from pipe.");
    return; // unreachable, keeps TS happy
  }

  try {
    const result = await blackbox.payload.encryptPayload({
      chainId: CHAIN_ID,
      secretId,
      plaintext,
      signer,
      readClient: sdk.readClient,
      blackboxUrl: sdk.blackboxUrl,
      outputFormat: "hex",
    });

    ok({
      secretId: secretId.toString(),
      cifer: result.cifer,
      encryptedMessage: result.encryptedMessage,
      plaintextLength: plaintext.length,
    });
  } catch (e) {
    if (isCiferError(e)) fail(e.message, { code: e.code });
    throw e;
  }
}

async function cmdDecrypt(args: string[]) {
  const pk = requireEnv("CIFER_PK");
  const secretIdStr = requireEnv("CIFER_SECRET_ID");
  const secretId = BigInt(secretIdStr);
  const { signer } = buildSigner(pk);
  const sdk = await initSdk();

  const cifer = parseFlag(args, "--cifer");
  const encryptedMessage = parseFlag(args, "--message");

  if (!cifer || !encryptedMessage) {
    fail("Both --cifer <hex> and --message <hex> are required.");
    return;
  }

  try {
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

    ok({
      secretId: secretId.toString(),
      decryptedMessage: result.decryptedMessage,
    });
  } catch (e) {
    if (isCiferError(e)) fail(e.message, { code: e.code });
    throw e;
  }
}

async function cmdEncryptFile(args: string[]) {
  const pk = requireEnv("CIFER_PK");
  const secretIdStr = requireEnv("CIFER_SECRET_ID");
  const secretId = BigInt(secretIdStr);
  const { signer } = buildSigner(pk);
  const sdk = await initSdk();

  const filePath = parseFlag(args, "--file");
  if (!filePath) {
    fail("--file <path> is required.");
    return;
  }

  const absPath = resolve(filePath);
  const buffer = readFileSync(absPath);
  const blob = new Blob([new Uint8Array(buffer)]);

  try {
    const job = await blackbox.files.encryptFile({
      chainId: CHAIN_ID,
      secretId,
      file: blob,
      signer,
      readClient: sdk.readClient,
      blackboxUrl: sdk.blackboxUrl,
    });

    process.stderr.write(`Job started: ${job.jobId} — polling...\n`);

    const final = await blackbox.jobs.pollUntilComplete(
      job.jobId,
      sdk.blackboxUrl,
      {
        intervalMs: 2000,
        maxAttempts: 120,
        onProgress: (j) =>
          process.stderr.write(`  progress: ${j.progress}%\n`),
      }
    );

    if (final.status !== "completed") {
      fail("Encrypt job did not complete.", { jobId: job.jobId, status: final.status, error: final.error });
      return;
    }

    const encrypted = await blackbox.jobs.download(job.jobId, {
      blackboxUrl: sdk.blackboxUrl,
    });

    const outPath = absPath + ".cifer";
    writeFileSync(outPath, Buffer.from(await encrypted.arrayBuffer()));

    ok({
      jobId: job.jobId,
      inputFile: absPath,
      outputFile: outPath,
      originalSize: buffer.length,
      encryptedSize: encrypted.size,
    });
  } catch (e) {
    if (isCiferError(e)) fail(e.message, { code: e.code });
    throw e;
  }
}

async function cmdDecryptFile(args: string[]) {
  const pk = requireEnv("CIFER_PK");
  const secretIdStr = requireEnv("CIFER_SECRET_ID");
  const secretId = BigInt(secretIdStr);
  const { signer } = buildSigner(pk);
  const sdk = await initSdk();

  const filePath = parseFlag(args, "--file");
  if (!filePath) {
    fail("--file <path> is required.");
    return;
  }

  const absPath = resolve(filePath);
  const buffer = readFileSync(absPath);
  const blob = new Blob([new Uint8Array(buffer)]);

  try {
    const job = await blackbox.files.decryptFile({
      chainId: CHAIN_ID,
      secretId,
      file: blob,
      signer,
      readClient: sdk.readClient,
      blackboxUrl: sdk.blackboxUrl,
    });

    process.stderr.write(`Job started: ${job.jobId} — polling...\n`);

    const final = await blackbox.jobs.pollUntilComplete(
      job.jobId,
      sdk.blackboxUrl,
      {
        intervalMs: 2000,
        maxAttempts: 120,
        onProgress: (j) =>
          process.stderr.write(`  progress: ${j.progress}%\n`),
      }
    );

    if (final.status !== "completed") {
      fail("Decrypt job did not complete.", { jobId: job.jobId, status: final.status, error: final.error });
      return;
    }

    const decrypted = await blackbox.jobs.download(job.jobId, {
      blackboxUrl: sdk.blackboxUrl,
      chainId: CHAIN_ID,
      secretId,
      signer,
      readClient: sdk.readClient,
    });

    // Strip .cifer extension if present, otherwise append .decrypted
    const outPath = absPath.endsWith(".cifer")
      ? absPath.slice(0, -".cifer".length)
      : absPath + ".decrypted";
    writeFileSync(outPath, Buffer.from(await decrypted.arrayBuffer()));

    ok({
      jobId: job.jobId,
      inputFile: absPath,
      outputFile: outPath,
      decryptedSize: decrypted.size,
    });
  } catch (e) {
    if (isCiferError(e)) fail(e.message, { code: e.code });
    throw e;
  }
}

// ─── init ────────────────────────────────────────────────────────────────────

const ENV_PATH = join(process.cwd(), ".env");
const DASHBOARD_URL =
  process.env.CIFER_DASHBOARD_URL ?? "https://cifer.ternoa.dev";

/** Read .env as a key→value map, preserving nothing else. */
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

/** Write .env preserving the human-readable order; unknown keys are kept. */
function writeEnvFile(next: Record<string, string>) {
  const knownOrder = [
    "CIFER_PK",
    "CIFER_SECRET_ID",
    "CIFER_BLACKBOX_URL",
    "CIFER_RPC_URL",
    "CIFER_CHAIN_ID",
  ];
  const lines: string[] = [
    "# Generated by `cifer-mcp init`. Safe to edit by hand.",
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

async function cmdInit(args: string[]) {
  const secretIdArg = parseFlag(args, "--secret-id");
  const force = args.includes("--force");

  const env = readEnvFile();
  const hadPk = !!env.CIFER_PK && !env.CIFER_PK.startsWith("0x_your");

  // ── Step 1: ensure a wallet exists ──────────────────────────────────────
  let wallet: Wallet;
  let generatedNewWallet = false;
  if (!hadPk || force) {
    const random = Wallet.createRandom();
    wallet = new Wallet(random.privateKey);
    env.CIFER_PK = random.privateKey;
    generatedNewWallet = true;
  } else {
    try {
      wallet = new Wallet(env.CIFER_PK);
    } catch {
      fail("CIFER_PK in .env is not a valid EVM private key. Re-run with --force to regenerate.");
      return;
    }
  }

  // ── Step 2: handle secretId ─────────────────────────────────────────────
  if (secretIdArg) env.CIFER_SECRET_ID = secretIdArg;

  // Persist whatever we have so far
  writeEnvFile(env);

  const address = wallet.address;
  const secretIdStr = env.CIFER_SECRET_ID;

  // ── Step 3: verify on-chain authorization if we have a secretId ─────────
  let verified = false;
  let authorized = false;
  let isSyncing: boolean | null = null;

  if (secretIdStr && secretIdStr.trim() !== "") {
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
        BigInt(secretIdStr)
      );
      authorized = await keyManagement.isAuthorized(
        params,
        BigInt(secretIdStr),
        address as `0x${string}`
      );
      isSyncing = state.isSyncing;
      verified = true;
    } catch (e) {
      process.stderr.write(
        `⚠️  Could not verify secret on-chain: ${e instanceof Error ? e.message : String(e)}\n`
      );
    }
  }

  // ── Step 4: human-readable instructions on stderr ───────────────────────
  const box = (lines: string[]) => {
    process.stderr.write("\n");
    for (const l of lines) process.stderr.write(`  ${l}\n`);
    process.stderr.write("\n");
  };

  if (generatedNewWallet) {
    box([
      "🔑 Generated a new agent wallet.",
      `   Address:      ${address}`,
      `   Private key:  saved to .env (CIFER_PK)`,
      `   Fund note:    this wallet does NOT need gas — secret creation`,
      `                 is paid by the delegator (you).`,
    ]);
  } else {
    box([`✓ Using existing wallet  ${address}`]);
  }

  if (!secretIdStr || secretIdStr.trim() === "") {
    box([
      "👉 NEXT STEP — delegate a secret to this wallet:",
      "",
      `   1. Open ${DASHBOARD_URL}`,
      "   2. Connect your own wallet",
      "   3. Create a new CIFER secret (or reuse an existing one)",
      `   4. Click 'Delegate' and paste:  ${address}`,
      "   5. Copy the secret ID from the dashboard",
      "",
      `   Then run:  cifer-mcp init --secret-id <N>`,
    ]);
  } else if (verified && authorized) {
    box([
      `✅ Ready. Secret #${secretIdStr} is delegated to ${address}.`,
      isSyncing
        ? "   (Still syncing — wait 30–60 s before first encrypt.)"
        : "   Agent can encrypt and decrypt immediately.",
      "",
      "   Restart your MCP host (Hermes / Claude / OpenClaw) to",
      "   pick up the new server config.",
    ]);
  } else if (verified && !authorized) {
    box([
      `❌ Secret #${secretIdStr} exists but is NOT delegated to ${address}.`,
      "   The secret owner must delegate it to this wallet.",
    ]);
  } else {
    box([
      `⚠️  Saved CIFER_SECRET_ID=${secretIdStr} but could not verify on-chain yet.`,
      "   Check your RPC or run `cifer-mcp check-secret` later.",
    ]);
  }

  ok({
    walletAddress: address,
    generatedNewWallet,
    envFile: ENV_PATH,
    secretId: secretIdStr || null,
    verified,
    authorized,
    isSyncing,
    nextStep: !secretIdStr
      ? `Delegate secret to ${address}, then run: cifer-mcp init --secret-id <N>`
      : authorized
        ? "Restart your MCP host to pick up the config."
        : `Ask secret owner to delegate #${secretIdStr} to ${address}.`,
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

const commands: Record<string, (args: string[]) => Promise<void>> = {
  init: cmdInit,
  "check-env": cmdCheckEnv,
  "check-secret": cmdCheckSecret,
  "get-quota": cmdGetQuota,
  encrypt: cmdEncrypt,
  decrypt: cmdDecrypt,
  "encrypt-file": cmdEncryptFile,
  "decrypt-file": cmdDecryptFile,
};

if (!command || command === "--help" || command === "-h") {
  process.stderr.write(`
CIFER Agent Tool — Quantum-resistant encryption for AI agents on Ternoa.

Usage:  npx tsx cifer-tool.ts <command> [flags]

Commands:
  init [--secret-id <N>] [--force]     Generate agent wallet + write .env (start here)
  check-env                            Validate .env configuration
  check-secret [--id <N>]              Check if a secret exists and is ready
  get-quota                            Show encrypt/decrypt data quota
  encrypt --text "msg"                 Encrypt a plaintext message
  encrypt --stdin                      Encrypt text from stdin pipe
  decrypt --cifer <hex> --message <hex>  Decrypt a payload
  encrypt-file --file <path>           Encrypt a file → .cifer output
  decrypt-file --file <path>           Decrypt a .cifer file

All output is JSON on stdout. Progress/errors go to stderr.
Requires CIFER_PK and CIFER_SECRET_ID in .env — see .env.example.
`);
  process.exit(0);
}

const handler = commands[command];
if (!handler) {
  fail(`Unknown command: "${command}". Run with --help to see available commands.`);
} else {
  handler(args).catch((e) => {
    fail(e instanceof Error ? e.message : String(e));
  });
}
