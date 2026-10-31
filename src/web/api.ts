// Calls the server's JSON API and names the shapes it answers with.

export class ApiError extends Error {
  status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

// ── Answers ──────────────────────────────────────────────────────────────────

export interface Health {
  name: string;
  version: string;
  server_name: string;
  started_epoch: number;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export async function api<Answer>(path: string): Promise<Answer> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  const answer = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(answer?.error ?? `${response.status} ${response.statusText}`, response.status);
  return answer as Answer;
}
