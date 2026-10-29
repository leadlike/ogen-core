/** Where the worker's database is. A full DATABASE_URL wins; otherwise the parts ECS injects (host/name plain, user/password from Secrets Manager). */
export function databaseUrl(env: Record<string, string | undefined>): string {
  if (env.DATABASE_URL) return env.DATABASE_URL;
  const { DB_HOST: host, DB_NAME: name, DB_USER: user, DB_PASSWORD: password } = env;
  if (!host || !name || !user || !password) throw new Error('ENV_MISSING: DATABASE_URL, or DB_HOST + DB_NAME + DB_USER + DB_PASSWORD');
  // RDS enforces TLS. no-verify encrypts but does not check the certificate chain (the RDS CA is not in Node's store); bundle the CA to verify.
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${env.DB_PORT ?? '5432'}/${encodeURIComponent(name)}?sslmode=no-verify`;
}

/** GATEWAY_URL may use the host `auto` (the task's own private address), matching the gateway's GATEWAY_HOST=auto. */
export function gatewayUrl(raw: string, privateAddress: () => string): string {
  const u = new URL(raw);
  if (u.hostname === 'auto') u.hostname = privateAddress();
  return u.toString().replace(/\/$/, '');
}
