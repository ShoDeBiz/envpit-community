// A tiny, deliberately non-Nest module: no decorators, no DI. It exists purely so
// AppController (below) has a trivial way to show "what EnvPit resolved at boot" without
// turning this example into a lesson on custom Nest providers. `setEnvpitReport` is called
// once, from main.ts, BEFORE the Nest module graph is built.
import type { MergeIntoProcessEnvResult } from '@envpit/sdk';

export interface EnvpitReport {
  secretKeys: readonly string[];
  merged: MergeIntoProcessEnvResult;
}

let report: EnvpitReport | undefined;

export function setEnvpitReport(value: EnvpitReport): void {
  report = value;
}

export function getEnvpitReport(): EnvpitReport {
  if (!report) {
    throw new Error('EnvPit report read before main.ts set it -- check bootstrap order.');
  }
  return report;
}
