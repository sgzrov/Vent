const FLY_API_BASE = "https://api.machines.dev/v1";

interface MachineConfig {
  appName: string;
  image: string;
  env: Record<string, string>;
  region: string;
  cpuKind?: string;
  cpus?: number;
  memoryMb?: number;
  initCmd?: string[];
}

interface Machine {
  id: string;
  state: string;
  config?: { image?: string };
}

function getHeaders(): Record<string, string> {
  const token = process.env["FLY_API_TOKEN"];
  if (!token) throw new Error("FLY_API_TOKEN is required");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function resolveAppImage(appName: string): Promise<string | null> {
  const response = await fetch(
    `${FLY_API_BASE}/apps/${appName}/machines`,
    { headers: getHeaders() }
  );

  if (!response.ok) return null;

  const machines = (await response.json()) as Machine[];
  const image = machines.find((m) => m.config?.image)?.config?.image;
  return image ?? null;
}

export async function createMachine(config: MachineConfig): Promise<string> {
  const response = await fetch(
    `${FLY_API_BASE}/apps/${config.appName}/machines`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({
        region: config.region,
        config: {
          image: config.image,
          env: config.env,
          ...(config.initCmd ? { init: { cmd: config.initCmd } } : {}),
          guest: {
            cpu_kind: config.cpuKind ?? "shared",
            cpus: config.cpus ?? 1,
            memory_mb: config.memoryMb ?? 4096,
          },
          auto_destroy: true,
          restart: { policy: "no" },
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create machine: ${response.status} ${text}`);
  }

  const machine = (await response.json()) as Machine;
  return machine.id;
}

export async function waitForMachine(
  appName: string,
  machineId: string,
  timeoutMs: number = 300_000
): Promise<"stopped" | "destroyed"> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(
      `${FLY_API_BASE}/apps/${appName}/machines/${machineId}`,
      { headers: getHeaders() }
    );

    if (!response.ok) {
      throw new Error(`Failed to get machine status: ${response.status}`);
    }

    const machine = (await response.json()) as Machine;

    if (machine.state === "stopped" || machine.state === "destroyed") {
      return machine.state as "stopped" | "destroyed";
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`Machine ${machineId} timed out after ${timeoutMs}ms`);
}

export async function destroyMachine(
  appName: string,
  machineId: string
): Promise<void> {
  const response = await fetch(
    `${FLY_API_BASE}/apps/${appName}/machines/${machineId}?force=true`,
    {
      method: "DELETE",
      headers: getHeaders(),
    }
  );

  if (!response.ok && response.status !== 404) {
    console.warn(`Failed to destroy machine ${machineId}: ${response.status}`);
  }
}
