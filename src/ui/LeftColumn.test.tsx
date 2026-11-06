// @vitest-environment jsdom
/**
 * A shift-range in the source tree may only reach rows the tree is showing.
 *
 * The range is resolved against an ORDER the column hands the store, because
 * the project array is not the order the rows are drawn in. That order left the
 * filter out: with "SUB" typed into the box the tree showed three cabinets and a
 * shift-click across them selected eight, five of which were off screen. The
 * selection then feeds the level field, the delete button and every transform
 * in the Inspector, so the operator trims or deletes cabinets they were never
 * shown.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LeftColumn } from './LeftColumn';
import { makeSource, useStore } from '../state/store';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';

/**
 * Ten cabinets, because the filter box only appears above eight, alternating so
 * that a hidden row always sits BETWEEN two shown ones. A range that ignores the
 * filter cannot help but pick the hidden ones up.
 */
function tenAlternating() {
  const sources = Array.from({ length: 10 }, (_, i) =>
    makeSource(DEFAULT_SPEAKER_ID, i % 2 === 0 ? `MAIN ${i / 2 + 1}` : `FILL ${(i + 1) / 2}`, {
      x: i,
      y: 0,
      z: 0,
    }),
  );
  useStore.setState({ sources, groups: [], selectedSourceIds: [], anchorSourceId: null });
  return sources;
}

beforeEach(() => {
  cleanup();
  useStore.setState({ lang: 'en' });
});

describe('shift-range in the source tree', () => {
  it('stops at the rows the filter is showing', () => {
    const sources = tenAlternating();
    render(<LeftColumn onAdd={() => {}} onCreateArray={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'main' } });
    expect(screen.queryByText('FILL 1')).toBeNull();

    fireEvent.click(screen.getByText('MAIN 1'));
    fireEvent.click(screen.getByText('MAIN 3'), { shiftKey: true });

    const wanted = sources.filter((x) => x.label.startsWith('MAIN ')).slice(0, 3);
    expect(useStore.getState().selectedSourceIds).toEqual(wanted.map((x) => x.id));
    // and the filter has not narrowed the range to the two rows clicked: the
    // one drawn between them is still in it
    expect(useStore.getState().selectedSourceIds).toHaveLength(3);
  });
});
