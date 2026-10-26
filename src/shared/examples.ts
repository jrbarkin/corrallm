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
import type { Example } from './templates';
import { canvasIdOf } from './canvas';
export type { Example } from './templates';

/**
 * A canvas to start from, in the Templates gallery: a `.corral` file's text. Its `fields` are the
 * blanks (`{{key}}`) in its agents' names, messages and conditions, filled in before it opens
 * (templates.ts); without any, it opens as it is.
 */
export const EXAMPLES: readonly Example[] = [
  {
    name: 'TDD relay',
    description:
      'Codex writes the tests and checks they fail first; Claude works and runs them until they pass, asking you after three rounds; Codex refactors, with the tests run at every hand-off. All three roles share one relay worktree. After claudex.',
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
      'Claude and Codex commit competing versions in separate managed worktrees; a judge reads their generated refs, commits feedback in its own tree, and reports the winner for review. Two rounds at most, ending early on a clear winner. Requires core workspace context; never merges automatically. After claudex-compete.',
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
      "A planner writes the spec before any code, and the plan once you approve the spec; a builder writes the plan's tests, checks they fail, then makes them pass; a reviewer checks the result against the spec. All three share a Spec and implementation worktree. Any agents: pick one for each role, or leave it to the default.",
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
      'One agent builds; three review the change at once, for bugs, security and tests; a lead decides what must be fixed first. They share one worktree and distinct .review files.',
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
      'Research feeds the build and its docs; review waits for the build, and the docs for the review, all in one shared worktree.',
    text: featureCrew,
  },
  {
    name: 'Independent cross-check',
    description:
      "A builder takes the task while a checker researches it on its own, then checks the builder's work. Separate conversations inspect the same worktree.",
    text: crossCheck,
  },
  {
    name: 'Review loop',
    description:
      'A coder implements the issue and a reviewer reviews it, round after round, until the reviewer approves; after three rounds, it asks you. Both roles share the uncommitted changes in one worktree.',
    text: reviewLoop,
  },
  {
    name: 'Team lead',
    description:
      'Once you approve the plan, the planner briefs the head of a team, who shares the work out. Planner and the existing Lead team share one worktree without changing who leads.',
    text: teamLead,
  },
  {
    name: 'Fan-out research',
    description:
      'Lead asks three researchers distinct questions; their separate NOTES files and Writer’s report share one Research and report worktree.',
    text: fanOut,
  },
  {
    name: 'Release checks',
    description:
      'Run the tests, then call in a fixer if they fail, or review and tag the release if they pass. Releaser and Fixer share the same worktree, so checks see the fixes.',
    text: releaseChecks,
  },
];

/** The shipped file to open or insert after the gallery chose its metadata by id. */
export function exampleOf(id: string): Example | undefined {
  return EXAMPLES.find((example) => canvasIdOf(example.text) === id);
}
