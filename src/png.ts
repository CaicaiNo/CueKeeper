import { deflateSync, inflateSync } from 'node:zlib';

/** Decoded, non-premultiplied 8-bit RGBA pixels in sRGB. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export class PngError extends Error {}

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function readUint32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** Reads the IHDR dimensions without decoding pixels. */
export function pngSize(bytes: Uint8Array) {
  if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new PngError('Not a PNG file');
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (!width || !height) throw new PngError('PNG has no pixels');
  return { width, height };
}

export function decodePng(bytes: Uint8Array, maxPixels = 33_554_432): RgbaImage {
  const { width, height } = pngSize(bytes);
  if (width * height > maxPixels) throw new PngError('PNG exceeds the pixel limit');
  let offset = 8;
  let header: { bitDepth: number; colorType: number; interlace: number } | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new PngError('Truncated PNG chunk');
    const chunk = bytes.subarray(start, end);
    const expected = readUint32(bytes, end);
    const actual = crc32(bytes.subarray(offset + 4, end));
    if (expected !== actual) throw new PngError(`PNG chunk ${type} failed its checksum`);
    if (type === 'IHDR') {
      if (length !== 13) throw new PngError('Invalid IHDR');
      header = { bitDepth: bytes[start + 8], colorType: bytes[start + 9], interlace: bytes[start + 10] };
      if (bytes[start + 10] !== 0) throw new PngError('Interlaced PNG is not supported');
      if (bytes[start + 8] !== 8) throw new PngError('Only 8-bit PNG is supported');
    } else if (type === 'PLTE') {
      palette = chunk;
    } else if (type === 'tRNS') {
      transparency = chunk;
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset = end + 4;
  }
  if (!header) throw new PngError('PNG has no IHDR');
  if (!idat.length) throw new PngError('PNG has no image data');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType];
  if (!channels) throw new PngError(`Unsupported PNG color type ${header.colorType}`);
  if (header.colorType === 3 && !palette) throw new PngError('Palette PNG has no palette');
  const stride = width * channels;

  const total = idat.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const part of idat) {
    joined.set(part, at);
    at += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(joined, { maxOutputLength: height * (stride + 1) }));
  } catch {
    throw new PngError('PNG image data is not valid zlib');
  }
  if (raw.length < height * (stride + 1)) throw new PngError('PNG image data is too short');

  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const target = y * stride;
    for (let index = 0; index < stride; index++) {
      const value = raw[rowStart + index];
      const left = index >= channels ? pixels[target + index - channels] : 0;
      const up = y > 0 ? pixels[target - stride + index] : 0;
      const upLeft = index >= channels && y > 0 ? pixels[target - stride + index - channels] : 0;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = Math.floor((left + up) / 2); break;
        case 4: predicted = paeth(left, up, upLeft); break;
        default: throw new PngError(`Unknown PNG row filter ${filter}`);
      }
      pixels[target + index] = (value + predicted) & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    const source = index * channels;
    let red: number;
    let green: number;
    let blue: number;
    let alpha = 255;
    if (header.colorType === 6) {
      [red, green, blue, alpha] = [pixels[source], pixels[source + 1], pixels[source + 2], pixels[source + 3]];
    } else if (header.colorType === 2) {
      [red, green, blue] = [pixels[source], pixels[source + 1], pixels[source + 2]];
    } else if (header.colorType === 0) {
      red = green = blue = pixels[source];
    } else if (header.colorType === 4) {
      red = green = blue = pixels[source];
      alpha = pixels[source + 1];
    } else {
      const entry = pixels[source];
      red = palette![entry * 3] ?? 0;
      green = palette![entry * 3 + 1] ?? 0;
      blue = palette![entry * 3 + 2] ?? 0;
      alpha = transparency && entry < transparency.length ? transparency[entry] : 255;
    }
    if (alpha === 0) red = green = blue = 0;
    const out = index * 4;
    data[out] = red;
    data[out + 1] = green;
    data[out + 2] = blue;
    data[out + 3] = alpha;
  }
  return { width, height, data };
}

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

export function crop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width || y + height > image.height) {
    throw new PngError('The crop rectangle is outside the image');
  }
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * image.width + x) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data };
}

export function encodePng(image: RgbaImage): Uint8Array {
  if (image.data.length !== image.width * image.height * 4) throw new PngError('RGBA buffer size mismatch');
  const stride = image.width * 4;
  const raw = new Uint8Array(image.height * (stride + 1));
  for (let y = 0; y < image.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [chunk('IHDR', header), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array())];
  const total = 8 + chunks.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set(signature, 0);
  let offset = 8;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function chunk(type: string, data: Uint8Array) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set([...type].map(character => character.charCodeAt(0)), 4);
  bytes.set(data, 8);
  view.setUint32(8 + data.length, crc32(bytes.subarray(4, 8 + data.length)));
  return bytes;
}
