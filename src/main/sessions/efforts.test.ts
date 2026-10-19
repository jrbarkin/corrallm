import { expect, it } from 'vitest';

import { effortChoice as claudeEffort } from './claude-code/efforts';
import { effortChoice as codexEffort } from './codex/efforts';
import { claudeOptions } from './claude-settings';
import { readModels } from './codex/app-server/session';
import { recordedResult } from './codex/app-server/recorded';

it.each(['constructor', 'toString', 'future'])(
  'both adapters label a new native effort %s',
  (value) => {
    expect(claudeEffort(value)).toEqual({ value, label: value });
    expect(codexEffort(value)).toEqual({ value, label: value });
  },
);

it('Claude Code labels every effort it offers without a session', async () => {
  const { models } = await claudeOptions({ CLAUDE_CONFIG_DIR: '/not-a-config' }, '/not-a-project');
  expect(models.flatMap((model) => model.efforts ?? []).length).toBeGreaterThan(0);
  for (const model of models)
    for (const effort of model.efforts ?? []) {
      expect(effort).toEqual(claudeEffort(effort.value));
      expect(effort.label.trim()).not.toBe('');
    }
  expect(claudeEffort('xhigh').label).toBe('Extra high');
});

it('Codex labels every effort from its recorded model list', () => {
  const models = readModels(recordedResult('options', 'model/list'));
  expect(models.flatMap((model) => model.efforts ?? []).length).toBeGreaterThan(0);
  for (const model of models)
    for (const effort of model.efforts ?? []) {
      expect(effort).toEqual(codexEffort(effort.value, effort.description));
      expect(effort.label.trim()).not.toBe('');
    }
  expect(codexEffort('xhigh').label).toBe('Extra high');
});
