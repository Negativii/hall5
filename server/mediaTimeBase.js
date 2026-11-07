// A numeric input time base works on FFmpeg 5.1 as well as newer releases.
// The symbolic value "demux" is not supported by the Debian Bookworm build.
export function encoderTimeBase(info) {
  const value = info?.timeBase;
  const match = typeof value === 'string' && value.match(/^([1-9]\d*)\/([1-9]\d*)$/);
  if (!match || match.slice(1).some(part => !Number.isSafeInteger(Number(part)) || Number(part) > 2147483647)) {
    throw new Error('Не удалось прочитать временную базу видео. Исходный файл сохранён.');
  }
  return value;
}
