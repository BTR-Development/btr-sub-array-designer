import { BRANDING } from '../branding';
import { useT } from '../i18n/useT';

/** Where feature requests and questions go. The address stays selectable as text. */
export function ContactLine() {
  const t = useT();
  return (
    <>
      <p>{t('help.contactLead')}</p>
      <p className="contact-line">
        {BRANDING.author}
        <br />
        <a href={`mailto:${BRANDING.contactEmail}`} target="_blank" rel="noreferrer">
          {BRANDING.contactEmail}
        </a>
      </p>
    </>
  );
}
