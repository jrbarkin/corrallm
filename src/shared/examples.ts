import crossCheck from './examples/cross-check.template.json?raw';
import fanOut from './examples/fan-out.template.json?raw';
import headToHead from './examples/head-to-head.template.json?raw';
import featureCrew from './examples/feature-crew.template.json?raw';
import releaseChecks from './examples/release-checks.template.json?raw';
import reviewLoop from './examples/review-loop.template.json?raw';
import reviewPanel from './examples/review-panel.template.json?raw';
import specFirst from './examples/spec-first.template.json?raw';
import tddRelay from './examples/tdd-relay.template.json?raw';
import teamLead from './examples/team-lead.template.json?raw';
import type { Example } from './templates';
import { readTemplate } from './model/template-file';
export type { Example } from './templates';

/**
 * A shipped definition in the Templates gallery. Its `fields` name blanks (`{{key}}`) in its
 * roles, messages and conditions, filled after the core compiles every chosen endpoint's jobs.
 */
export const EXAMPLES: readonly Example[] = [
  {
    name: 'TDD relay',
    description:
      'A tester writes the tests and checks they fail first; an implementer works and runs them until they pass, asking you after three rounds; a refactorer improves the code, with the tests run at every hand-off. All three roles share one relay worktree.',
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
      'Two contestants commit competing versions in separate managed worktrees; a judge reads their generated refs, commits feedback in its own tree, and reports the winner for review. Two rounds at most, ending early on a clear winner. Requires core workspace context; never merges automatically.',
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
      "A planner writes the spec before any code, and the plan once you approve the spec; a builder writes the plan's tests, checks they fail, then makes them pass; a reviewer checks the result against the spec. All three share a Spec and implementation worktree. Choose an agent for each role.",
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
  return EXAMPLES.find((example) => readTemplate(example.text).id === id);
}
