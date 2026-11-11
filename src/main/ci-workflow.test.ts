import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');

/** The text of one top-level job of ci.yml, from its key to the next job's. */
function job(workflow: string, name: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`ci.yml has no ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z][\w-]*:$/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

/** The text of one step of a job, from its `- name:` to the next step's. */
function step(text: string, name: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`no step named ${name}`);
  const end = lines.findIndex((line, index) => index > start && /^ {6}- /.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

describe('.github/workflows/ci.yml', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');

  it('runs the build job’s unit tests under bash on every OS, Windows included', () => {
    const tests = step(job(workflow, 'build'), 'Unit tests');
    expect(tests).toMatch(/^ {8}shell: bash$/m);
    expect(tests).toContain('RUNNER_OS');
  });

  it('keeps Windows non-blocking and main-only', () => {
    const build = job(workflow, 'build');
    expect(build).toContain("continue-on-error: ${{ matrix.os == 'windows-latest' }}");
    expect(build).toMatch(/github\.ref == 'refs\/heads\/main' && '\[[^\]]*windows-latest/);
  });

  describe('the dco job', () => {
    const dco = job(workflow, 'dco');

    it('runs only for pull requests from forks', () => {
      const condition = /^ {4}if: (.*)$/m.exec(dco)?.[1] ?? '';
      expect(condition).toContain("github.event_name == 'pull_request'");
      expect(condition).toContain(
        'github.event.pull_request.head.repo.full_name != github.repository',
      );
      expect(condition).not.toContain('||');
    });

    it('has read-only contents, no other permission and no secrets', () => {
      expect(dco).toMatch(/^ {4}permissions:\n {6}contents: read\n/m);
      expect(dco).not.toMatch(/secrets\./i);
      expect(dco).not.toMatch(/\bwrite\b/);
      expect(dco).not.toContain('pull_request_target');
      expect(dco).not.toMatch(/GITHUB_TOKEN/);
    });

    it('checks out without keeping credentials, with the history it compares', () => {
      expect(dco).toContain('persist-credentials: false');
      expect(dco).toContain('fetch-depth: 0');
    });

    it('runs scripts/check-dco.mjs on the pull request’s own commits, read through the environment', () => {
      expect(dco).toContain('node scripts/check-dco.mjs "$BASE" "$HEAD"');
      expect(dco).toContain('BASE: ${{ github.event.pull_request.base.sha }}');
      expect(dco).toContain('HEAD: ${{ github.event.pull_request.head.sha }}');
      // Never an expression inside the shell command itself.
      expect(/run: .*\$\{\{/.test(dco)).toBe(false);
    });
  });

  it('triggers on pull requests, so the dco job can run, without privileged events', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {2}pull_request:\n/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
  });
});

describe('.github/release.yml', async () => {
  const notes = await readFile(path.join(root, '.github/release.yml'), 'utf8');

  it('keeps dependency updates out of the generated notes’ headline groups', () => {
    expect(notes).toMatch(/exclude:\n {4}labels:\n {6}- dependencies/);
    expect(notes).toContain('dependabot[bot]');
  });

  it('groups what remains, ending with a catch-all', () => {
    const titles = [...notes.matchAll(/- title: (.*)/g)].map((match) => match[1]);
    expect(titles).toEqual(['Features', 'Fixes', 'Documentation', 'Other changes']);
    expect(notes.trimEnd().endsWith("- '*'")).toBe(true);
  });
});
