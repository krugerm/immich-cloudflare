// Phase 4 E: person thumbnails, rendered by Task D's `renderPersonThumbnail` (src/faces/thumbs.ts) and stored at
// `people/<personGroupId>.jpeg`. Tests may swap the renderer with setPersonThumbnailRenderer.
import { renderPersonThumbnail } from '../faces/thumbs';

export type PersonThumbnailRenderer = (env: Env, personGroupId: string) => Promise<unknown>;

let renderer: PersonThumbnailRenderer | undefined = (env, personGroupId) => renderPersonThumbnail(env, personGroupId);

export function setPersonThumbnailRenderer(fn: PersonThumbnailRenderer | undefined): void {
  renderer = fn;
}

export const personThumbnailKey = (personGroupId: string) => `people/${personGroupId}.jpeg`;

/** Immich queues PersonGenerateThumbnail; a failed render never fails the caller (the next feature-face change retries). */
export async function requestPersonThumbnail(env: Env, personGroupId: string): Promise<void> {
  if (!renderer) return;
  try {
    await renderer(env, personGroupId);
  } catch (err) {
    console.error(`person thumbnail ${personGroupId} failed`, err);
  }
}
