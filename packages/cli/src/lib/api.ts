import { API_BASE } from "./config.js";
import type { PlatformConfig } from "@vent/shared";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
}

export async function apiFetch(
  path: string,
  apiKey: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new ApiError(res.status, body);
  }

  return res;
}

export interface EnsurePlatformConnectionResult {
  platform_connection_id: string;
  provider: string;
  identity_key: string;
  resource_label: string;
  version: number;
  created: boolean;
  updated: boolean;
  platform_summary: Record<string, unknown>;
}

export async function ensurePlatformConnection(
  apiKey: string,
  platform: PlatformConfig,
): Promise<EnsurePlatformConnectionResult> {
  const res = await apiFetch("/platform-connections/ensure", apiKey, {
    method: "POST",
    body: JSON.stringify({
      platform,
      client_context: {
        source: "cli",
      },
    }),
  });
  return res.json() as Promise<EnsurePlatformConnectionResult>;
}
