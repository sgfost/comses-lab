export const demoMode = import.meta.env.MODE === "demo";
import type { ApiError } from "../../shared/contracts";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly detail: ApiError["error"],
  ) {
    super(detail.message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (demoMode) return (await import("./demo/api")).demoApi<T>(path, init);
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      body?.error ?? {
        code: "request_failed",
        message: `Request failed (${response.status})`,
      },
    );
  }
  if (body === null)
    throw new ApiRequestError(response.status, {
      code: "invalid_response",
      message: "The server returned an invalid response",
    });
  return body;
}
