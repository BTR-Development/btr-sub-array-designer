/**
 * Whether this installation has been through the guided tour. Written when the
 * tour is finished or skipped, not when it is shown, so a run that never reached
 * a person (the build self-test, a crash) does not use up the first run.
 */
const KEY = 'btr.tutorialSeen';

export function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return true; // storage unavailable: better no tour than the tour on every start
  }
}

export function markTutorialSeen() {
  try {
    localStorage.setItem(KEY, new Date().toISOString());
  } catch {
    // nothing to do: see tutorialSeen
  }
}
