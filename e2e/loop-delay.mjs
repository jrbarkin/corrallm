// Loaded into `corrallm serve` before it runs (node --import), by load.e2e.ts: measures the
// delay of its event loop, every millisecond, from the first SIGUSR2 it gets: over the whole time,
// and over each span between two SIGUSR2s. At each later one it writes what it measured so far, in
// milliseconds, to the file LOOP_DELAY_FILE names (whole, then renamed into place, so a reader
// never sees half of it): the whole, and each span that has ended.
import { renameSync, writeFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const whole = monitorEventLoopDelay({ resolution: 1 });
const span = monitorEventLoopDelay({ resolution: 1 });
whole.enable();
span.enable();
let measuring = false;
const spans = [];

const ms = (ns) => ns / 1e6;
const of = (histogram) => ({
  p50: ms(histogram.percentile(50)),
  p99: ms(histogram.percentile(99)),
  max: ms(histogram.max),
  samples: histogram.count,
});

process.on('SIGUSR2', () => {
  const file = process.env.LOOP_DELAY_FILE;
  if (measuring && file) {
    spans.push(of(span));
    writeFileSync(`${file}.part`, JSON.stringify({ ...of(whole), spans }));
    renameSync(`${file}.part`, file);
  } else {
    whole.reset();
  }
  measuring = true;
  span.reset();
});
