// NestJS example — resolves config from a real EnvPit server through the PUBLISHED
// @envpit/sdk, merges it into process.env, and only THEN builds the Nest module graph.
//
//   ENVPIT_API_KEY=... npm start
//
// Why the order matters (verified, not guessed, against the installed @nestjs/config source):
//   - node_modules/@nestjs/config/dist/config.service.js `ConfigService#get()` reads
//     `process.env` LIVE on every call when no `validate`/`validationSchema` option is used
//     (config.service.js:180) -- for that bare case, merge-vs-boot ordering would not matter.
//   - node_modules/@nestjs/config/dist/config.module.js `ConfigModule.forRoot({ validate })`
//     calls `options.validate(config)` SYNCHRONOUSLY, inline, no await -- the moment
//     `@Module({ imports: [ConfigModule.forRoot(...)] })`'s decorator argument is evaluated.
//     That happens the instant `./app.module` is imported (ES module class-decoration runs at
//     import time), NOT when `NestFactory.create()` finishes building the app.
// This app uses `validate` (config.schema.ts), matching this product's own Zod-everywhere
// convention. A throwing validator makes `forRoot()` throw at import time, so `./app.module`
// (and `@nestjs/core`, which triggers nothing on its own but is grouped here for clarity) is
// imported with a DYNAMIC `import()` call placed AFTER the merge below, not a static
// top-of-file `import { AppModule } from './app.module'`. A static import is hoisted by the
// module system and would evaluate app.module.ts -- and therefore validateConfig() -- before
// this function body runs AT ALL, silently validating an environment EnvPit hasn't populated
// yet. See README.md "Getting this wrong" for the reproduced failure with a static import.
import 'reflect-metadata';
import { EnvpitClient } from '@envpit/sdk';
import { setEnvpitReport } from './envpit-registry';

async function bootstrap(): Promise<void> {
  const host = process.env.ENVPIT_HOST ?? 'https://envpit.com';

  // --- Step 1: resolve + merge BEFORE the Nest module graph is built. ---------------------
  const client = await EnvpitClient.load({ apiKey: process.env.ENVPIT_API_KEY, host });

  // Key NAMES only, never values.
  const secretKeys = client.secretKeys();
  const before = new Set(Object.keys(process.env));
  const merged = client.mergeIntoProcessEnv();

  console.log('[envpit] secret-flagged keys :', secretKeys.length ? secretKeys.join(', ') : '(none)');
  console.log('[envpit] merged into env     :', merged.merged.join(', ') || '(none)');
  console.log('[envpit] withheld (secret)   :', merged.skippedSecrets.join(', ') || '(none)');
  console.log('[envpit] skipped (existing)  :', merged.skippedExisting.join(', ') || '(none)');

  // A secret with NO value in this environment is "absent", not "withheld" -- the SDK's null
  // check runs before its secret check, so an unset secret never reaches skippedSecrets.
  const unsetSecrets = secretKeys.filter((k) => client.getOptional(k) === undefined);
  if (unsetSecrets.length) {
    console.log(
      '[envpit] secret, but unset here:',
      unsetSecrets.join(', '),
      '(nothing to withhold for these -- set a value to exercise the filter for real)',
    );
  }

  // --- Step 2: assert against the real environment, not the summary object. ---------------
  const leaked = secretKeys.filter((k) => process.env[k] !== undefined && !before.has(k));
  if (leaked.length) {
    console.error(`[envpit] FAIL: secret-flagged keys reached process.env: ${leaked.join(', ')}`);
    process.exit(1);
  }
  console.log('[envpit] OK -- no secret-flagged key is present in process.env\n');

  setEnvpitReport({ secretKeys, merged });

  // --- Step 3: only NOW import @nestjs/core and AppModule. Importing AppModule is what
  // actually evaluates ConfigModule.forRoot()/validateConfig against process.env -- see the
  // file-header comment above.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`[envpit-nestjs] listening on http://localhost:${port}`);

  const shutdown = async (): Promise<void> => {
    await app.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err: unknown) => {
  console.error('[envpit-nestjs] fatal boot error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
