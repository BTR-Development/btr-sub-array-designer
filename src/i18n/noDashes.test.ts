/**
 * No text the program can show contains an en or em dash. Checked on the parsed
 * source, so every string literal, template and JSX text in production code is
 * covered, wherever it ends up, and comments are left out of it.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const DASH = /[–—]/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('the interface text', () => {
  it('has no en or em dash in any string of the program', () => {
    const found: string[] = [];
    for (const file of sourceFiles('src')) {
      const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
      const visit = (node: ts.Node) => {
        const isText =
          ts.isStringLiteralLike(node) ||
          ts.isJsxText(node) ||
          ts.isTemplateHead(node) ||
          ts.isTemplateMiddle(node) ||
          ts.isTemplateTail(node);
        if (isText && DASH.test(node.text)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          found.push(`${file}:${line} ${node.text.trim().slice(0, 60)}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    expect(found).toEqual([]);
  });
});
