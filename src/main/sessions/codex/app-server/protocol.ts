import type { CodexMode, MessageImage } from '../../../../shared/session';

/*
 * The parts of Codex's app-server protocol corrallm sends, as Codex CLI 0.160.1 declares them
 * (`codex app-server generate-ts --experimental`: v2/TurnStartParams, ThreadStartParams,
 * ThreadResumeParams, UserInput, SandboxPolicy, CollaborationMode, the approval decisions), cut to
 * the fields corrallm uses. What comes back is read as `unknown` (../../transcript.ts: `property`,
 * `text`), since the user's Codex decides what is on the wire; these only keep what corrallm
 * writes right.
 */

/** When Codex asks before acting (AskForApproval; 0.160.1 refuses 'on-failure'). */
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/** How a thread's commands are sandboxed, by name (thread/start's and thread/resume's `sandbox`). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** A sandbox as turn/start takes it (`sandboxPolicy`), and as Codex reports it. */
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite';
      writableRoots: string[];
      networkAccess: boolean;
      excludeTmpdirEnvVar: boolean;
      excludeSlashTmp: boolean;
    };

/** Plan mode, or not: what turn/start's `collaborationMode` sets (experimental). */
export interface CollaborationMode {
  mode: 'plan' | 'default';
  settings: {
    model: string;
    reasoning_effort: string | null;
    /** Null: the mode's own instructions. */
    developer_instructions: null;
  };
}

/** What a message is made of, as turn/start's `input` takes it. */
export type UserInput =
  | { type: 'text'; text: string; text_elements: [] }
  /** An image, as a data: URL (the app server refuses remote ones). */
  | { type: 'image'; url: string }
  /** A skill invoked in the message ("$name"): the server adds its instructions. */
  | { type: 'skill'; name: string; path: string };

/** What answers a command's approval (CommandExecutionApprovalDecision). */
export type CommandDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | 'decline'
  | 'cancel';

/** What answers a file change's approval (FileChangeApprovalDecision). */
export type FileChangeDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/** What a corrallm mode is in Codex: its /permissions preset's settings, and plan mode or not. */
export interface ModeSettings {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  plan: boolean;
}

/**
 * Codex's /permissions presets (codex-rs/utils/approval-presets, rust-v0.160.1): Read only and
 * Default ask before going further (on-request), in a read-only sandbox or one of the project
 * folder; Full access never asks and has no sandbox. Plan is Codex's plan collaboration mode, with
 * Default's permissions.
 */
export function modeSettings(mode: CodexMode): ModeSettings {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', plan: false };
    case 'auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', plan: false };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', plan: false };
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', plan: true };
  }
}

/**
 * The sandbox policy of a sandbox mode, for turn/start. `known` is the policy Codex reported for
 * the thread, which carries the user's own settings (config.toml's writable roots, network
 * access): kept when it is of the same kind.
 */
export function sandboxPolicy(sandbox: SandboxMode, known?: SandboxPolicy): SandboxPolicy {
  switch (sandbox) {
    case 'read-only':
      return known?.type === 'readOnly' ? known : { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return known?.type === 'workspaceWrite'
        ? known
        : {
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

/** A sandbox policy Codex reported, if it is one corrallm knows. */
export function readSandboxPolicy(value: unknown): SandboxPolicy | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const policy = value as Record<string, unknown>;
  switch (policy.type) {
    case 'dangerFullAccess':
      return { type: 'dangerFullAccess' };
    case 'readOnly':
      return { type: 'readOnly', networkAccess: policy.networkAccess === true };
    case 'workspaceWrite':
      return {
        type: 'workspaceWrite',
        writableRoots: Array.isArray(policy.writableRoots)
          ? policy.writableRoots.filter((root): root is string => typeof root === 'string')
          : [],
        networkAccess: policy.networkAccess === true,
        excludeTmpdirEnvVar: policy.excludeTmpdirEnvVar === true,
        excludeSlashTmp: policy.excludeSlashTmp === true,
      };
    default:
      return undefined;
  }
}

/** A pasted image as Codex takes it: a data: URL. */
export function imageInput({ mediaType, data }: MessageImage): UserInput {
  return { type: 'image', url: `data:${mediaType};base64,${data}` };
}

/** Text as Codex takes it. */
export function textInput(text: string): UserInput {
  return { type: 'text', text, text_elements: [] };
}
