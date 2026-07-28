export { EnvpitClient } from './client.js';
export { AuthenticationError, EnvpitError, MissingKeyError, NetworkError, TypeMismatchError } from './errors.js';
export { mergeSnapshotIntoEnv } from './process-env-merge.js';
export type { MergeIntoProcessEnvOptions, MergeIntoProcessEnvResult } from './process-env-merge.js';
export type {
  CacheInfo,
  ChangeEvent,
  ChangeTrigger,
  ConfigSnapshot,
  ConnectionEvent,
  ConnectionMode,
  ConnectionReason,
  EnvpitClientEvents,
  EnvpitClientOptions,
  Logger,
} from './types.js';
