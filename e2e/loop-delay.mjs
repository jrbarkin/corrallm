// Loaded into `corrallm serve` before it runs (node --import), by load.e2e.ts: measures the
// delay of its event loop, every millisecond, from the first SIGUSR2 it gets: over the whole time,
// and over each span between two SIGUSR2s. At each later one it writes what it measured so far, in
// milliseconds, to the file LOOP_DELAY_FILE names (whole, then renamed into place, so a reader
// never sees half of it): the whole, and each span that has ended.
import { rename, writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import { installDiagnostics } from './g2-diagnostics.mjs';

const diagnostics = installDiagnostics();

// Opt-in diagnostics start before the CLI, outside the measured spans, and survive a failed gate.
const cpuFile = process.env.CORRALLM_LOAD_CPU_PROFILE;
const cpu = cpuFile ? new Session() : undefined;
if (cpu) {
  cpu.connect();
  await cpu.post('Profiler.enable');
  const before = diagnostics?.now();
  await cpu.post('Profiler.start');
  if (diagnostics) diagnostics.anchor(before, diagnostics.now());
}

const whole = monitorEventLoopDelay({ resolution: 1 });
const span = monitorEventLoopDelay({ resolution: 1 });
whole.enable();
span.enable();
let measuring = false;
const spans = [];
let publishing = Promise.resolve();

const ms = (ns) => ns / 1e6;
const of = (histogram) => ({
  p50: ms(histogram.percentile(50)),
  p99: ms(histogram.percentile(99)),
  max: ms(histogram.max),
  samples: histogram.count,
});

process.on('SIGUSR2', () => {
  diagnostics?.mark();
  const file = process.env.LOOP_DELAY_FILE;
  if (measuring && file) {
    spans.push(of(span));
    const result = JSON.stringify({ ...of(whole), spans });
    const publish = async () => {
      await writeFile(`${file}.part`, result);
      await rename(`${file}.part`, file);
    };
    // Stop at the signal boundary even if a previous result is still being written.
    const profiled =
      cpu && spans.length === 3
        ? cpu
            .post('Profiler.stop')
            .then(async ({ profile }) => {
              await writeFile(cpuFile, JSON.stringify(profile), { mode: 0o600 });
              if (diagnostics)
                await writeFile(
                  `${cpuFile}.activity.json`,
                  JSON.stringify(diagnostics.snapshot(profile.startTime)),
                  { mode: 0o600 },
                );
            })
            .catch(() => {
              process.stderr.write('G2 CPU profile could not be written.\n');
            })
            .finally(() => cpu.disconnect())
        : Promise.resolve();
    // One FIFO keeps the shared partial path and the final profile ordered without blocking
    // the loop whose delay is measured. Each result was captured at its signal boundary.
    publishing = publishing
      .then(async () => {
        // The test may stop the CLI as soon as it reads the last span, even on a failed assertion.
        await profiled;
        await publish();
      })
      .catch(() => {
        process.stderr.write('G2 loop measurements could not be written.\n');
      });
  } else {
    whole.reset();
  }
  measuring = true;
  span.reset();
});
