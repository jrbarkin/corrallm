/*
 * The README's demo: a made-up storefront, acme-web, and a canvas of a lead and three workers on
 * both CLIs, their queues handing work along. The agents' turns are e2e/media/script.json's.
 */

/** The project the agents work in: a small Git repository, as a user's would be. */
export const PROJECT_FILES: Record<string, string> = {
  'README.md': '# acme-web\n\nThe Acme storefront: product pages, cart and checkout.\n',
  'package.json': `${JSON.stringify(
    {
      name: 'acme-web',
      private: true,
      type: 'module',
      scripts: { dev: 'vite', test: 'vitest' },
    },
    null,
    2,
  )}\n`,
  'docs/issues/142-cart-drawer.md':
    '# Cart drawer\n\nOpen the cart from the header in a drawer, with quantities and a subtotal.\n',
  'src/server/pricing.ts': [
    "import type { CartLine, Totals } from './types';",
    '',
    'export function priceLines(lines: CartLine[], { taxRate = 0.0825 } = {}): Totals {',
    '  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0);',
    '  const tax = Math.round(subtotal * taxRate);',
    '  return { subtotal, tax, total: subtotal + tax };',
    '}',
    '',
  ].join('\n'),
  'src/server/routes/products.ts': [
    "import { Router } from 'express';",
    '',
    'export const products = Router();',
    '',
  ].join('\n'),
  'src/server/routes/index.ts': [
    "import { products } from './products';",
    '',
    'export const routes = [products];',
    '',
  ].join('\n'),
  'src/components/Header.tsx': [
    'export function Header({ count }: { count: number }) {',
    '  return (',
    '    <header className="site-header">',
    '      <CartButton count={count} />',
    '    </header>',
    '  );',
    '}',
    '',
  ].join('\n'),
};

/** What the API agent's branch holds by the time its changes are reviewed: committed, then not. */
export const API_COMMIT: Record<string, string> = {
  'src/server/routes/cart.ts': [
    "import { Router } from 'express';",
    "import { priceLines } from '../pricing';",
    '',
    'export const cart = Router();',
    '',
    "cart.get('/api/cart', (req, res) => {",
    '  const lines = req.session.cart ?? [];',
    '  res.json({ lines, ...priceLines(lines) });',
    '});',
    '',
  ].join('\n'),
  'src/server/routes/index.ts': [
    "import { products } from './products';",
    "import { cart } from './cart';",
    '',
    'export const routes = [products, cart];',
    '',
  ].join('\n'),
};
export const API_UNCOMMITTED: Record<string, string> = {
  'src/server/coupons.ts': [
    "import { COUPONS } from './data/coupons';",
    '',
    'export function applyCoupon(code: string, now = new Date()) {',
    '  const coupon = COUPONS.find((c) => c.code === code.trim().toUpperCase());',
    "  if (!coupon) return { error: 'unknown' } as const;",
    "  if (new Date(coupon.expires) < now) return { error: 'expired' } as const;",
    '  return { percent: coupon.percent } as const;',
    '}',
    '',
  ].join('\n'),
};

const message = (id: string, text: string) => ({ id, message: text });
const wait = (id: string, ...on: [agent: string, item: string][]) => ({
  id,
  waitFor: on.map(([agent, item]) => ({ agent, item })),
});

/** The demo canvas, as its `.corral` file. */
export function demoCanvas(id: string): string {
  const agent = (
    node: string,
    label: string,
    adapter: 'claude-code' | 'codex',
    position: { x: number; y: number },
    queue: object[],
  ) => ({
    id: node,
    kind: 'agent',
    label,
    position,
    adapter,
    // Their transcripts, not terminals: the structured connection of each.
    connection: adapter === 'codex' ? 'codex.app-server' : 'claude-code.sdk',
    queue,
  });
  return `${JSON.stringify(
    {
      format: 'corrallm',
      version: 2,
      id,
      // Ungrouped, so each works in a worktree of its own. Work flows up: the API's endpoint to the
      // drawer and the tests, both of those to the lead.
      nodes: [
        agent('lead', 'Lead', 'claude-code', { x: 0, y: 0 }, [
          message('plan', 'Read issue #142 (cart drawer) and write the team’s plan in PLAN.md.'),
          wait('team', ['ui', 'wire'], ['tests', 'run']),
          message('review', 'Review the three branches against PLAN.md and list anything missing.'),
        ]),
        agent('ui', 'Cart UI', 'claude-code', { x: -150, y: 140 }, [
          message('drawer', 'Build the cart drawer: line items, quantity steppers, subtotal.'),
          wait('api-ready', ['api', 'endpoint']),
          message('wire', 'Load the drawer from GET /api/cart, with a skeleton while it loads.'),
        ]),
        agent('tests', 'Tests', 'codex', { x: 150, y: 140 }, [
          message(
            'unit',
            'Write unit tests for cart totals: discounts, tax rounding, empty carts.',
          ),
          wait('coupons-ready', ['api', 'coupons']),
          message('run', 'Run the cart tests against the new endpoint and fix what fails.'),
        ]),
        agent('api', 'API', 'codex', { x: 0, y: 280 }, [
          message('endpoint', 'Add GET /api/cart with line items, subtotal, tax and total.'),
          message('coupons', 'Validate coupon codes on the server; reject expired ones.'),
        ]),
      ],
      links: [],
    },
    null,
    2,
  )}\n`;
}
