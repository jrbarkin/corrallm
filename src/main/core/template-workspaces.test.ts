import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import type { SessionMode } from '../../shared/session';
import { EXAMPLES } from '../../shared/examples';
import { fromFile, toFile } from '../../shared/model/file';
import { fillTemplate } from '../../shared/model/templates';
import { CATALOG, DEFAULT_ADAPTER } from '../sessions/adapters';
import { FakeConnector } from '../sessions/fake';
import type { SessionSpec } from '../sessions/connector';
import { createCore } from './core';
import type { Core } from './core';
import { keepCanvases } from './store/test-store';
import { CALLERS, NO_DESKTOP } from './test-registry';
import { commit, git, gitEnvironment, makeRepository, scratch } from './workspaces/test-git';

// The core's composed C services allocate, bind and verify real worktrees. Only native sessions
// and process identity inspection are faked, as in workspaces-composed.test.ts; no real CLI runs.
let core: Core | undefined;
let remove: (() => void) | undefined;
afterEach(async () => {
  await core?.close();
  core = undefined;
  remove?.();
});

async function prepare(name: string, owned = true) {
  const fixture = EXAMPLES.find((example) => example.name === name);
  if (!fixture) throw new Error(name);
  const { root, remove: clean } = scratch('corrallm-template-workspaces-');
  remove = clean;
  const project = path.join(root, 'project');
  const env = gitEnvironment(path.join(root, 'home'));
  const base = makeRepository(project, env, { 'README.md': 'picked checkout\n' });
  const values = Object.fromEntries(
    (fixture.fields ?? []).map(({ key, example }) => [key, example]),
  );
  const doc = fillTemplate(fromFile(fixture.text, CATALOG, DEFAULT_ADAPTER), values);
  doc.nodes = doc.nodes.map((node) =>
    node.type !== 'agent'
      ? node
      : {
          ...node,
          data: {
            ...node.data,
            connection:
              (node.data.adapter ?? DEFAULT_ADAPTER) === 'codex'
                ? 'codex.app-server'
                : 'claude-code.sdk',
          },
        },
  );
  const profile = path.join(root, 'profile');
  mkdirSync(profile);
  const file = path.join(root, 'template.corral');
  writeFileSync(file, toFile(doc));
  await keepCanvases(profile, { [doc.id]: { file, project } });
  const claude = new FakeConnector({ adapter: 'claude-code' });
  const codex = new FakeConnector({ adapter: 'codex' });
  core = await createCore(
    {
      profile,
      app: { name: 'corrallm', version: '1' },
      distribution: 'local',
      check: true,
      watchFolder: () => ({ close: () => undefined }),
      children: {
        platform: 'darwin',
        inspect: (pid) => ({ started: 1, group: pid }),
        alive: () => false,
        signal: () => undefined,
        wait: () => Promise.resolve(),
        pause: () => undefined,
        now: Date.now,
      },
      sessions: {
        connectors: { 'claude-code.sdk': claude, 'codex.app-server': codex },
        environment: () => Promise.resolve(env),
      },
    },
    NO_DESKTOP,
  );
  const active = core;
  if (owned) await active.engines.open(doc.id);
  return { active, doc, claude, codex, project, env, base };
}

async function open(name: string) {
  const { active, doc, claude, codex, project, env, base } = await prepare(name);
  const specs = new Map<string, SessionSpec<SessionMode>>();
  for (const node of doc.nodes.filter((node) => node.type === 'agent')) {
    let result = await active.call('session.open', { canvas: doc.id, agent: node.id }, CALLERS.you);
    if (!result.ok) {
      // No dependency command is run: a person skips each new tree's real setup card.
      let need: string | undefined;
      await vi.waitFor(
        async () => {
          const needs = await active.call('needs', { canvas: doc.id }, CALLERS.you);
          if (needs.ok) need = needs.value.items.find((item) => item.id.startsWith('setup/'))?.id;
          expect(need).toBeDefined();
        },
        { timeout: 15000 },
      );
      expect(
        await active.call(
          'reply',
          { canvas: doc.id, to: need, answer: { choice: 'skip' } },
          CALLERS.you,
        ),
      ).toMatchObject({ ok: true });
      result = await active.call('session.open', { canvas: doc.id, agent: node.id }, CALLERS.you);
    }
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const spec = [...claude.started, ...codex.started].find((spec) => spec.agentId === node.id);
    if (!spec) throw new Error(`No session for ${node.id}`);
    specs.set(node.id, spec);
  }
  const cwd = (agent: string) => {
    const spec = specs.get(agent);
    if (!spec) throw new Error(agent);
    return spec.cwd;
  };
  const write = (agent: string, file: string, text: string) => {
    const at = path.join(cwd(agent), file);
    mkdirSync(path.dirname(at), { recursive: true });
    writeFileSync(at, text);
  };
  const read = (agent: string, file: string) => readFileSync(path.join(cwd(agent), file), 'utf8');
  return { project, base, env, specs, cwd, write, read };
}

it('opens a window’s session on the canvas the core runs once its tree is ready, raising setup only through the directory seam', async () => {
  const { active, doc, codex } = await prepare('TDD relay', false);
  // A window showing a canvas makes the core run it (B11 Design §8), but nothing is provisioned
  // until a session or its availability is asked for.
  expect(await active.call('window.show', { canvas: doc.id }, CALLERS.you)).toMatchObject({
    ok: true,
  });
  expect(active.engines.opened()).toEqual([doc.id]);
  expect(await active.call('needs', { canvas: doc.id }, CALLERS.you)).toMatchObject({
    ok: true,
    value: { items: [] },
  });
  expect(codex.started).toEqual([]);
  const caller = CALLERS.you;
  if (caller.kind !== 'human' || caller.window === 'host') throw new Error('No test window');
  const window = caller.window;
  expect(await active.channels.call(window, 'session:availability', ['tester'])).toMatchObject({
    ready: false,
    reason: 'creating',
  });
  let setup: string | undefined;
  await vi.waitFor(
    async () => {
      const needs = await active.call('needs', { canvas: doc.id }, CALLERS.you);
      if (needs.ok) setup = needs.value.items.find(({ id }) => id.startsWith('setup/'))?.id;
      expect(setup).toBeDefined();
    },
    { timeout: 15000 },
  );
  expect(
    await active.call(
      'reply',
      { canvas: doc.id, to: setup, answer: { choice: 'skip' } },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true });
  expect(await active.channels.call(window, 'session:availability', ['tester'])).toMatchObject({
    ready: true,
  });
  expect(await active.call('session.open', { agent: 'tester' }, CALLERS.you)).toMatchObject({
    ok: true,
  });
  expect(codex.started).toHaveLength(1);
  expect(codex.started[0]?.cwd).toContain('/.corral/worktrees/');
  expect(
    await active.call(
      'project.files',
      { canvas: doc.id, agent: 'tester', query: 'README' },
      CALLERS.you,
    ),
  ).toMatchObject({ ok: true, value: { items: ['README.md'] } });
  expect(active.engines.opened()).toEqual([doc.id]);
}, 60000);

const handoffs: Record<string, { write: [string, string][]; reader: string }> = {
  'Spec first': {
    write: [
      ['planner', 'SPEC.md'],
      ['planner', 'PLAN.md'],
      ['builder', 'tests/red.test'],
    ],
    reader: 'reviewer',
  },
  'Feature crew': {
    write: [
      ['researcher', 'NOTES.md'],
      ['builder', 'src/feature.ts'],
      ['reviewer', '.review/feature.md'],
    ],
    reader: 'docs',
  },
  'Team lead': {
    write: [
      ['planner', 'PLAN.md'],
      ['frontend', 'src/ui.ts'],
      ['backend', 'src/api.ts'],
    ],
    reader: 'tester',
  },
  'Fan-out research': {
    write: [
      ['r1', 'NOTES-1.md'],
      ['r2', 'NOTES-2.md'],
      ['r3', 'NOTES-3.md'],
    ],
    reader: 'writer',
  },
  'TDD relay': {
    write: [
      ['tester', 'tests/discount.test'],
      ['implementer', 'src/pricing.ts'],
    ],
    reader: 'refactorer',
  },
  'Review panel': {
    write: [
      ['builder', 'src/feature.ts'],
      ['code', '.review/code.md'],
      ['security', '.review/security.md'],
      ['tests-review', '.review/tests.md'],
    ],
    reader: 'lead',
  },
  'Review loop': { write: [['coder', 'src/issue.ts']], reader: 'reviewer' },
  'Independent cross-check': { write: [['builder', 'src/result.ts']], reader: 'checker' },
  'Release checks': { write: [['fixer', 'src/fix.ts']], reader: 'releaser' },
};

it.each(Object.keys(handoffs))(
  '%s hands actual uncommitted files to the next role in one core-managed tree',
  async (name) => {
    const made = await open(name);
    const handoff = handoffs[name];
    if (!handoff) throw new Error(name);
    expect(new Set([...made.specs.values()].map(({ cwd }) => cwd)).size).toBe(1);
    for (const [writer, file] of handoff.write) {
      const text = `${writer}'s uncommitted ${file}\n`;
      made.write(writer, file, text);
      expect(made.read(handoff.reader, file)).toBe(text);
      expect(existsSync(path.join(made.project, file))).toBe(false);
    }
    expect(git(made.cwd(handoff.reader), made.env, 'rev-parse', 'HEAD').trim()).toBe(made.base);
    expect(git(made.project, made.env, 'status', '--porcelain')).toBe('');
  },
  60000,
);

it('Head to head reads contestants and two rounds of Judge feedback only through committed generated refs', async () => {
  const made = await open('Head to head');
  expect(new Set([...made.specs.values()].map(({ cwd }) => cwd)).size).toBe(3);
  // Test-owned facts only: C's authorized context selector is not yet composed. Never expose
  // these raw store/Git facts to a caller as a substitute for that missing selector.
  const refs = new Map(
    ['claude', 'codex', 'judge'].map((role) => [
      role,
      git(made.cwd(role), made.env, 'symbolic-ref', 'HEAD').trim(),
    ]),
  );
  for (const ref of refs.values()) expect(ref).toMatch(/^refs\/heads\/corrallm\//);
  const refOf = (role: string) => {
    const ref = refs.get(role);
    if (ref === undefined) throw new Error(`No ref for ${role}`);
    return ref;
  };
  for (const round of ['1', '2']) {
    for (const role of ['claude', 'codex']) {
      if (round === '2') {
        const feedback = git(
          made.cwd(role),
          made.env,
          'show',
          `${refOf('judge')}:.compete/feedback-${role}.md`,
        );
        expect(feedback).toContain('Round: 1');
        expect(existsSync(path.join(made.cwd(role), '.compete', `feedback-${role}.md`))).toBe(
          false,
        );
      }
      made.write(role, 'src/variant.ts', `${role} round ${round}\n`);
      made.write(role, '.compete/result.md', `Round: ${round}\n`);
      // A wait cannot deliver this uncommitted result or make it visible via the ref.
      const readResult = () =>
        git(made.cwd('judge'), made.env, 'show', `${refOf(role)}:.compete/result.md`);
      if (round === '1') expect(readResult).toThrow();
      else expect(readResult()).toContain('Round: 1');
      git(made.cwd(role), made.env, 'add', '-A');
      commit(made.cwd(role), made.env, `result ${role} ${round}`);
      expect(readResult()).toBe(`Round: ${round}\n`);
      expect(git(made.cwd('judge'), made.env, 'show', `${refOf(role)}:src/variant.ts`)).toBe(
        `${role} round ${round}\n`,
      );
      made.write('judge', `.compete/feedback-${role}.md`, `Round: ${round}\nImprove ${role}\n`);
      const readFeedback = () =>
        git(made.cwd(role), made.env, 'show', `${refOf('judge')}:.compete/feedback-${role}.md`);
      if (round === '1') expect(readFeedback).toThrow();
      else expect(readFeedback()).toContain('Round: 1');
    }
    made.write('judge', '.compete/judged-round.md', `Round: ${round}\n`);
    git(made.cwd('judge'), made.env, 'add', '-A');
    commit(made.cwd('judge'), made.env, `feedback ${round}`);
    for (const role of ['claude', 'codex'])
      expect(
        git(made.cwd(role), made.env, 'show', `${refOf('judge')}:.compete/feedback-${role}.md`),
      ).toContain(`Round: ${round}`);
  }
  expect(git(made.project, made.env, 'rev-parse', 'HEAD').trim()).toBe(made.base);
  expect(git(made.project, made.env, 'status', '--porcelain')).toBe('');
}, 60000);
