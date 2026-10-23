/** A login-shell read the startup-shutdown test can release once serve acknowledges its signal. */
export function startupShell(reading: string, release: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh
if [ "$1" != "-ilc" ]; then exec /bin/sh "$@"; fi
printf '%s\\n' "$PPID" > ${quote(reading)}
while [ ! -f ${quote(release)} ]; do sleep 0.05; done
exec /bin/sh -c "$2"
`;
}
