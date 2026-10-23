import { existsSync } from 'node:fs';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface NativeModule {
  /** Top-level entries of the package needed at runtime. */
  files: readonly string[];
  /** Entries of the package's "dependencies" that are only needed to compile it. */
  buildOnlyDependencies: readonly string[];
}

export const NATIVE_MODULES: Readonly<Record<string, NativeModule>> = {
  'node-pty': {
    files: ['package.json', 'LICENSE', 'lib', 'prebuilds'],
    buildOnlyDependencies: ['node-addon-api'],
  },
};

const DROPPED_FILES = /\.(pdb|map|d\.ts)$|\.test\.js$/;

export async function copyNativeModule(
  name: string,
  module: NativeModule,
  buildPath: string,
  platform: string,
  arch: string,
  project = path.resolve(import.meta.dirname, '..'),
): Promise<void> {
  const requireFromProject = createRequire(path.join(project, 'package.json'));
  const source = path.dirname(requireFromProject.resolve(`${name}/package.json`));
  const destination = path.join(buildPath, 'node_modules', name);
  const target = `${platform === 'mas' ? 'darwin' : platform}-${arch}`;

  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).filter(
    (dependency) => !module.buildOnlyDependencies.includes(dependency),
  );
  if (runtimeDependencies.length > 0) {
    throw new Error(
      `${name} has runtime dependencies (${runtimeDependencies.join(', ')}) that are not copied ` +
        'into the package. Add them to NATIVE_MODULES in build/native-modules.ts.',
    );
  }

  for (const entry of module.files) {
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      filter: (file) => {
        if (DROPPED_FILES.test(file)) return false;
        // Keep only the prebuilt binaries for the platform being packaged.
        const [top, prebuild] = path.relative(source, file).split(path.sep);
        return top !== 'prebuilds' || prebuild === undefined || prebuild === target;
      },
    });
  }

  if (
    module.files.includes('prebuilds') &&
    !existsSync(path.join(destination, 'prebuilds', target))
  ) {
    throw new Error(`${name} ships no prebuilt binary for ${target}.`);
  }
}
