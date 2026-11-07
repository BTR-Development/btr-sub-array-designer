/**
 * The rules of the design system that a stylesheet can break without anyone
 * noticing: one vocabulary of tokens, five type sizes, colour only through
 * tokens, no decoration the system does not have. The printed sheet is paper
 * with its own inks and sizes, so it is left out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const raw = readFileSync('src/index.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rootEnd = raw.indexOf('}') + 1;
const root = raw.slice(0, rootEnd);
const paperStart = raw.indexOf('.sheet {');
const paperEnd = raw.indexOf('.print-sheet-root');
const rules = (raw.slice(rootEnd, paperStart) + raw.slice(paperEnd)).replace(/@media print \{[\s\S]*?\n\}/, '');

describe('the stylesheet', () => {
  it('uses only tokens that are defined', () => {
    const defined = new Set([...raw.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    // set per column at the breakpoints, with a fallback where they are read
    const used = [...rules.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(used.filter((v) => !defined.has(v))).toEqual([]);
  });

  it('sets type sizes through the scale, and nothing under 10 px', () => {
    const sizes = [...rules.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1].trim());
    expect(sizes.filter((v) => !v.startsWith('var(--fs-') && v !== '0')).toEqual([]);
    const px = [...root.matchAll(/--fs-[\w-]+:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.min(...px)).toBeGreaterThanOrEqual(10);
  });

  it('keeps to two font weights', () => {
    const weights = new Set([...rules.matchAll(/font-weight:\s*(\d+)/g)].map((m) => m[1]));
    expect([...weights].sort()).toEqual(['400', '600']);
  });

  it('takes colour from tokens, without gradients or shouted labels', () => {
    expect(rules.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();
    expect(rules).not.toMatch(/gradient\(/);
    // a capital at the start of a sentence is grammar, not a shout
    expect(rules.replace(/[^{}]*::first-letter[^{}]*\{[^}]*\}/g, '')).not.toMatch(/text-transform:\s*uppercase/);
    expect(rules).not.toMatch(/text-shadow/);
  });

  it('keeps the dark scheme off the paper', () => {
    expect(raw).toMatch(/@media print \{[\s\S]*color-scheme: only light/);
  });

  it('keeps one solid use of the accent: a state is a tint', () => {
    const on = rules.match(/button\.on \{[^}]*\}/)![0];
    expect(on).toContain('var(--accent-on)');
    const primary = rules.match(/button\.primary \{[^}]*\}/)![0];
    expect(primary).toContain('color: var(--fg-on-accent)');
  });
});
