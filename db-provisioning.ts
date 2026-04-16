export type ProvisionDatabaseOptions = {
  provisionerUrl: string;
  installationId: string;
  walletAddress: string;
  signMessage: (message: string) => Promise<string>;
  secretId?: string | null;
  timeoutMs?: number;
};

export type ProvisionedDatabase = {
  installationId: string;
  databaseUrl: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslmode?: string | null;
  reused: boolean;
};

function normalizeProvisionerUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function requireStringField(
  payload: Record<string, unknown>,
  key: string
): string {
  const value = payload[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Provisioner response is missing "${key}".`);
  }
  return value;
}

function requireNumberField(
  payload: Record<string, unknown>,
  key: string
): number {
  const value = payload[key];
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Provisioner response is missing "${key}".`);
  }
  return value;
}

type ProvisionChallenge = {
  challengeId: string;
  walletAddress: string;
  installationId: string;
  message: string;
  expiresAt: number;
};

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(
      `Provisioner returned HTTP ${response.status} but not valid JSON.`
    );
  }
}

async function requestProvisionChallenge(
  options: ProvisionDatabaseOptions,
  signal: AbortSignal
): Promise<ProvisionChallenge> {
  const response = await fetch(
    `${normalizeProvisionerUrl(options.provisionerUrl)}/challenge`,
    {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        installationId: options.installationId,
        walletAddress: options.walletAddress,
      }),
    }
  );

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    const detail =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `HTTP ${response.status}`;
    throw new Error(`Challenge request failed: ${detail}`);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Challenge response was not an object.");
  }

  const data = payload as Record<string, unknown>;
  return {
    challengeId: requireStringField(data, "challengeId"),
    walletAddress: requireStringField(data, "walletAddress"),
    installationId: requireStringField(data, "installationId"),
    message: requireStringField(data, "message"),
    expiresAt: requireNumberField(data, "expiresAt"),
  };
}

export async function provisionDatabase(
  options: ProvisionDatabaseOptions
): Promise<ProvisionedDatabase> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const challenge = await requestProvisionChallenge(options, controller.signal);
    const signature = await options.signMessage(challenge.message);
    const response = await fetch(
      `${normalizeProvisionerUrl(options.provisionerUrl)}/provision`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          installationId: challenge.installationId,
          walletAddress: challenge.walletAddress,
          signature,
          secretId: options.secretId ?? null,
        }),
      }
    );

    const payload = await parseJsonResponse(response);

    if (!response.ok) {
      const detail =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : `HTTP ${response.status}`;
      throw new Error(`Database provisioning failed: ${detail}`);
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Provisioner response was not an object.");
    }

    const data = payload as Record<string, unknown>;
    const sslmode =
      typeof data.sslmode === "string" && data.sslmode.trim() !== ""
        ? data.sslmode
        : null;

    return {
      installationId: requireStringField(data, "installationId"),
      databaseUrl: requireStringField(data, "databaseUrl"),
      host: requireStringField(data, "host"),
      port: requireStringField(data, "port"),
      user: requireStringField(data, "user"),
      password: requireStringField(data, "password"),
      database: requireStringField(data, "database"),
      sslmode,
      reused: Boolean(data.reused),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `Database provisioning timed out after ${timeoutMs} ms.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function databaseEnvEntries(
  provisioned: ProvisionedDatabase,
  provisionerUrl: string
): Record<string, string> {
  const entries: Record<string, string> = {
    CIFER_DB_PROVISIONER_URL: provisionerUrl,
    CIFER_DB_INSTALLATION_ID: provisioned.installationId,
    DATABASE_URL: provisioned.databaseUrl,
    PGHOST: provisioned.host,
    PGPORT: provisioned.port,
    PGUSER: provisioned.user,
    PGPASSWORD: provisioned.password,
    PGDATABASE: provisioned.database,
  };

  if (provisioned.sslmode) {
    entries.PGSSLMODE = provisioned.sslmode;
  }

  return entries;
}
