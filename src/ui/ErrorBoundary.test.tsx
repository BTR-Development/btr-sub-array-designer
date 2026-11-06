// @vitest-environment jsdom
/**
 * The recovery screen, tested for the one thing it exists to do.
 *
 * Rescuing the project matters more than anything else on that screen, so that
 * is what is asserted first: not that a heading appeared, but that the work is
 * in localStorage and can be parsed back into a project.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CRASH_KEY, ErrorBoundary } from './ErrorBoundary';
import { useStore } from '../state/store';
import { parseBTRProject } from '../io/btrJson';
import { EXAMPLE_RIGS } from '../state/exampleRigs';
import { DEFAULT_SPEAKER_ID } from '../speakers/library';

function Boom(): never {
  throw new Error('projection exploded');
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().newProject();
  // React prints the caught error; that is expected here and not a failure.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('when a render throws', () => {
  it('rescues the project before drawing anything', () => {
    const demo = EXAMPLE_RIGS.find((p) => p.id === 'demo')!.build();
    useStore.getState().loadDoc(demo.doc, demo.sim);
    const before = useStore.getState().sources.length;

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const saved = localStorage.getItem(CRASH_KEY);
    expect(saved).toBeTruthy();
    // and it is a real project, not a fragment: it has to survive reopening
    expect(parseBTRProject(saved!).sources).toHaveLength(before);
  });

  it('shows the real error rather than a soothing sentence', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/projection exploded/)).toBeTruthy();
  });

  it('offers the rescued copy as a file', () => {
    useStore.getState().addSource(DEFAULT_SPEAKER_ID, { x: 0, y: 0, z: 0 });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Download project')).toBeTruthy();
  });

  it('says plainly when there was nothing to rescue', () => {
    // An empty project must not claim a rescue happened. Telling someone their
    // work is safe when nothing was saved is worse than saying nothing.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(localStorage.getItem(CRASH_KEY)).toBeNull();
    expect(screen.getByText(/nothing needed saving/)).toBeTruthy();
    expect(screen.queryByText('Download project')).toBeNull();
  });

  it('leaves a healthy tree alone', () => {
    render(
      <ErrorBoundary>
        <p>working</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('working')).toBeTruthy();
    expect(localStorage.getItem(CRASH_KEY)).toBeNull();
  });
});
