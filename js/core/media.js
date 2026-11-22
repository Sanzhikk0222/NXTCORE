// Подготовка картинок в браузере: уменьшение, base64, загрузка в элемент Image.

export function loadImage(src, cross = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (cross) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

// Разрешаем все форматы изображений
export const ACCEPT = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/avif', 'image/*'];

// Уменьшает до maxSide и отдаёт JPEG не тяжелее ~2.2 МБ (лимит функции 3 МБ на файл)
export async function prepareImage(file, maxSide = 1600) {
  // Проверяем, что файл вообще является картинкой (пропускает любые форматы image/*)
  if (!file.type.startsWith('image/')) throw new Error('type');
  
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    let q = 0.88;
    let blob;
    do {
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
      q -= 0.1;
    } while (blob.size > 2_200_000 && q > 0.4);
    const objUrl = URL.createObjectURL(blob);
    const ready = await loadImage(objUrl);
    return { blob, w, h, img: ready, url: objUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });

export async function toUploadItem(name, blob) {
  return { name, mime: blob.type || 'image/jpeg', data: await blobToBase64(blob) };
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
}
