import { useEffect, useRef, useState } from 'react';
import { claimModal, FOCUSABLE } from './modals';
import { QUALITY_KEY } from '../i18n';
import { useT } from '../i18n/useT';
import { Icon } from './icons';

/**
 * Numeric field that lets you type freely (including "-", "1.", empty) and only
 * pushes a value up when it parses. Keeps external updates in sync.
 *
 * `mixed` is for a multi-selection whose members disagree. The field then reads
 * blank with a dash behind it rather than showing a number: eight cabinets fanned
 * at different azimuths used to report "0" and there is no reading of that which
 * is not a lie. Typing still writes, to all of them, which is the same contract
 * the speaker picker's "mixed" option has.
 */
/**
 * A number you type.
 *
 * WHEN IT COMMITS, which is the whole design
 *
 * On Enter and on leaving the field - not on every keystroke. The keystroke
 * version looked responsive and was three separate edits: typing 180 into an
 * azimuth wrote 1, then 18, then 180, so the model recomputed three times and
 * Cmd-Z walked back through 18 and 1 before it reached where you started. With
 * a `min` it was worse than noisy. A field with min 1 could not be given 0.5,
 * because the 0 arrived first and was clamped to 1 under the cursor.
 *
 * Escape abandons the edit and puts the old number back, which is the half of
 * the contract that makes committing late safe: there is now a way out of a
 * half-typed field that does not involve retyping what was there.
 *
 * The arrow keys still step, because that is the one thing a keystroke commit
 * got right and `type="number"` gave for free - with Shift for ten steps,
 * which it did not.
 *
 * WHY IT IS NOT `type="number"` ANY MORE
 *
 * Because a number input has no text, only a number, and committing late
 * needs the text. Anything it cannot parse YET reads back as the empty
 * string - "1." and "-" on the way to "1.5" and "-6" both do - so the field
 * could not hold a half-typed number long enough to wait for Enter.
 *
 * The decimal separator rides along with that. Measured in this program's own
 * Chromium at pl locale: a comma TYPED by hand is accepted and normalised, so
 * 1,5 works, but the same string assigned to the value reads back empty, and
 * the separator a number input accepts is the one the machine's locale says.
 * A build carried to an en-locale machine would therefore eat the comma. We
 * parse the text ourselves and both separators work everywhere.
 *
 * `inputMode="decimal"` keeps the numeric keypad on a touch device, and the
 * stepping moves to the key handler below, which had to exist for Shift
 * anyway.
 */
export function NumField({
  value,
  onChange,
  step = 0.1,
  min,
  max,
  unit,
  disabled,
  mixed,
  width,
  label,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  disabled?: boolean;
  mixed?: boolean;
  width?: number;
  /** The field's name for assistive technology, when no <label> wraps it. */
  label?: string;
}) {
  const shown = (v: number) => (mixed ? '' : String(round(v)));
  const [text, setText] = useState(shown(value));
  const focused = useRef(false);
  const abandoned = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(mixed ? '' : String(round(value)));
  }, [value, mixed]);

  const clamp = (v: number) => {
    let out = v;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    return out;
  };

  /** The number this text means, clamped, or null if it means none. */
  const parse = (raw: string): number | null => {
    const v = parseFloat(raw.trim().replace(',', '.'));
    return isFinite(v) ? clamp(v) : null;
  };

  const write = (v: number) => {
    onChange(v);
    // The CLAMPED number, so a field with a limit shows what it took rather
    // than what was asked for.
    setText(String(round(v)));
  };

  const commit = (raw: string) => {
    const v = parse(raw);
    if (v === null) {
      // Nonsense, or nothing: put back what was there. Leaving the text as
      // typed would show a number the model does not have.
      setText(shown(value));
      return;
    }
    // Writing the number the field already showed is not an edit, and every
    // one of those is an undo step that does nothing when you take it. Leaving
    // a field untouched must cost nothing. A MIXED field is the exception:
    // there the showing is blank and committing a number is the whole point.
    if (!mixed && v === parse(shown(value))) {
      setText(shown(value));
      return;
    }
    write(v);
  };

  const nudge = (dir: number, big: boolean) => {
    const base = parse(text);
    // From what is typed if it is a number, otherwise from the value the field
    // stands for - so an arrow on a half-typed or mixed field still does
    // something sensible rather than nothing.
    write(clamp((base ?? (mixed ? 0 : value)) + dir * step * (big ? 10 : 1)));
  };

  return (
    <span className="numfield" style={width ? { width } : undefined}>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        placeholder={mixed ? '-' : undefined}
        value={text}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          if (abandoned.current) {
            abandoned.current = false;
            setText(shown(value));
            return;
          }
          commit(text);
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit(e.currentTarget.value);
          } else if (e.key === 'Escape') {
            abandoned.current = true;
            setText(shown(value));
            e.currentTarget.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
          }
        }}
      />
      {unit && <em>{unit}</em>}
    </span>
  );
}

function round(v: number) {
  return Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e4) / 1e4;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="field" title={hint}>
      <span className="field-label">{label}</span>
      <span className="field-body">{children}</span>
    </label>
  );
}

export function Section({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <section className="section">
      <header className="section-head">
        <h3>{title}</h3>
        {right}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const release = claimModal();
    const restore = document.activeElement as HTMLElement | null;
    // Focus has to be INSIDE the dialog: it is what makes the trap below have
    // something to cycle, and what keeps a stray keystroke away from the
    // canvas. An `autoFocus` in the children has already been applied by the
    // time effects run, so only take over when nothing claimed focus.
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      (panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
    }
    return () => {
      release();
      // Hand focus back to whatever opened the dialog rather than dropping a
      // keyboard user at the top of the document.
      if (restore && document.contains(restore)) restore.focus();
    };
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement as HTMLElement | null;
      // With two dialogs stacked, only the one holding focus responds. Both
      // listeners are on `window`, so otherwise the lower one would close
      // itself on Escape and yank focus out of the upper one on Tab.
      const owner = active?.closest('.modal');
      if (owner && owner !== panel) return;

      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }

      const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!stops.length) {
        e.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const inside = !!active && panel.contains(active);
      // Only the ends are handled; in between, the browser's own order is
      // better than anything reimplemented here.
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className={`modal${wide ? ' modal-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('ui.close')}>
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** One choice out of a few, all in view: a row of buttons instead of a drop-down list. */
export function SegButtons<V extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: Array<{ value: V; label: string; title?: string }>;
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg seg-fill" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={o.value === value ? 'on' : ''}
          aria-pressed={o.value === value}
          title={o.title}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function QualityBadge({ q }: { q: 'A' | 'B' | 'C' | 'D' }) {
  const t = useT();
  // The letter is the same in every language; only what it stands for is not.
  return (
    <span className={`qbadge q-${q}`} title={`${q}: ${t(QUALITY_KEY[q])}`}>
      {q}
    </span>
  );
}
