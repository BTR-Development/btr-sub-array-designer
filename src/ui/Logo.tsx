import logoUrl from '../assets/btr-solutions.png';
import { BRANDING } from '../branding';

/**
 * The house mark, kept in its own module so nothing outside the UI ever pulls a
 * binary asset in (the io and engine tests import branding freely).
 *
 * The artwork is the white-on-transparent lockup, which is what the dark chrome
 * wants; swapping the file swaps the brand everywhere it appears.
 */
export function Logo({ className = 'brand-logo' }: { className?: string }) {
  return <img className={className} src={logoUrl} alt={BRANDING.companyName} draggable={false} />;
}
