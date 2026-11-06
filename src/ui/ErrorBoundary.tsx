/**
 * Last line of defence for the web build.
 *
 * A thrown error during render unmounts the whole React tree. What the user
 * sees is a blank window, and what they lose is the project they had open,
 * because nothing in this app was ever written to disk. That is the difference
 * between "a panel misbehaved" and "the afternoon is gone", and it is the
 * reason this exists.
 *
 * Three things happen the moment something throws, in this order, each guarded
 * separately so a failure in one still lets the next run:
 *
 *   1. the project is serialised into localStorage, before anything is drawn;
 *   2. the same copy is offered as a download, because localStorage is not
 *      somewhere a person can find a file;
 *   3. the error itself is shown, verbatim, rather than a soothing sentence.
 *
 * The recovery screen deliberately does not use the app's own widgets, i18n
 * hooks or store selectors. Whatever broke may be one of those.
 */
import { Component, type ReactNode } from 'react';
import { useStore } from '../state/store';

export const CRASH_KEY = 'btr.crash.project';
export const CRASH_AT_KEY = 'btr.crash.at';

interface State {
  error: Error | null;
  saved: 'yes' | 'no' | 'empty';
}

const TEXT = {
  en: {
    title: 'The prediction view stopped',
    lead: 'Your project was saved in this browser before this screen appeared.',
    none: 'There was no project open, so nothing needed saving.',
    failed: 'The project could NOT be saved. Copy the error below before reloading.',
    download: 'Download project',
    reload: 'Reload',
    detail: 'What went wrong',
  },
  pl: {
    title: 'Widok predykcji przerwał pracę',
    lead: 'Projekt został zapisany w tej przeglądarce, zanim pojawił się ten ekran.',
    none: 'Żaden projekt nie był otwarty, więc nie było czego zapisywać.',
    failed: 'Projektu NIE udało się zapisać. Skopiuj błąd poniżej, zanim przeładujesz.',
    download: 'Pobierz projekt',
    reload: 'Przeładuj',
    detail: 'Co się stało',
  },
  it: {
    title: 'La vista di predizione si è interrotta',
    lead: 'Il progetto è stato salvato in questo browser prima di questa schermata.',
    none: 'Nessun progetto era aperto, quindi non c’era nulla da salvare.',
    failed: 'Il progetto NON è stato salvato. Copia l’errore qui sotto prima di ricaricare.',
    download: 'Scarica il progetto',
    reload: 'Ricarica',
    detail: 'Che cosa è successo',
  },
} as const;

function language(): keyof typeof TEXT {
  try {
    const l = useStore.getState().lang;
    return l === 'pl' || l === 'it' ? l : 'en';
  } catch {
    return 'en';
  }
}

/** Serialise whatever the store still holds. Returns null if there is nothing. */
function snapshot(): string | null {
  const project = useStore.getState().toProject();
  if (!project.sources.length && !project.measurementPoints.length) return null;
  return JSON.stringify(project, null, 2);
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, saved: 'no' };
  private text: string | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Rescue the work first. Everything else on this screen is cosmetic by
    // comparison, and a second failure here must not replace the first.
    let saved: State['saved'] = 'no';
    try {
      const text = snapshot();
      if (text === null) {
        saved = 'empty';
      } else {
        this.text = text;
        localStorage.setItem(CRASH_KEY, text);
        localStorage.setItem(CRASH_AT_KEY, new Date().toISOString());
        saved = 'yes';
      }
    } catch {
      saved = 'no';
    }
    this.setState({ saved });

    // Keep the original in the console with its stack, for a bug report.
    try {
      console.error('[BTR] render failed', error);
    } catch {
      // a console that throws is not a reason to lose the recovery screen
    }
  }

  private download = () => {
    try {
      const text = this.text ?? localStorage.getItem(CRASH_KEY);
      if (!text) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `btr-recovered-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.btrsub`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // nothing useful to do; the copy in localStorage is still there
    }
  };

  render() {
    const { error, saved } = this.state;
    if (!error) return this.props.children;
    const t = TEXT[language()];

    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={saved === 'no' ? S.bad : S.lead}>
            {saved === 'yes' ? t.lead : saved === 'empty' ? t.none : t.failed}
          </p>
          <div style={S.row}>
            {saved === 'yes' && (
              <button style={S.primary} onClick={this.download}>
                {t.download}
              </button>
            )}
            <button style={S.btn} onClick={() => window.location.reload()}>
              {t.reload}
            </button>
          </div>
          <p style={S.label}>{t.detail}</p>
          <pre style={S.pre}>{String(error?.stack || error?.message || error)}</pre>
        </div>
      </div>
    );
  }
}

const S: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#1c1e22',
    color: '#e6e8ec',
    font: '13px/1.6 ui-sans-serif, system-ui, sans-serif',
    padding: 20,
    overflow: 'auto',
  },
  card: { maxWidth: 720, width: '100%' },
  h1: { fontSize: 17, margin: '0 0 8px' },
  lead: { margin: '0 0 14px', color: '#c9ced6' },
  bad: { margin: '0 0 14px', color: '#ffb3b8', fontWeight: 700 },
  row: { display: 'flex', gap: 8, marginBottom: 18 },
  btn: {
    background: '#2d3137',
    color: '#e6e8ec',
    border: '1px solid #3a3f47',
    borderRadius: 2,
    padding: '6px 14px',
    cursor: 'pointer',
    font: 'inherit',
  },
  primary: {
    background: 'oklch(0.72 0.12 200)',
    // Prawie czarny, nie biały: akcent jest teraz jasnym cyjanem, więc biały
    // tekst na nim przestaje być czytelny. To ta sama zamiana, którą arkusz
    // robi tokenem --fg-on-accent; tutaj musi być wpisana wprost, bo ekran
    // awarii ma działać także wtedy, gdy arkusz się nie wczytał.
    color: '#08181c',
    border: '1px solid transparent',
    borderRadius: 2,
    padding: '6px 14px',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 600,
  },
  label: {
    margin: '0 0 5px',
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    color: '#9aa1ab',
  },
  pre: {
    margin: 0,
    padding: 10,
    background: '#15171a',
    border: '1px solid #3a3f47',
    borderRadius: 2,
    fontSize: 11,
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: '40vh',
    overflow: 'auto',
    color: '#f1cf72',
  },
};
