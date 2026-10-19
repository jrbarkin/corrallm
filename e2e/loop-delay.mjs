// Loaded into `corrallm serve` before it runs (node --import), by load.e2e.ts: measures the
// delay of its event loop, every millisecond, from the first SIGUSR2 it gets to the next, then
// writes what it measured, in milliseconds, to the file LOOP_DELAY_FILE names, and starts again.
import { writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const histogram = monitorEventLoopDelay({ resolution: 1 });
histogram.enable();
let measuring = false;

process.on('SIGUSR2', () => {
  if (measuring && process.env.LOOP_DELAY_FILE) {
    const ms = (ns) => ns / 1e6;
    writeFileSync(
      process.env.LOOP_DELAY_FILE,
      JSON.stringify({
        p50: ms(histogram.percentile(50)),
        p99: ms(histogram.percentile(99)),
        max: ms(histogram.max),
        samples: histogram.count,
      }),
    );
  }
  measuring = !measuring;
  histogram.reset();
});
