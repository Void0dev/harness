export function harnessRequestHeaders(endpoint, commandToken) {
  const loopback = endpoint.protocol === "http:"
    && (endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]" || endpoint.hostname === "::1");
  if (!commandToken) {
    if (!loopback) throw new Error("Invalid Harness command token");
    return {};
  }
  if (/\s/.test(commandToken)) throw new Error("Invalid Harness command token");
  return { Authorization: `Bearer ${commandToken}` };
}

export function validatedHarnessUrl(value, name) {
  const endpoint = new URL(value);
  if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error(`Invalid ${name}`);
  }
  return endpoint;
}
