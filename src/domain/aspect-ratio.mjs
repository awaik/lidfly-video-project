/**
 * One answer to "do these two frames have the same shape".
 *
 * Reference-asset checks, the shot-plan gate and the assembler all need the
 * same comparison, and a second implementation would drift: a warning that
 * fires in one place and not the other reads as a bug in the footage rather
 * than a bug in the check.
 */

/**
 * Encoders round, providers crop a row, and a 1080x1920 master built from a
 * 720x1280 take is the same frame. Five percent keeps those identical while
 * still separating 16:9 from 9:16 (a factor of three apart).
 */
export const ASPECT_RATIO_TOLERANCE = 0.05;

function greatestCommonDivisor(left, right) {
  return right === 0 ? left : greatestCommonDivisor(right, left % right);
}

/** Reduce pixel dimensions to the "16:9" form used in plans and requests. */
export function formatAspectRatio(width, height) {
  const divisor = greatestCommonDivisor(width, height) || 1;
  return `${width / divisor}:${height / divisor}`;
}

/** Parse "16:9" into a number. Returns null for anything else, "adaptive" included. */
export function parseAspectRatio(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value).trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) return null;
  return width / height;
}

/**
 * Compare pixel dimensions against a written ratio.
 *
 * An unparseable target ("adaptive") answers true: there is no declared shape
 * to disagree with, and a false here would read as a defect in the asset.
 */
export function aspectRatioMatches(width, height, target) {
  const targetRatio = parseAspectRatio(target);
  if (targetRatio === null) return true;
  const actual = width / height;
  return Math.abs(actual - targetRatio) / targetRatio <= ASPECT_RATIO_TOLERANCE;
}

/** Compare two frames by pixel dimensions, without routing through a ratio string. */
export function dimensionsMatchRatio(width, height, targetWidth, targetHeight) {
  if (![width, height, targetWidth, targetHeight].every((value) => Number.isFinite(value) && value > 0)) {
    return false;
  }
  const target = targetWidth / targetHeight;
  return Math.abs(width / height - target) / target <= ASPECT_RATIO_TOLERANCE;
}
