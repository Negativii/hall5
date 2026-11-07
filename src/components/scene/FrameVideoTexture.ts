import { VideoTexture } from 'three';

/** Reuse Three's video callback: no second polling loop or duplicate rVFC. */
export class FrameVideoTexture extends VideoTexture {
  private onFrame?: () => void;
  private onMediaFrame: () => void;
  private readonly mediaEvents = ['loadeddata', 'seeked', 'resize'];

  constructor(video: HTMLVideoElement, onFrame?: () => void) {
    super(video);
    // In older browsers VideoTexture.update() runs inside renderer.render().
    // Waking from that path would recursively schedule frames even on pause.
    this.onFrame = typeof video.requestVideoFrameCallback === 'function' ? onFrame : undefined;
    this.onMediaFrame = () => { if (video.readyState >= 2) this.needsUpdate = true; };
    for (const event of this.mediaEvents) video.addEventListener(event, this.onMediaFrame);
    // A paused video may already have delivered its only rVFC before this new
    // texture was created (for example, returning from a single-screen view).
    this.onMediaFrame();
  }

  override set needsUpdate(value: boolean) {
    super.needsUpdate = value;
    if (value) this.onFrame?.();
  }

  override dispose() {
    for (const event of this.mediaEvents) this.image.removeEventListener(event, this.onMediaFrame);
    this.onFrame = undefined;
    super.dispose();
  }
}
