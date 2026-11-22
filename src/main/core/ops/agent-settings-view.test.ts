import { describe, expect, it } from 'vitest';
import { engineCatalog } from '../../../shared/model/catalog';
import { MADE_UP } from '../../../shared/test-made-up';
import type { OpenCanvas } from '../engines';
import { agentSettingsView } from './views';

function open(settings: object = {}, session: object = {}): OpenCanvas {
  return {
    document: {
      nodes: [
        {
          id: 'a',
          type: 'agent',
          data: { label: 'A', adapter: 'zed', settings: { zed: settings } },
        },
      ],
    },
    engine: {
      catalog: engineCatalog(MADE_UP),
      sessions: { of: () => ({ model: null, effort: null, ...session }) },
    },
  } as unknown as OpenCanvas;
}

describe('agent model and effort provenance', () => {
  it('represents empty native observations as unknown values', () => {
    expect(agentSettingsView(open({}, { model: '', effort: '' }), 'a')).toMatchObject({
      model: null,
      effort: null,
      modelSource: 'native-default',
      effortSource: 'native-default',
    });
  });
  it('reports an acknowledged live choice and a cleared live effort', () => {
    expect(
      agentSettingsView(
        open({ model: 'live' }, { running: { effort: 'high' }, model: 'live', effort: null }),
        'a',
      ),
    ).toEqual({
      model: 'live',
      effort: null,
      modelSource: 'agent',
      effortSource: 'native-default',
    });
  });
  it('reports saved settings before a session starts', () => {
    expect(agentSettingsView(open({ model: 'chosen', effort: 'high' }), 'a')).toEqual({
      model: 'chosen',
      effort: 'high',
      modelSource: 'agent',
      effortSource: 'agent',
    });
  });
  it('leaves unreported native defaults unknown', () => {
    expect(agentSettingsView(open(), 'a')).toEqual({
      model: null,
      effort: null,
      modelSource: 'native-default',
      effortSource: 'native-default',
    });
  });
  it('uses reported native values without guessing from a model list', () => {
    expect(
      agentSettingsView(
        open({}, { model: 'reported', models: [{ value: 'reported', defaultEffort: 'low' }] }),
        'a',
      ),
    ).toEqual({
      model: 'reported',
      effort: null,
      modelSource: 'native-default',
      effortSource: 'native-default',
    });
  });
  it('keeps the running generation’s settings while a new setting waits for restart', () => {
    expect(
      agentSettingsView(
        open(
          { model: 'next', effort: 'low' },
          { running: { model: 'current', effort: 'high' }, model: 'current', effort: 'high' },
        ),
        'a',
      ),
    ).toEqual({ model: 'current', effort: 'high', modelSource: 'agent', effortSource: 'agent' });
  });
});
