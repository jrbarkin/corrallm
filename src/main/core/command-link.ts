import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, rename, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { CommandStatus } from '../../shared/api/ops/app';
import { OpFailure } from './call';

/*
 * The `corrallm` command linked onto your PATH from the app's Settings (B30 C1 to C3), where the
 * running packaged app's launcher is: one symbolic link, `~/.local/bin/corrallm`, which needs no
 * privilege and writes no shell startup file. Yours alone (`app.command`).
 *
 * It writes only that path, and only its own link: a symbolic link whose target text is an absolute
 * path ending in the bundle's launcher (`/Contents/Resources/bin/corrallm` on macOS,
 * `/resources/bin/corrallm` on Linux). That is corrallm's link, whether it runs this app, a moved
 * copy or another; it may replace that. It never replaces or removes anything else (a file, a
 * folder, a FIFO, another program's link): that reads `taken`. `~/.local` and `~/.local/bin` must be
 * real folders you own that neither group nor others can write, or the install is refused; missing,
 * they are made 0700, and an existing folder's mode is never changed. It writes by a temporary link
 * and a rename, so a failure leaves the path as it was. The status is computed when read (an lstat
 * and a readlink, and a walk of the PATH the core gives its agents): no watcher. Every failure is a
 * fixed sentence, with no error text and no path beyond the link's own. A process running as you
 * could swap the link between its checks: the OS user is the boundary, as for tokens.
 */

/** The link's own name and folder, under home. */
const LOCAL = '.local';
const BIN = 'bin';
const NAME = 'corrallm';
/** What a link of corrallm's own ends in, on either platform. */
const OWN_ENDINGS = ['/Contents/Resources/bin/corrallm', '/resources/bin/corrallm'];

const WINDOWS = 'The corrallm command isn’t available on Windows yet.';
const NO_LAUNCHER =
  'This build of corrallm ships no command to link: use a packaged build, or the app from a package.';
const TRANSLOCATED = 'Move corrallm to Applications, then open it from there.';

export interface CommandLinkDeps {
  home: string;
  /** The PATH the core gives its agents. */
  searchPath: () => Promise<string>;
  /** The packaged app's launcher, as its host says; none under plain Node or unpackaged. */
  launcher: () => string | null;
  platform?: NodeJS.Platform;
  /** The file operations the write uses, replaceable for failure tests. */
  rename?: typeof rename;
  symlink?: typeof symlink;
}

type Link = 'absent' | 'current' | 'stale' | 'taken';

export class CommandLink {
  readonly #deps: CommandLinkDeps;

  constructor(deps: CommandLinkDeps) {
    this.#deps = deps;
  }

  /** The command's status, read now. */
  async status(): Promise<CommandStatus> {
    const launcher = await this.#launcher();
    if (typeof launcher === 'string') return { state: 'unavailable', sentence: launcher };
    return this.#ready(launcher.real);
  }

  /** Links the command, if it isn't there already: whether it wrote, and the status after. */
  async install(): Promise<{ changed: boolean; command: CommandStatus }> {
    const launcher = await this.#launcher();
    if (typeof launcher === 'string') throw new OpFailure('refused', launcher);
    const was = await this.#ready(launcher.real);
    if (was.state === 'ready') {
      if (was.link.is === 'taken') throw new OpFailure('refused', this.#taken(was.link.at));
      // Current, or this app's command already runs through another path (a package's link).
      if (was.link.is === 'current' || was.runs?.current === true) {
        return { changed: false, command: was };
      }
    }
    await this.#write(launcher.real);
    return { changed: true, command: await this.#ready(launcher.real) };
  }

  /** Removes the link corrallm made, if it is there: whether it removed, and the status after. */
  async remove(): Promise<{ changed: boolean; command: CommandStatus }> {
    const launcher = await this.#launcher();
    if (typeof launcher === 'string') throw new OpFailure('refused', launcher);
    const was = await this.#ready(launcher.real);
    if (was.state === 'ready') {
      if (was.link.is === 'taken') throw new OpFailure('refused', this.#taken(was.link.at));
      if (was.link.is === 'absent') return { changed: false, command: was };
    }
    const at = this.#at();
    // Looked at again, as it is unlinked: only its own link.
    if ((await this.#is(at, launcher.real)) === 'taken') {
      throw new OpFailure('refused', this.#taken(this.#shown(at)));
    }
    try {
      await unlink(at);
    } catch {
      throw new OpFailure('unavailable', `corrallm couldn’t remove ${this.#shown(at)}.`);
    }
    return { changed: true, command: await this.#ready(launcher.real) };
  }

  #at(): string {
    return path.join(this.#deps.home, LOCAL, BIN, NAME);
  }

  /** `~/…` under home, else absolute: text for Settings, never a link. */
  #shown(file: string): string {
    const relative = path.relative(this.#deps.home, file);
    return relative.startsWith('..') || path.isAbsolute(relative) ? file : path.join('~', relative);
  }

  #taken(at: string): string {
    return `Something else is at ${at}: corrallm leaves it alone. Remove it yourself, or link the command somewhere else.`;
  }

  /** The launcher's real path, or why there is none to link. */
  async #launcher(): Promise<{ real: string } | string> {
    if ((this.#deps.platform ?? process.platform) === 'win32') return WINDOWS;
    const given = this.#deps.launcher();
    if (given === null || !path.isAbsolute(given)) return NO_LAUNCHER;
    if (given.split(path.sep).includes('AppTranslocation')) return TRANSLOCATED;
    try {
      const real = await realpath(given);
      if (real.split(path.sep).includes('AppTranslocation')) return TRANSLOCATED;
      if (!(await stat(real)).isFile()) return NO_LAUNCHER;
      return { real };
    } catch {
      return NO_LAUNCHER;
    }
  }

  async #ready(launcher: string): Promise<CommandStatus> {
    const at = this.#at();
    const searchPath = await this.#deps.searchPath();
    const folders = searchPath.split(path.delimiter).filter((one) => path.isAbsolute(one));
    const wanted = path.dirname(at);
    let onPath = false;
    let runs: { at: string; current: boolean } | null = null;
    for (const folder of folders) {
      if (path.resolve(folder) === wanted) onPath = true;
      if (runs !== null) continue;
      const found = path.join(folder, NAME);
      try {
        const real = await realpath(found);
        if ((await stat(real)).isFile()) {
          runs = { at: this.#shown(found), current: real === launcher };
        }
      } catch {
        // Not in this folder.
      }
    }
    return {
      state: 'ready',
      link: { at: this.#shown(at), is: await this.#is(at, launcher), onPath },
      runs,
    };
  }

  /** What is at `at`: nothing, corrallm's link to `launcher`, to something else of its own, or other. */
  async #is(at: string, launcher: string): Promise<Link> {
    let found;
    try {
      found = await lstat(at);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'taken';
    }
    if (!found.isSymbolicLink()) return 'taken';
    let target: string;
    try {
      target = await readlink(at);
    } catch {
      return 'taken';
    }
    if (!path.isAbsolute(target) || !OWN_ENDINGS.some((ending) => target.endsWith(ending))) {
      return 'taken';
    }
    return target === launcher ? 'current' : 'stale';
  }

  async #write(launcher: string): Promise<void> {
    const at = this.#at();
    const folder = path.dirname(at);
    const refused = `corrallm couldn’t link the command: ${this.#shown(folder)} is a link, isn’t yours, or others can write to it, so link it yourself.`;
    const failed = `corrallm couldn’t link the command into ${this.#shown(folder)}: link it yourself.`;
    const local = path.join(this.#deps.home, LOCAL);
    try {
      for (const one of [local, folder]) {
        let found;
        try {
          found = await lstat(one);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await mkdir(one, { mode: 0o700 });
          continue;
        }
        if (
          !found.isDirectory() ||
          found.uid !== process.getuid?.() ||
          (found.mode & 0o022) !== 0
        ) {
          throw new OpFailure('refused', refused);
        }
      }
    } catch (error) {
      if (error instanceof OpFailure) throw error;
      throw new OpFailure('unavailable', failed);
    }
    const temporary = path.join(folder, `.corrallm-link-${randomBytes(8).toString('hex')}`);
    try {
      await (this.#deps.symlink ?? symlink)(launcher, temporary);
      await (this.#deps.rename ?? rename)(temporary, at);
      // The path is the link it made.
      if ((await lstat(at)).isSymbolicLink() && (await readlink(at)) === launcher) return;
      throw new Error('not the link made');
    } catch {
      await unlink(temporary).catch(() => undefined);
      throw new OpFailure('unavailable', failed);
    }
  }
}
