import { Container } from '@cloudflare/containers';

export const ML_PORT = 3003;
/**
 * How long a cold instance may take to open its port. Immich's server binds only after preloading the four models
 * (25 to 42 s at 1 vCPU on a Linux x86_64 host); the library's default wait is 20 s, after which it answers 500 "Failed to
 * start container".
 */
export const ML_PORT_READY_TIMEOUT_MS = 120_000;

/**
 * The `ml` container: Immich's machine-learning server (`containers/ml/Dockerfile`) on port 3003 with
 * ViT-B-16-SigLIP2__webli and buffalo_l baked in and preloaded. It needs no network: the models are in the image.
 * Instance type `standard-2` and `max_instances 2` are set in wrangler.jsonc.
 */
export class MlContainer extends Container {
  defaultPort = ML_PORT;
  sleepAfter = '10m';
  enableInternet = false;

  override async fetch(request: Request): Promise<Response> {
    const state = await this.getState();
    if (!this.ctx.container?.running || state.status !== 'healthy') {
      try {
        await this.startAndWaitForPorts(ML_PORT, { portReadyTimeoutMS: ML_PORT_READY_TIMEOUT_MS, abort: request.signal });
      } catch (err) {
        // Fall through: Container.fetch tries again and turns the failure into its usual 429/500/503 response.
        console.error('ml container did not start', err);
      }
    }
    return super.fetch(request);
  }
}

/**
 * The search container: the same server built with `--target search` (the text encoder only), so a cold start loads
 * one model. `POST /warm` starts it without waiting for the port, or renews the idle timer of a running one; the
 * Worker sends it when an app opens (see src/ml/warm.ts), so the first query usually finds it ready.
 */
export class MlSearchContainer extends MlContainer {
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== '/warm') return super.fetch(request);
    if (this.ctx.container?.running) {
      this.renewActivityTimeout();
      return new Response(null, { status: 204 });
    }
    await this.start();
    return new Response(null, { status: 202 });
  }
}
