import crossCheck from './examples/cross-check.corral?raw';
import fanOut from './examples/fan-out.corral?raw';
import headToHead from './examples/head-to-head.corral?raw';
import featureCrew from './examples/feature-crew.corral?raw';
import releaseChecks from './examples/release-checks.corral?raw';
import reviewLoop from './examples/review-loop.corral?raw';
import reviewPanel from './examples/review-panel.corral?raw';
import specFirst from './examples/spec-first.corral?raw';
import tddRelay from './examples/tdd-relay.corral?raw';
import teamLead from './examples/team-lead.corral?raw';
import type { TemplateField } from './templates';

/**
 * A canvas to start from, in the Templates gallery: a `.corral` file's text. Its `fields` are the
 * blanks (`{{key}}`) in its agents' names, messages and conditions, filled in before it opens
 * (templates.ts); without any, it opens as it is.
 */
export interface Example {
  name: string;
  description: string;
  text: string;
  fields?: readonly TemplateField[];
}

export const EXAMPLES: readonly Example[] = [
  {
    name: 'TDD relay',
    description:
      'Codex writes the tests, Claude makes them pass, Codex refactors, with the tests run at every hand-off. After claudex.',
    text: tddRelay,
    fields: [
      {
        key: 'feature',
        label: 'What should they build?',
        example:
          'A calculate_discount(price, percent) function in src/pricing.py that rejects percentages outside 0 to 100.',
      },
      { key: 'framework', label: 'Which test framework?', example: 'pytest' },
    ],
  },
  {
    name: 'Head to head',
    description:
      'Claude and Codex build the same thing in their own worktrees; a judge scores them blind, gives each feedback, and merges the winner. After claudex-compete.',
    text: headToHead,
    fields: [
      {
        key: 'task',
        label: 'What should they build?',
        example:
          'A settings page with a profile form, a light and dark theme switch, and a danger zone for deleting the account.',
      },
    ],
  },
  {
    name: 'Spec first',
    description:
      'A planner writes the spec before any code, and the plan once you approve the spec; a builder works the plan test-first; a reviewer checks the result against the spec. Any agents: pick one for each role, or leave it to the default.',
    text: specFirst,
    fields: [
      {
        key: 'feature',
        label: 'What should be built?',
        example: 'Let people export their invoices as CSV from the billing page.',
      },
    ],
  },
  {
    name: 'Review panel',
    description:
      'One agent builds; three review the change at once, for bugs, security and tests; a lead decides what must be fixed first.',
    text: reviewPanel,
    fields: [
      {
        key: 'feature',
        label: 'What should be built?',
        example: 'Password reset by email, with a link that expires after an hour.',
      },
    ],
  },
  {
    name: 'Feature crew',
    description:
      'Research feeds the build and its docs; review waits for the build, and the docs for the review.',
    text: featureCrew,
  },
  {
    name: 'Independent cross-check',
    description:
      "A builder takes the task while a checker researches it on its own, then checks the builder's work.",
    text: crossCheck,
  },
  {
    name: 'Review loop',
    description:
      'A coder hands its change to a reviewer, who sends it back when the review asks for changes.',
    text: reviewLoop,
  },
  {
    name: 'Team lead',
    description:
      'Once you approve the plan, the planner briefs the head of a team, who shares the work out.',
    text: teamLead,
  },
  {
    name: 'Fan-out research',
    description: 'One agent asks a group of researchers a question each; they report to a writer.',
    text: fanOut,
  },
  {
    name: 'Release checks',
    description:
      'Run the tests, then call in a fixer if they fail, or review and tag the release if they pass.',
    text: releaseChecks,
  },
];
