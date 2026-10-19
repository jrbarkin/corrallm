import ts from 'typescript';

import type { Surface } from '../shared/api/surface';
import { guiFunction } from '../shared/gui-link';

/** T6 scans calls, not comments, strings or the generated bridge's list of operation names. */
export function missingGestures(
  ops: readonly string[],
  surface: Readonly<Record<string, Surface>>,
  sources: readonly string[],
  reasons: Readonly<Partial<Record<string, string>>>,
): string[] {
  const called = new Set<string>();
  for (const source of sources) {
    const file = ts.createSourceFile(
      'renderer.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (ts.isPropertyAccessExpression(expression)) called.add(expression.name.text);
        else if (
          ts.isElementAccessExpression(expression) &&
          ts.isStringLiteral(expression.argumentExpression)
        )
          called.add(expression.argumentExpression.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return ops.filter(
    (op) => !surface[op]?.reads && !called.has(guiFunction(op)) && !reasons[op]?.trim(),
  );
}
