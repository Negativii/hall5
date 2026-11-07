// Keep compatible video packets intact. A different container does not require a
// second video encode; +faststart only moves MP4's index before the media data.
export function previewPlan(info) {
  if (info.hdr) {
    throw new Error('HDR-видео требует отдельной SDR-версии для браузера. Оригинал сохранён; цвета автоматически не изменены.');
  }
  if (![0, 90, 180, 270].includes(info.rotation)) {
    throw new Error('Нестандартный поворот видео. Экспортируйте ролик с обычной ориентацией, чтобы не обрезать кадр.');
  }
  const copyVideo = info.codec === 'h264' && info.pixelFormat === 'yuv420p'
    && ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(info.profile)
    && info.rotation === 0 && ['progressive', 'unknown', ''].includes(info.fieldOrder)
    && info.width % 2 === 0 && info.height % 2 === 0;
  return {
    mode: copyVideo ? 'copy' : 'converted',
    width: copyVideo ? info.width : Math.ceil(info.width / 2) * 2,
    height: copyVideo ? info.height : Math.ceil(info.height / 2) * 2,
    // AAC-LC is the shared MP4 audio format. Other audio is converted without
    // reducing its channel count; the uploaded original remains available.
    copyAudio: info.audioCodec === 'aac' && info.audioProfile === 'LC',
    videoArgs: copyVideo ? ['-c:v', 'copy'] : [
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '16',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-fps_mode', 'passthrough',
    ],
  };
}
