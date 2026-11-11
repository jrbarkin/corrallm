import type { CommandStatus } from '../../shared/api/ops/app';

/**
 * What Settings says of the `corrallm` command, and which buttons it offers (B30 C2), from the
 * status alone: every word and every offer is one pure function of it. No field takes a path or
 * text; Install and Remove are each one operation.
 */
export interface CommandView {
  lines: string[];
  install: boolean;
  remove: boolean;
}

/** The folder of the link, as shown (`~/.local/bin/corrallm` → `~/.local/bin`). */
const folderOf = (shown: string) => shown.slice(0, shown.lastIndexOf('/')) || shown;

export function commandView(status: CommandStatus | undefined): CommandView {
  // An older core, or none yet: the section says nothing and offers nothing.
  if (status === undefined) return { lines: [], install: false, remove: false };
  if (status.state === 'unavailable') {
    return { lines: [status.sentence], install: false, remove: false };
  }
  const { link, runs } = status;
  const ours = runs?.current === true;
  const lines: string[] = [];
  if (ours) {
    lines.push(`Installed: \`corrallm\` runs this app (${runs.at})`);
  } else if (link.is === 'current') {
    lines.push(`Installed at ${link.at}`);
  } else if (link.is === 'stale') {
    lines.push(`${link.at} links to another copy of corrallm`);
  } else if (link.is === 'taken') {
    lines.push(`Something else is at ${link.at}; corrallm leaves it alone`);
  } else {
    lines.push('Not installed');
  }
  if (link.is === 'current' && !link.onPath && !ours) {
    lines.push(
      `${folderOf(link.at)} isn’t on your shell’s PATH: add \`export PATH="$HOME/.local/bin:$PATH"\` to your shell’s startup file`,
    );
  }
  if (runs !== null && !ours) {
    lines.push(`\`corrallm\` in your shell runs another program (${runs.at})`);
  }
  return {
    lines,
    install: (link.is === 'absent' || link.is === 'stale') && !ours,
    remove: link.is === 'current' || link.is === 'stale',
  };
}
