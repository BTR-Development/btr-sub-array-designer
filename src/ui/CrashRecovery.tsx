/**
 * Offers back the project rescued by the error boundary.
 *
 * A copy in localStorage that nothing ever mentions is not a rescue: the user
 * reloads, sees an empty canvas and concludes the work is gone. This is the
 * other half of the boundary, and it is deliberately an offer rather than an
 * automatic restore — coming back to a project you did not ask for, on top of
 * one you may have started since, would be its own kind of data loss.
 *
 * Reading the copy is guarded end to end. A snapshot written while the app was
 * failing can be truncated or half-valid, and a recovery banner that itself
 * throws would take down the very screen it exists to protect.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { parseBTRProject } from '../io/btrJson';
import { requestFit } from '../render/view';
import { CRASH_AT_KEY, CRASH_KEY } from './ErrorBoundary';
import { abandonedFromLastSession, clearAbandoned, onAbandonedSettled } from '../state/autosave';
import { useT } from '../i18n/useT';

type Found = { text: string; at: string; kind: 'crash' | 'abandoned' };

/**
 * A rescue from a render failure outranks an abandoned session: it is newer by
 * definition, and it names a specific thing that went wrong rather than an
 * ending nobody can account for.
 */
function read(): Found | null {
  try {
    const text = localStorage.getItem(CRASH_KEY);
    if (text) return { text, at: localStorage.getItem(CRASH_AT_KEY) ?? '', kind: 'crash' };
  } catch {
    // fall through to the autosave
  }
  const abandoned = abandonedFromLastSession();
  return abandoned ? { ...abandoned, kind: 'abandoned' } : null;
}

function clear() {
  try {
    localStorage.removeItem(CRASH_KEY);
    localStorage.removeItem(CRASH_AT_KEY);
  } catch {
    // a browser refusing to write is not going to be argued with
  }
  // The autosaved copy itself stays: it is what makes the next bad ending
  // recoverable. Only the marker saying "this session never closed" is dropped.
  clearAbandoned();
}

export function CrashRecovery() {
  const t = useT();
  const s = useStore();
  // Read once, on first render: the banner must not reappear mid-session.
  const [found, setFound] = useState(read);
  const [failed, setFailed] = useState(false);
  /** the offer has been put to the user and dealt with; never ask again */
  const done = useRef(false);

  /**
   * Whether the last session actually died is now settled by asking the other
   * tabs, which takes a round trip, so the answer can arrive just after this
   * first render rather than before it. It is still asked once: the callback
   * fires a single time, and nothing puts the banner back after the user has
   * answered it.
   */
  useEffect(() => {
    if (found || done.current) return;
    return onAbandonedSettled((r) => {
      if (!done.current && r) setFound({ ...r, kind: 'abandoned' });
    });
  }, [found]);

  if (!found) return null;

  const when = found.at ? new Date(found.at).toLocaleString() : '';

  const restore = () => {
    try {
      const p = parseBTRProject(found.text);
      s.loadDoc(
        {
          project: p.project,
          sources: p.sources,
          groups: p.groups,
          measurementPoints: p.measurementPoints,
          customSpeakers: p.customSpeakers,
        },
        p.simulationSettings,
      );
      requestFit();
      done.current = true;
      clear();
      setFound(null);
    } catch {
      setFailed(true);
    }
  };

  const discard = () => {
    done.current = true;
    clear();
    setFound(null);
  };

  return (
    <div className="crash-banner">
      <span>
        {failed
          ? t('crash.unreadable')
          : found.kind === 'crash'
            ? t('crash.found', { when })
            : t('crash.abandoned', { when })}
      </span>
      <span className="spacer" />
      {!failed && <button onClick={restore}>{t('crash.restore')}</button>}
      <button onClick={discard}>{t('crash.discard')}</button>
    </div>
  );
}
