import { z, type ZodRawShape } from 'zod';

// The one thing this schema exists to prove: whichever key `ENVPIT_REQUIRED_KEY` names
// (default `GREETING` -- present in the live test environment this example was verified
// against) MUST already be in `process.env` by the time `ConfigModule.forRoot({ validate })`
// calls this function, because that call happens SYNCHRONOUSLY at class-decoration time --
// the instant `app.module.ts` is imported, not when Nest finishes building the app (verified
// against the installed source: node_modules/@nestjs/config/dist/config.module.js#forRoot,
// which calls `options.validate(config)` inline, no await, no defer). If EnvPit's merge
// hasn't happened yet, this throws and the app never boots. See main.ts for why the import of
// this module is deferred with a dynamic `import()` until AFTER the merge, and README.md
// "Getting this wrong" for the reproduced failure.
const requiredKey = process.env.ENVPIT_REQUIRED_KEY ?? 'GREETING';

export function validateConfig(config: Record<string, unknown>): Record<string, unknown> {
  const shape: ZodRawShape = { [requiredKey]: z.string().min(1) };
  // .passthrough() keeps every other env var too -- this schema only asserts the ONE key it
  // cares about; it is not meant to be a full env allow-list for this demo.
  return z.object(shape).passthrough().parse(config);
}
