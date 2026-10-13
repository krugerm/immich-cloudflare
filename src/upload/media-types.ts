const IMAGE: Record<string, string> = {
  '.3fr': 'image/x-hasselblad-3fr', '.ari': 'image/x-arriflex-ari', '.arw': 'image/x-sony-arw', '.cap': 'image/x-phaseone-cap',
  '.cin': 'image/x-phantom-cin', '.cr2': 'image/x-canon-cr2', '.cr3': 'image/x-canon-cr3', '.crw': 'image/x-canon-crw',
  '.dcr': 'image/x-kodak-dcr', '.dng': 'image/x-adobe-dng', '.erf': 'image/x-epson-erf', '.fff': 'image/x-hasselblad-fff',
  '.iiq': 'image/x-phaseone-iiq', '.k25': 'image/x-kodak-k25', '.kdc': 'image/x-kodak-kdc', '.mrw': 'image/x-minolta-mrw',
  '.nef': 'image/x-nikon-nef', '.nrw': 'image/x-nikon-nrw', '.orf': 'image/x-olympus-orf', '.ori': 'image/x-olympus-ori',
  '.pef': 'image/x-pentax-pef', '.psd': 'image/vnd.adobe.photoshop', '.raf': 'image/x-fuji-raf', '.raw': 'image/x-panasonic-raw',
  '.rw2': 'image/x-panasonic-rw2', '.rwl': 'image/x-leica-rwl', '.sr2': 'image/x-sony-sr2', '.srf': 'image/x-sony-srf',
  '.srw': 'image/x-samsung-srw', '.x3f': 'image/x-sigma-x3f',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif', '.jfif': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
  '.hif': 'image/hif', '.insp': 'image/jpeg', '.jp2': 'image/jp2', '.jpe': 'image/jpeg', '.jxl': 'image/jxl',
  '.mpo': 'image/jpeg', '.svg': 'image/svg', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

const VIDEO: Record<string, string> = {
  '.3gp': 'video/3gpp', '.3gpp': 'video/3gpp', '.avi': 'video/x-msvideo', '.flv': 'video/x-flv', '.insv': 'video/mp4',
  '.m2t': 'video/mp2t', '.m2ts': 'video/mp2t', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.mp4': 'video/mp4', '.mpe': 'video/mpeg', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.mts': 'video/mp2t',
  '.mxf': 'application/mxf', '.ts': 'video/mp2t', '.vob': 'video/mpeg', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
};

export const MEDIA_TYPES = { image: Object.keys(IMAGE), video: Object.keys(VIDEO), sidecar: ['.xmp'] };

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf('.');
  return i < 0 ? '' : filename.slice(i).toLowerCase();
}

export function assetTypeFor(filename: string): 'IMAGE' | 'VIDEO' | null {
  const ext = extensionOf(filename);
  if (ext in IMAGE) return 'IMAGE';
  if (ext in VIDEO) return 'VIDEO';
  return null;
}

export function contentTypeFor(ext: string): string {
  return IMAGE[ext] ?? VIDEO[ext] ?? 'application/octet-stream';
}
