import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { CanvasDocument } from '../src/shared/model/canvas';
import { workspaceOwners } from '../src/shared/model/workspaces';
import { readOnDisk } from '../src/main/core/store/test-store';
import { commit, git, gitEnvironment, makeRepository } from '../src/main/core/workspaces/test-git';
import { dismissStart, openNeeds } from './canvas-actions';
import { launchApp } from './launch';

// Real app/port/dialog/provisioning, fake native sessions only. File writes below are explicit
// fixture work at the app's recorded checkouts, not claimed model execution of prompt text.
// Context delivery itself awaits C's authorized selector and generation/resume contract.
const cases = [
  ['Spec first', 'SPEC.md'],
  ['Feature crew', 'NOTES.md'],
  ['Team lead', 'PLAN.md'],
  ['Fan-out research', 'NOTES-1.md'],
  ['TDD relay', 'tests/red.test'],
  ['Review panel', '.review/code.md'],
  ['Review loop', 'src/issue.ts'],
  ['Independent cross-check', 'src/result.ts'],
  ['Release checks', 'src/fix.ts'],
  ['Head to head', '.compete/result.md'],
] as const;

// One app for every template, as a user makes one canvas after another: each case creates its
// canvas from the gallery beside the ones before it, in a project repository of its own, and
// reads its own canvas's trees by id. A failure stops the rest (serial), whose canvases would sit
// beside a half-made one.
test.describe.configure({ mode: 'serial' });

let dir: string;
let env: Record<string, string>;
let profile: string;
let app: ElectronApplication;
let close: (() => Promise<void>) | undefined;
let page: Page;
let failed = false;
let problems: string[] = [];

test.beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-template-e2e-'));
  profile = path.join(dir, 'profile');
  await mkdir(profile);
  env = gitEnvironment(path.join(dir, 'home'));
  ({ app, close } = await launchApp({
    profile,
    env: { ...env, SHELL: '/bin/sh', CORRALLM_FAKE_SESSIONS: '1' },
    diagnoseFailure: () => failed,
  }));
  page = await app.firstWindow();
  // Warnings too: React Flow's one production diagnostic is a console.warn ("Parent node … not
  // found": a child placed before its parent), which a template's nested groups would raise.
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    problems.push(error.message);
  });
  await page.waitForLoadState('load');
  await dismissStart(page);
});

test.beforeEach(() => {
  problems = [];
});

test.afterEach(() => {
  if (test.info().status !== test.info().expectedStatus) failed = true;
  expect(problems).toEqual([]);
});

test.afterAll(async () => {
  try {
    await close?.();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [index, [name, artifact]] of cases.entries()) {
  test(`${name}: the shipped grouping allocates the right trees and hands real files through them`, async () => {
    const project = path.join(dir, `project-${String(index)}`);
    const base = makeRepository(project, env, { 'README.md': 'base\n' });
    await app.evaluate(({ dialog }, project) => {
      Object.assign(dialog, {
        showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [project] }),
      });
    }, project);
    // The first canvas is empty and offers the gallery; later ones open it from the file bar.
    await page
      .getByRole('button', { name: index === 0 ? 'Start from a template…' : 'Templates…' })
      .click();
    const gallery = page.getByRole('dialog', { name: 'Templates' });
    await gallery.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    for (const choice of await gallery.getByRole('combobox', { name: /^How / }).all()) {
      const selected = await choice.inputValue();
      if (selected === 'claude-code.terminal') await choice.selectOption('claude-code.sdk');
      if (selected === 'codex.terminal') await choice.selectOption('codex.app-server');
    }
    await gallery.getByRole('button', { name: 'Create canvas' }).click();
    // A new canvas has no project folder until one is chosen for it.
    await page.getByRole('button', { name: 'Choose a project folder' }).click();
    await expect(gallery).toHaveCount(0);

    // The new canvas draws its agents and their work, fitted into view clear of the file bar.
    const nodes = page.locator('.react-flow__node');
    await expect(nodes.nth(1)).toBeVisible();
    // Attached rather than visible: a straight vertical edge has no width.
    await expect(page.locator('[data-testid^="rf__edge-work:"]').first()).toBeAttached();
    const bar = await page.getByRole('toolbar', { name: 'Canvas file' }).boundingBox();
    if (!bar) throw new Error('The file bar has no box');
    for (const node of await nodes.all())
      expect((await node.boundingBox())?.y).toBeGreaterThan(bar.y + bar.height);

    const doc = (await page.evaluate(async () => {
      const shown = await window.api.windowGet({});
      if (!shown.ok) throw new Error(shown.error.sentence);
      const result = await window.api.canvasGet({ canvas: shown.value.canvas });
      if (!result.ok) throw new Error(result.error.sentence);
      return {
        id: result.value.canvas,
        arrange: result.value.arrange,
        nodes: result.value.nodes,
        links: result.value.links,
      };
    })) as CanvasDocument;
    const owners = workspaceOwners(doc);
    expect(owners).toHaveLength(name === 'Head to head' ? 3 : 1);
    if (name !== 'Head to head')
      expect(doc.nodes.find((node) => node.id === owners[0]?.node)?.type).toBe('frame');
    for (const agent of doc.nodes.filter((node) => node.type === 'agent')) {
      // The fixture requests launch with session.open, using the document's own settings.
      // The agent window's viewing lease uses the same core startup path.
      const availability = await page.evaluate(
        ({ canvas, agent }) => window.api.sessionOpen({ canvas, agent }),
        { canvas: doc.id, agent: agent.id },
      );
      if (!availability.ok) {
        expect(availability.error.sentence, JSON.stringify(availability)).toMatch(
          /worktree|setup/i,
        );
        await expect(page.getByRole('button', { name: 'Needs you', exact: true })).toBeEnabled({
          timeout: 15000,
        });
        await openNeeds(page);
        const skip = page
          .getByRole('complementary', { name: 'Needs you' })
          .getByRole('button', { name: 'Skip', exact: true });
        await skip.click();
        await expect(skip).toHaveCount(0);
      }
      const opened = await page.evaluate(
        ({ canvas, agent }) => window.api.sessionOpen({ canvas, agent }),
        { canvas: doc.id, agent: agent.id },
      );
      expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
    }
    const trees = readOnDisk(profile, (db) =>
      db
        .prepare(
          'SELECT a.agent_id, w.path, w.branch_ref FROM agent_worktree a JOIN worktree w ON w.id = a.workspace_id WHERE a.canvas_id = ?',
        )
        .all(doc.id),
    ).map((row) => ({
      agent: String(row.agent_id),
      path: String(row.path),
      ref: String(row.branch_ref),
    }));
    expect(trees).toHaveLength(doc.nodes.filter((node) => node.type === 'agent').length);
    expect(new Set(trees.map((tree) => tree.path)).size).toBe(name === 'Head to head' ? 3 : 1);
    if (name !== 'Head to head') {
      const first = trees[0];
      if (!first) throw new Error('No tree');
      await mkdir(path.dirname(path.join(first.path, artifact)), { recursive: true });
      await writeFile(path.join(first.path, artifact), 'uncommitted handoff\n');
      for (const tree of trees) {
        expect(await readFile(path.join(tree.path, artifact), 'utf8')).toBe(
          'uncommitted handoff\n',
        );
        const files = await page.evaluate(
          ({ canvas, agent, query }) => window.api.projectFiles({ canvas, agent, query }),
          { canvas: doc.id, agent: tree.agent, query: path.basename(artifact) },
        );
        expect(files).toMatchObject({ ok: true });
        if (files.ok) expect(files.value.items).toContain(artifact);
      }
    } else {
      const by = (role: string) => {
        const agent = doc.nodes.find(
          (node) => node.type === 'agent' && node.data.label.toLowerCase() === role,
        );
        const tree = trees.find((tree) => tree.agent === agent?.id);
        if (!tree) throw new Error(role);
        return tree;
      };
      for (const role of ['claude', 'codex']) {
        const contestant = by(role);
        await mkdir(path.join(contestant.path, '.compete'));
        await writeFile(path.join(contestant.path, '.compete/result.md'), 'Round: 1\n');
        git(contestant.path, env, 'add', '-A');
        commit(contestant.path, env, `result ${role}`);
        expect(git(by('judge').path, env, 'show', `${contestant.ref}:.compete/result.md`)).toBe(
          'Round: 1\n',
        );
      }
      await mkdir(path.join(by('judge').path, '.compete'));
      for (const role of ['claude', 'codex'])
        await writeFile(
          path.join(by('judge').path, `.compete/feedback-${role}.md`),
          'Round: 1\nImprove this\n',
        );
      expect(() =>
        git(by('claude').path, env, 'show', `${by('judge').ref}:.compete/feedback-claude.md`),
      ).toThrow();
      git(by('judge').path, env, 'add', '-A');
      commit(by('judge').path, env, 'feedback');
      for (const role of ['claude', 'codex'])
        expect(
          git(by(role).path, env, 'show', `${by('judge').ref}:.compete/feedback-${role}.md`),
        ).toContain('Round: 1');
    }
    expect(git(project, env, 'rev-parse', 'HEAD').trim()).toBe(base);
    expect(git(project, env, 'status', '--porcelain')).toBe('');
  });
}
