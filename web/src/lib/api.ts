/**
 * Thin fetch wrapper. Sessions are an httpOnly cookie, so there is no token to
 * juggle here; `credentials: include` is all that is needed.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * The server answers 428 for anything the user must clear before carrying
   * on, and says which in `code` — so these two are distinguished by the code
   * rather than by the status alone.
   */
  get needsPasswordChange() {
    return this.body?.code === 'PASSWORD_CHANGE_REQUIRED';
  }

  /** Set when a mandatory activity is standing in the way. */
  get needsActivity() {
    return this.body?.code === 'ACTIVITY_REQUIRED';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Only declare a JSON content-type when there is actually a JSON body.
  // Sending `Content-Type: application/json` with an empty body makes Fastify
  // reject the request with "Body cannot be empty", which would break every
  // bodyless POST - starting a test, submitting a paper, signing out.
  const isForm = init.body instanceof FormData;
  const hasBody = init.body !== undefined && init.body !== null;

  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: !isForm && hasBody ? { 'Content-Type': 'application/json' } : {},
      ...init,
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: Record<string, unknown> | undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    const message = (body?.error as string) || `Request failed (${res.status}).`;
    throw new ApiError(message, res.status, body);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PATCH', body: data === undefined ? undefined : JSON.stringify(data) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: 'PUT', body: data === undefined ? undefined : JSON.stringify(data) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};
