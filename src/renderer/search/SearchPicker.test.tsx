import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SearchPicker } from './SearchPicker';

const colors = ['Red', 'Green', 'Blue', 'Light green'];

function setup() {
  const onPick = vi.fn<(color: string) => void>();
  const onCancel = vi.fn<() => void>();
  render(
    <SearchPicker
      label="Color"
      options={colors}
      optionLabel={(color) => color}
      optionKey={(color) => color}
      onPick={onPick}
      onCancel={onCancel}
    />,
  );
  const field = screen.getByRole('combobox', { name: 'Color' });
  const shown = () => screen.queryAllByRole('option').map((o) => o.textContent);
  return { field, shown, onPick, onCancel };
}

describe('SearchPicker', () => {
  it('lists every option, then narrows them as you type, best match first', () => {
    const { field, shown } = setup();
    expect(document.activeElement).toBe(field);
    expect(shown()).toEqual(colors);
    fireEvent.change(field, { target: { value: 'green' } });
    expect(shown()).toEqual(['Green', 'Light green']);
    fireEvent.change(field, { target: { value: 'purple' } });
    expect(shown()).toEqual([]);
    expect(screen.getByText('No matches')).toBeTruthy();
  });

  it('picks with the arrow keys and Enter, or with a click', () => {
    const { field, onPick } = setup();
    fireEvent.change(field, { target: { value: 'green' } });
    expect(field.getAttribute('aria-activedescendant')).toBe(
      screen.getByRole('option', { name: 'Green' }).id,
    );
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('Light green');
    fireEvent.click(screen.getByRole('option', { name: 'Green' }));
    expect(onPick).toHaveBeenLastCalledWith('Green');
  });

  it('shows a detail under each option, and finds options by it after their names', () => {
    const details: Record<string, string> = { Red: 'warm', Green: 'grass', Blue: 'sky and sea' };
    render(
      <SearchPicker
        label="Shade"
        options={['Red', 'Green', 'Blue']}
        optionLabel={(color) => color}
        optionDetail={(color) => details[color] ?? ''}
        optionKey={(color) => color}
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole('option', { name: 'Blue sky and sea' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Shade' }), { target: { value: 'sea' } });
    expect(screen.getAllByRole('option').map((o) => o.firstChild?.textContent)).toEqual(['Blue']);
  });

  it('can take what was typed instead: offered after real matches, first when nothing matches', () => {
    const onPick = vi.fn<(color: string) => void>();
    const onText = vi.fn<(text: string) => void>();
    render(
      <SearchPicker
        label="Color"
        options={colors}
        optionLabel={(color) => color}
        optionKey={(color) => color}
        freeText={{ detail: 'your own colour', onPick: onText }}
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByRole('combobox', { name: 'Color' });
    const shown = () => screen.queryAllByRole('option').map((o) => o.textContent);
    expect(shown()).toEqual(colors);
    fireEvent.change(field, { target: { value: 'gre' } });
    expect(shown()).toEqual(['Green', 'Light green', '“gre” your own colour']);
    // Not when it names an option exactly.
    fireEvent.change(field, { target: { value: 'green' } });
    expect(shown()).toEqual(['Green', 'Light green']);
    // Letters in order no longer count as a match ("bl" would find "Blue" and "Light green").
    fireEvent.change(field, { target: { value: 'bgn' } });
    expect(shown()).toEqual(['“bgn” your own colour']);
    expect(screen.queryByText('No matches')).toBeNull();
    fireEvent.change(field, { target: { value: '  sea foam ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onText).toHaveBeenCalledWith('sea foam');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('lists options read from what was typed first, as they are, and no option twice', () => {
    const onPick = vi.fn<(color: string) => void>();
    render(
      <SearchPicker
        label="Color"
        options={colors}
        optionLabel={(color) => color}
        optionKey={(color) => color.toLowerCase()}
        typed={(query) => (query.startsWith('#') ? [`Hex ${query}`, 'Green'] : [])}
        onPick={onPick}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByRole('combobox', { name: 'Color' });
    const shown = () => screen.queryAllByRole('option').map((o) => o.textContent);
    expect(shown()).toEqual(colors);
    // Neither typed option matches what was typed, yet both are listed; Green only once.
    fireEvent.change(field, { target: { value: '#0f0' } });
    expect(shown()).toEqual(['Hex #0f0', 'Green']);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('Hex #0f0');
  });

  it('can start from a query, to change what was typed before', () => {
    render(
      <SearchPicker
        label="Color"
        options={colors}
        optionLabel={(color) => color}
        optionKey={(color) => color}
        initialQuery="Light"
        onPick={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const field = screen.getByRole<HTMLInputElement>('combobox', { name: 'Color' });
    expect(field.value).toBe('Light');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Light green']);
  });

  it('cancels on Escape, without the key reaching the rest of the page', () => {
    const { field, onCancel } = setup();
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    fireEvent.keyDown(field, { key: 'Escape' });
    document.removeEventListener('keydown', outside);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(outside).not.toHaveBeenCalled();
  });
});
