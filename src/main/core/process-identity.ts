import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Linux starts are boot-relative ticks, not wall-clock times. Keep the integer exact. */
export type ProcessStart = number | { bootId: string; ticks: string };

export function isProcessStart(value: unknown): value is ProcessStart {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value !== 'object' || value === null) return false;
  const { bootId, ticks } = value as Record<string, unknown>;
  return (
    typeof bootId === 'string' &&
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(bootId) &&
    typeof ticks === 'string' &&
    /^(?:0|[1-9]\d{0,19})$/.test(ticks)
  );
}

export function sameStart(a: ProcessStart, b: ProcessStart): boolean {
  return typeof a === 'number' || typeof b === 'number'
    ? a === b
    : a.bootId === b.bootId && a.ticks === b.ticks;
}

/** The OS identity and private group come from the same process-table record. */
export function inspectProcess(pid: number): { started: ProcessStart; group: number } | undefined {
  if (process.platform === 'linux') return linuxProcess(pid);
  if (process.platform !== 'darwin') {
    throw new Error(`Process inspection is not supported on ${process.platform}.`);
  }
  let text: string;
  try {
    text = execFileSync('ps', ['-o', 'lstart=', '-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    if (failed.status === 1 && failed.stdout?.trim() === '' && failed.stderr?.trim() === '')
      return undefined;
    throw error;
  }
  const fields = /^(.+?)\s+(\d+)$/.exec(text);
  const started = Date.parse(fields?.[1] ?? '');
  const group = Number(fields?.[2]);
  if (!isProcessStart(started) || !Number.isSafeInteger(group) || group <= 0) {
    throw new Error(`Could not identify process ${String(pid)}.`);
  }
  return { started, group };
}

function linuxProcess(pid: number): ReturnType<typeof inspectProcess> {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ESRCH')
    ) {
      return undefined;
    }
    throw error;
  }
  // comm (field 2) may contain whitespace and ')'. The remaining fields have no parentheses.
  const end = stat.lastIndexOf(')');
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  // proc_pid_stat(5): pgrp is field 5, starttime is field 22; this slice starts at field 3.
  const group = Number(fields[2]);
  const started = {
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    ticks: fields[19],
  };
  if (
    !stat.startsWith(`${String(pid)} (`) ||
    end < 0 ||
    !isProcessStart(started) ||
    !Number.isSafeInteger(group) ||
    group <= 0
  ) {
    throw new Error(`Could not identify process ${String(pid)}.`);
  }
  return { started, group };
}
