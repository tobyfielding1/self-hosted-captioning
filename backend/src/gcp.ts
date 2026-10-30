const METADATA = "http://metadata.google.internal/computeMetadata/v1";

async function metadata(path: string): Promise<string | null> {
  try {
    const res = await fetch(`${METADATA}/${path}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

export async function projectId(): Promise<string | null> {
  return process.env.GOOGLE_CLOUD_PROJECT || (await metadata("project/project-id"));
}

export async function region(): Promise<string | null> {
  const r = await metadata("instance/region");
  return r ? r.split("/").pop()! : null;
}

let cached: { token: string; expires: number } | null = null;

export async function accessToken(): Promise<string | null> {
  if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const body = await metadata("instance/service-accounts/default/token");
  if (!body) return null;
  const { access_token, expires_in } = JSON.parse(body) as { access_token: string; expires_in: number };
  cached = { token: access_token, expires: Date.now() + expires_in * 1000 };
  return access_token;
}
