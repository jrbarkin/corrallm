import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
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

for (const [name, artifact] of cases) {
  test(`${name}: the shipped grouping allocates the right trees and hands real files through them`, async () => {
    const testInfo = test.info();
    const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-template-e2e-'));
    const profile = path.join(dir, 'profile');
    await mkdir(profile);
    const project = path.join(dir, 'project');
    const env = gitEnvironment(path.join(dir, 'home'));
    const base = makeRepository(project, env, { 'README.md': 'base\n' });
    const { app, close } = await launchApp({
      profile,
      env: { ...env, SHELL: '/bin/sh', CORRALLM_FAKE_SESSIONS: '1' },
      diagnoseFailure: () => testInfo.status !== testInfo.expectedStatus,
    });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('load');
      await dismissStart(page);
      await app.evaluate(({ dialog }, project) => {
        Object.assign(dialog, {
          showOpenDialog: () => Promise.resolve({ canceled: false, filePaths: [project] }),
        });
      }, project);
      await page.getByRole('button', { name: 'Start from a template…' }).click();
      const gallery = page.getByRole('dialog', { name: 'Templates' });
      await gallery.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      for (const choice of await gallery.getByRole('combobox', { name: /^How / }).all()) {
        const selected = await choice.inputValue();
        if (selected === 'claude-code.terminal') await choice.selectOption('claude-code.sdk');
        if (selected === 'codex.terminal') await choice.selectOption('codex.app-server');
      }
      await gallery.getByRole('button', { name: 'Create canvas' }).click();
      await page.getByRole('button', { name: 'Choose a project folder' }).click();
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
        const opened = await page.evaluate((agent) => window.api.sessionOpen({ agent }), agent.id);
        if (!opened.ok) {
          await expect(page.getByRole('button', { name: 'Needs you', exact: true })).toBeEnabled({
            timeout: 15000,
          });
          await openNeeds(page);
          const skip = page
            .getByRole('complementary', { name: 'Needs you' })
            .getByRole('button', { name: 'Skip', exact: true });
          await skip.click();
          await expect(skip).toHaveCount(0);
          expect(
            await page.evaluate((agent) => window.api.sessionOpen({ agent }), agent.id),
          ).toMatchObject({ ok: true });
        }
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
            ({ agent, query }) => window.api.projectFiles({ agent, query }),
            { agent: tree.agent, query: path.basename(artifact) },
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
    } finally {
      await close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
