import ignore from 'ignore';

/** Fixed suggestions only (B9a Design §4); no repository string becomes an executable command. */
export interface SetupSpec {
  manager: 'npm' | 'pnpm';
  command: string;
  args: readonly string[];
  evidence: readonly string[];
}
export interface SetupFiles {
  /** Repository-relative filenames; detection considers only root-level project files. */
  files: readonly string[];
  /** The root package.json's bytes decoded by the caller, not a filename to open. */
  packageJson?: string;
}
export type SetupDetection =
  | { kind: 'suggested'; spec: SetupSpec }
  | {
      kind: 'manual';
      reason:
        | 'no-lockfile'
        | 'multiple-managers'
        | 'unsupported-manager'
        | 'missing-package-json'
        | 'invalid-package-json'
        | 'conflicting-package-manager';
      managers: readonly string[];
    };

const LOCKS: Readonly<Record<string, string>> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'uv.lock': 'uv',
  'Cargo.lock': 'cargo',
  'poetry.lock': 'poetry',
  'Pipfile.lock': 'pipenv',
  'Gemfile.lock': 'bundler',
  'composer.lock': 'composer',
};

/** Suggests what to offer, never permission to run it or a substitute for the native trust gate. */
export function detectSetup({ files, packageJson }: SetupFiles): SetupDetection {
  const names = new Set(files);
  const locks = Object.keys(LOCKS)
    .filter((name) => names.has(name))
    .sort();
  const managers = [...new Set(locks.map((name) => LOCKS[name]))]
    .filter((name): name is string => name !== undefined)
    .sort();
  const manual = (
    reason: Extract<SetupDetection, { kind: 'manual' }>['reason'],
  ): SetupDetection => ({ kind: 'manual', reason, managers });
  if (managers.length === 0) return manual('no-lockfile');
  if (managers.length > 1) return manual('multiple-managers');
  const manager = managers[0];
  if (manager !== 'npm' && manager !== 'pnpm') return manual('unsupported-manager');
  if (!names.has('package.json')) return manual('missing-package-json');
  let metadata: unknown;
  try {
    metadata = packageJson === undefined ? undefined : JSON.parse(packageJson);
  } catch {
    return manual('invalid-package-json');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return manual('invalid-package-json');
  const declared: unknown = 'packageManager' in metadata ? metadata.packageManager : undefined;
  if (
    declared !== undefined &&
    (typeof declared !== 'string' || /^([^@\s]+)@\S+$/.exec(declared)?.[1] !== manager)
  )
    return manual('conflicting-package-manager');
  return {
    kind: 'suggested',
    spec: {
      manager,
      command: manager === 'npm' ? 'npm ci' : 'pnpm install --frozen-lockfile',
      args: manager === 'npm' ? ['ci'] : ['install', '--frozen-lockfile'],
      evidence: ['package.json', ...locks],
    },
  };
}

export const COPY_LIMITS = {
  manifestBytes: 64 * 1024,
  files: 256,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
} as const;

/**
 * Caller-enumerated regular files with Git-relative names and observed sizes/ignored status.
 * This data is not trusted: the core must verify provenance, roots, links and current file state
 * before copying. The selector does no filesystem access, real-path check or path minting.
 */
export interface CopyCandidate {
  path: string;
  bytes: number;
  ignored: boolean;
}
export type CopySelectionFault =
  | 'manifest-bytes'
  | 'file-count'
  | 'file-bytes'
  | 'total-bytes'
  | 'invalid-size'
  | 'invalid-candidate'
  | 'duplicate-candidate';
export class CopySelectionError extends Error {
  readonly code: CopySelectionFault;
  readonly file?: string;
  constructor(code: CopySelectionFault, file?: string) {
    super(`Worktree copy selection: ${code}.`);
    this.name = 'CopySelectionError';
    this.code = code;
    if (file !== undefined) this.file = file;
  }
}

/**
 * `.worktreeinclude` selects with Git-ignore rules, intersected with the caller's ignored files.
 * No default `.env` pattern. A budget failure throws, so no caller gets a partial copy plan.
 */
export function selectCopyFiles(
  manifest: string | undefined,
  candidates: readonly CopyCandidate[],
): { files: CopyCandidate[]; bytes: number } {
  if (manifest === undefined) return { files: [], bytes: 0 };
  if (new TextEncoder().encode(manifest).length > COPY_LIMITS.manifestBytes)
    throw new CopySelectionError('manifest-bytes');
  // Names are Git-relative POSIX names. Use explicit case sensitivity rather than host defaults.
  const matcher = ignore({ ignorecase: false }).add(manifest);
  const files: CopyCandidate[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of candidates) {
    if (seen.has(file.path)) throw new CopySelectionError('duplicate-candidate', file.path);
    seen.add(file.path);
    if (!ignore.isPathValid(file.path))
      throw new CopySelectionError('invalid-candidate', file.path);
    if (!file.ignored || !matcher.ignores(file.path)) continue;
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0)
      throw new CopySelectionError('invalid-size', file.path);
    if (file.bytes > COPY_LIMITS.fileBytes) throw new CopySelectionError('file-bytes', file.path);
    if (files.length === COPY_LIMITS.files) throw new CopySelectionError('file-count');
    bytes += file.bytes;
    if (bytes > COPY_LIMITS.totalBytes) throw new CopySelectionError('total-bytes');
    files.push(file);
  }
  return { files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), bytes };
}
