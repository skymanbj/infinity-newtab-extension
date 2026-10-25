import { MAX_INLINE_ICON_LENGTH } from './backup';

/**
 * 本地图标最终要写进 chrome.storage.sync，所以必须先压到这个预算之内。
 * 预算和导入校验共用同一个常量，避免「能存进去但刷新后消失」。
 */
export const ICON_BUDGET = MAX_INLINE_ICON_LENGTH;

/** 解码一张 20 MB 以内的图已经足够当图标；更大的图只会拖慢对话框。 */
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** 从大到小尝试，优先保住分辨率，实在压不下去才降边长。 */
const SIZES = [128, 112, 96, 80, 64, 48];
const QUALITIES = [0.92, 0.8, 0.68, 0.55, 0.42];

export type LocalIcon = {
    /** data:image/... 形式的内嵌图标，可直接作为书签的 icon 保存。 */
    icon: string;
    /** 压缩后的正方形边长。 */
    size: number;
    /** 解码后的实际字节数，用来给用户一个「占了多大同步空间」的提示。 */
    bytes: number;
};

type Source = {
    paint: (context: CanvasRenderingContext2D, size: number) => void;
    dispose: () => void;
};

/** 把用户选的本地图片压成能随书签一起同步的小图标。 */
export async function localImageToIcon(file: File): Promise<LocalIcon> {
    if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
    if (file.size > MAX_SOURCE_BYTES) throw new Error('图片太大了，请选择 20 MB 以内的图片');
    const source = await loadSource(file);
    try {
        for (const size of SIZES) {
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('当前浏览器无法处理图片');
            context.clearRect(0, 0, size, size);
            source.paint(context, size);
            for (const quality of QUALITIES) {
                const icon = encode(canvas, quality);
                if (icon.length <= ICON_BUDGET) {
                    return { icon, size, bytes: iconByteSize(icon) };
                }
            }
        }
        // 连 48px 都压不进去：说明原图细节太多（例如整张照片），再降就糊成一片了。
        throw new Error('这张图片细节太多，压不到同步大小，换一张更简单的图试试');
    } finally {
        source.dispose();
    }
}

/** data: URL 的实际字节数（base64 每 4 个字符对应 3 个字节）。 */
export function iconByteSize(dataUrl: string): number {
    const comma = dataUrl.indexOf(',');
    const payload = comma < 0 ? dataUrl.length : dataUrl.length - comma - 1;
    const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.round((payload * 3) / 4) - padding);
}

export function isInlineIcon(value: unknown): boolean {
    return typeof value === 'string' && value.startsWith('data:image/');
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

async function loadSource(file: File): Promise<Source> {
    // createImageBitmap 不会解析 SVG，也不保证认所有格式，失败后回落到 <img>。
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file);
            return {
                paint: (context, size) => drawContain(context, bitmap, bitmap.width, bitmap.height, size),
                dispose: () => bitmap.close()
            };
        } catch {
            // 继续尝试 <img> 解码。
        }
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    try {
        image.src = url;
        await image.decode();
    } catch {
        URL.revokeObjectURL(url);
        throw new Error('无法读取这张图片，请换一张试试');
    }
    const width = image.naturalWidth || 256;
    const height = image.naturalHeight || 256;
    return {
        paint: (context, size) => drawContain(context, image, width, height, size),
        dispose: () => URL.revokeObjectURL(url)
    };
}

/** 等比缩放到正方形画布中央，留透明边，非正方形的 logo 不会被拉变形。 */
function drawContain(
    context: CanvasRenderingContext2D,
    image: CanvasImageSource,
    width: number,
    height: number,
    size: number
): void {
    const scale = Math.min(size / width, size / height);
    const drawWidth = Math.max(1, Math.round(width * scale));
    const drawHeight = Math.max(1, Math.round(height * scale));
    context.drawImage(
        image,
        Math.round((size - drawWidth) / 2),
        Math.round((size - drawHeight) / 2),
        drawWidth,
        drawHeight
    );
}

function encode(canvas: HTMLCanvasElement, quality: number): string {
    const webp = canvas.toDataURL('image/webp', quality);
    // 浏览器不支持 WebP 编码时会静默返回 PNG，此时换个更小的尺寸也没用，直接用 PNG。
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}
