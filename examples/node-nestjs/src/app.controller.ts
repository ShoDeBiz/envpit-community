import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getEnvpitReport } from './envpit-registry';

@Controller()
export class AppController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  getConfig(): Record<string, unknown> {
    const { secretKeys, merged } = getEnvpitReport();
    const sampleKey = merged.merged[0];

    return {
      // Read via the ORDINARY @nestjs/config API -- this route never imports @envpit/sdk.
      // Presence only, never the value.
      sampleRead: sampleKey
        ? { key: sampleKey, presentViaConfigService: this.config.get<string>(sampleKey) !== undefined }
        : null,
      mergedKeys: merged.merged,
      secretFlaggedKeys: secretKeys,
      // Asserted live against process.env on every request, not cached from boot -- must
      // always be an empty array.
      secretKeysLeakedIntoProcessEnv: secretKeys.filter((k) => process.env[k] !== undefined),
    };
  }

  @Get('healthz')
  health(): { ok: true } {
    return { ok: true };
  }
}
