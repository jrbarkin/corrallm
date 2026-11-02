// Only the native overrides our fake receives; no real home or native config is read.
export function fakeConfig(args, base = {}) {
  const config = structuredClone(base),
    origins = {};
  function mark(value, key, source) {
    if (value && typeof value === 'object' && !Array.isArray(value))
      for (const [part, one] of Object.entries(value)) mark(one, `${key}.${part}`, source);
    else origins[key.replace(/^mcp_servers\./, '')] = source;
  }
  for (const [key, value] of Object.entries(config)) mark(value, key, 'user');
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const override = args[++i] ?? '',
      at = override.indexOf('=');
    if (at < 0) continue;
    const parts = override.slice(0, at).split('.');
    let value;
    try {
      value = parse(override.slice(at + 1));
    } catch {
      continue;
    }
    let target = config;
    for (const key of parts.slice(0, -1)) target = target[key] ??= {};
    const last = parts.at(-1);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      target[last] &&
      typeof target[last] === 'object'
    )
      Object.assign(target[last], value);
    else target[last] = value;
    mark(value, parts.join('.'), 'sessionFlags');
  }
  return { config, origins };
}
function parse(text) {
  const tokens =
    text.match(/"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_.-]*|-?\d+(?:\.\d+)?|[{}[\],=]/g) ?? [];
  let at = 0;
  const take = () => {
    const token = tokens[at++];
    if (token === '{') {
      const result = {};
      while (tokens[at] !== '}') {
        const key = tokens[at++];
        if (key === undefined || tokens[at++] !== '=') throw new Error('table');
        result[key.startsWith('"') ? JSON.parse(key) : key] = take();
        if (tokens[at] === ',') at++;
      }
      at++;
      return result;
    }
    if (token === '[') {
      const result = [];
      while (tokens[at] !== ']') {
        result.push(take());
        if (tokens[at] === ',') at++;
      }
      at++;
      return result;
    }
    return JSON.parse(token);
  };
  return take();
}
