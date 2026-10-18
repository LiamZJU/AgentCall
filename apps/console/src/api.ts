const KEY = "agentphone.operatorKey";

export type Health = {
  ok: boolean;
  twilio: boolean;
  devSimulate: boolean;
  publicBaseUrl: string;
};

export function getKey(): string {
  return sessionStorage.getItem(KEY) ?? "dev-operator";
}

export function setKey(value: string): void {
  sessionStorage.setItem(KEY, value);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getKey()}`);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
  if (!response.ok) throw new Error(body.error || text || response.statusText);
  return body;
}
