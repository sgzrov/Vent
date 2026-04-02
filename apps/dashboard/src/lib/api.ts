import type { RunRow, RunDetail } from "./types";

const API_URL = "/backend";

export async function fetchRuns(status?: string): Promise<RunRow[]> {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  const res = await fetch(`${API_URL}/runs?${params}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json();
}

export async function fetchRun(id: string): Promise<RunDetail> {
  const res = await fetch(`${API_URL}/runs/${id}`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch run: ${res.status}`);
  return res.json();
}

export async function setBaseline(runId: string) {
  const res = await fetch(`${API_URL}/runs/${runId}/baseline`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to set baseline: ${res.status}`);
  return res.json();
}

export interface AccessToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
  active: boolean;
}

export interface CreateAccessTokenResponse {
  id: string;
  access_token: string;
  name: string;
  prefix: string;
  created_at: string;
  warning: string;
}

export async function fetchAccessTokens(): Promise<AccessToken[]> {
  const res = await fetch(`${API_URL}/keys`, {
    cache: "no-store",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch access tokens: ${res.status}`);
  return res.json();
}

export async function createAccessToken(name: string): Promise<CreateAccessTokenResponse> {
  const res = await fetch(`${API_URL}/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to create access token: ${res.status}`);
  return res.json();
}

export async function revokeAccessToken(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/keys/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to revoke access token: ${res.status}`);
}
