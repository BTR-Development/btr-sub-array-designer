// @vitest-environment jsdom
/**
 * The banner is the only part of crash recovery a user ever sees. A copy in
 * localStorage that nothing mentions is not a rescue, so the rule the module
 * has always had — written constantly, offered almost never — only holds if the
 * offer actually reaches the screen.
 *
 * What makes this worth a file of its own is the timing. Whether the last
 * session died is now settled by asking the other tabs, which takes a round
 * trip, so the answer arrives AFTER this component's first render. Reading once
 * and concluding there was nothing would have turned the feature off entirely
 * while leaving every test in autosave.test.ts green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CrashRecovery } from './CrashRecovery';
import { PROBE_MS, installAutosave, openKey, projectKey, atKey } from '../state/autosave';
import { useStore } from '../state/store';
import { EN } from '../i18n';

const stops: (() => void)[] = [];

/** A project the last session was holding when it stopped running. */
function leaveOneBehind() {
  const at = new Date(Date.now() - 20_000).toISOString();
  localStorage.setItem(openKey('crashed'), at);
  localStorage.setItem(atKey('crashed'), at);
  localStorage.setItem(
    projectKey('crashed'),
    JSON.stringify({ format: 'btr-sub-array', version: 2, sources: [] }),
  );
}

beforeEach(() => {
  localStorage.clear();
  useStore.getState().newProject();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  cleanup();
  vi.useRealTimers();
});

const banner = () => screen.queryByText(new RegExp(EN['crash.abandoned'].split('{when}')[1].trim()));

describe('the offer to restore', () => {
  it('appears once the other tabs have had their chance to answer', () => {
    leaveOneBehind();
    stops.push(installAutosave());

    render(<CrashRecovery />);
    // Nothing yet: the ping is still out, and claiming a session is dead before
    // it has been asked is how a second tab's live project gets offered away.
    expect(banner()).toBeNull();

    act(() => vi.advanceTimersByTime(PROBE_MS));

    expect(banner()).not.toBeNull();
    expect(screen.getByText(EN['crash.restore'])).toBeTruthy();
  });

  it('does not come back after it has been answered', () => {
    leaveOneBehind();
    stops.push(installAutosave());
    render(<CrashRecovery />);
    act(() => vi.advanceTimersByTime(PROBE_MS));

    fireEvent.click(screen.getByText(EN['crash.discard']));

    expect(banner()).toBeNull();
    // answered means answered: the copy is not put to the next tab either
    expect(localStorage.getItem(projectKey('crashed'))).toBeNull();
    act(() => vi.advanceTimersByTime(PROBE_MS * 10));
    expect(banner()).toBeNull();
  });

  it('says nothing when the last session left nothing behind', () => {
    stops.push(installAutosave());
    render(<CrashRecovery />);
    act(() => vi.advanceTimersByTime(PROBE_MS));
    expect(banner()).toBeNull();
  });
});
