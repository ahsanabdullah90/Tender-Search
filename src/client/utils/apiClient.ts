export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = init ? await fetch(url, init) : await fetch(url);
  const data = typeof res.json === 'function' ? await res.json().catch(() => null) : null;
  if (!res.ok || (data && typeof data === 'object' && 'success' in data && (data as { success?: boolean }).success === false)) {
    const payload = data as { message?: string; error?: string } | null;
    const message = payload?.message || payload?.error || `HTTP ${res.status || 500}`;
    throw new ApiError(res.status || 500, message, data);
  }
  return data as T;
}

export async function apiMutate<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method }
      : {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        };
  return apiJson<T>(url, init);
}
