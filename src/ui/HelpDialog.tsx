/**
 * Help: how to work in the program, what its terms mean, the keyboard, and how
 * to reach the author. Opens from the top bar and with F1.
 */
import { useStore } from '../state/store';
import { QUALITY_KEY, type MessageKey } from '../i18n';
import { useT } from '../i18n/useT';
import { Modal, QualityBadge } from './widgets';
import { ContactLine } from './ContactLine';
import { TOUR_STEPS, tourBody, tourTitle } from './tourSteps';

const CONCEPTS: Array<{ title: MessageKey; body: MessageKey }> = [
  { title: 'help.concept.levels', body: 'help.concept.levelsBody' },
  { title: 'help.concept.spacing', body: 'help.concept.spacingBody' },
  { title: 'help.concept.cardioid', body: 'help.concept.cardioidBody' },
  { title: 'help.concept.delay', body: 'help.concept.delayBody' },
];

const SHORTCUTS: Array<{ keys: string; what: MessageKey }> = [
  { keys: 'F1', what: 'help.key.help' },
  { keys: 'Cmd/Ctrl+S', what: 'help.key.save' },
  { keys: 'Cmd/Ctrl+Shift+S', what: 'help.key.saveAs' },
  { keys: 'Cmd/Ctrl+O', what: 'help.key.open' },
  { keys: 'Cmd/Ctrl+Z', what: 'help.key.undo' },
  { keys: 'Cmd/Ctrl+Shift+Z', what: 'help.key.redo' },
  { keys: 'Cmd/Ctrl+C, Cmd/Ctrl+V', what: 'help.key.copy' },
  { keys: 'Cmd/Ctrl+D', what: 'help.key.duplicate' },
  { keys: 'Cmd/Ctrl+A', what: 'help.key.selectAll' },
  { keys: 'Cmd/Ctrl+G', what: 'help.key.group' },
  { keys: 'Cmd/Ctrl+Shift+G', what: 'help.key.ungroup' },
  { keys: 'Cmd/Ctrl+Enter', what: 'help.key.recalc' },
  { keys: '[  ]', what: 'help.key.rotate' },
  { keys: 'Delete', what: 'help.key.delete' },
  { keys: 'F', what: 'help.key.fit' },
  { keys: 'Esc', what: 'help.key.deselect' },
];

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const setTutorialOpen = useStore((s) => s.setTutorialOpen);

  return (
    <Modal title={t('help.title')} onClose={onClose} wide>
      <div className="help">
        <p>{t('help.intro')}</p>
        <button
          className="primary help-replay"
          onClick={() => {
            onClose();
            setTutorialOpen(true);
          }}
        >
          {t('help.replay')}
        </button>

        <h3>{t('help.work')}</h3>
        {TOUR_STEPS.filter((s) => s.topic).map((step) => (
          <details key={step.id}>
            <summary>{tourTitle(step, t)}</summary>
            {tourBody(step, t).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </details>
        ))}

        <h3>{t('help.concepts')}</h3>
        {CONCEPTS.map((c) => (
          <details key={c.title}>
            <summary>{t(c.title)}</summary>
            <p>{t(c.body)}</p>
          </details>
        ))}
        <details>
          <summary>{t('help.concept.grades')}</summary>
          <p>{t('help.concept.gradesBody')}</p>
          <ul className="help-grades">
            {(['A', 'B', 'C', 'D'] as const).map((q) => (
              <li key={q}>
                <QualityBadge q={q} /> {t(QUALITY_KEY[q])}
              </li>
            ))}
          </ul>
        </details>

        <h3>{t('help.shortcuts')}</h3>
        <table className="help-keys">
          <tbody>
            {SHORTCUTS.map((k) => (
              <tr key={k.keys}>
                <td className="mono">{k.keys}</td>
                <td>{t(k.what)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3>{t('help.contact')}</h3>
        <ContactLine />
      </div>
    </Modal>
  );
}
