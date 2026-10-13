import { Container } from '@cloudflare/containers';
import { handleMediaOutbound } from './outbound';

/** The `media` container (ffmpeg, exiftool, libraw, libvips). It reaches R2 only through `http://media.r2/<key>`. */
export class MediaContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '5m';
  enableInternet = false;

  // `Container.outboundByHost` is a static accessor that stores handlers in a registry keyed by class name. A
  // `static outboundByHost = ...` field would define an own property under ES2022 class-field semantics (this
  // project's target) and skip that setter, so the handler would never be found. Assigning calls the setter.
  static {
    this.outboundByHost = {
      'media.r2': (req, env) => handleMediaOutbound(req, env),
    };
  }
}
