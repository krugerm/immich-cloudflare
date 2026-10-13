import type { components } from './immich';

export type Dto<K extends keyof components['schemas']> = components['schemas'][K];
