import fanOut from './examples/fan-out.corral?raw';
import releaseChecks from './examples/release-checks.corral?raw';
import reviewLoop from './examples/review-loop.corral?raw';
import teamLead from './examples/team-lead.corral?raw';

/** A canvas that shows what corrallm does, in the Examples gallery: a `.corral` file's text. */
export interface Example {
  name: string;
  description: string;
  text: string;
}

export const EXAMPLES: readonly Example[] = [
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
