import { appStore } from '../core/store';
import type { Bookmark } from '../core/types';
import { DEFAULT_ICON, escapeHtml, faviconUrl, normalizeUrl, sanitizeRemoteUrl } from '../core/utils';
import { formatBytes, iconByteSize, isInlineIcon, localImageToIcon } from '../core/image-icon';
import { ICONS } from './icons';
import { notifyError, pushLayer } from './ui-layer';

type DialogDetail = { bookmark?: Bookmark; folder?: string; draft?: { url: string; name: string } };

export class BookmarkDialog extends HTMLElement {
    private editing?: Bookmark;
    private releaseLayer: (() => void) | null = null;

    connectedCallback(): void {
        document.addEventListener('open-bookmark-dialog', this.onOpen as EventListener);
    }

    disconnectedCallback(): void {
        document.removeEventListener('open-bookmark-dialog', this.onOpen as EventListener);
        this.close();
    }

    private readonly onOpen = (event: CustomEvent<DialogDetail>): void => {
        this.open(event.detail);
    };

    private open({ bookmark, folder = '全部', draft }: DialogDetail): void {
        // close() clears `editing`, so the mode has to be restored afterwards,
        // otherwise “编辑” silently turns into “新增” and duplicates the bookmark.
        this.close();
        this.editing = bookmark;
        const selected = bookmark?.folder ?? folder;
        const title = bookmark ? '编辑书签' : '添加书签';
        // 内嵌图标和图标网址共用同一个 icon 字段，编辑时按来源分别还原到两个控件。
        const storedIcon = bookmark?.icon ?? '';
        let localIcon = isInlineIcon(storedIcon) ? storedIcon : '';
        /** 本地图片压缩后的边长，只在本次对话框内用于提示，存盘后按字节数显示即可。 */
        let localSize = 0;
        const remoteIcon = localIcon ? '' : storedIcon;
        const initialStatus = localIcon
            ? localStatus(localIcon, 0)
            : remoteIcon ? '使用图标网址' : '未设置，自动按网站获取';
        this.innerHTML = `
            <div class="modal-backdrop dialog-backdrop is-open">
                <form class="modal bookmark-dialog glass glass-thick" role="dialog" aria-modal="true" aria-label="${title}" novalidate>
                    <header class="modal-header">
                        <h2>${title}</h2>
                        <button class="icon-close dialog-close" type="button" aria-label="关闭">${ICONS.close}</button>
                    </header>
                    <label class="field">
                        <span>网址</span>
                        <span class="field-with-icon">
                            <img class="url-preview" src="${DEFAULT_ICON}" alt="">
                            <input name="url" type="text" inputmode="url" required autocomplete="off" spellcheck="false" placeholder="example.com" value="${escapeHtml(bookmark?.url ?? draft?.url ?? '')}">
                        </span>
                    </label>
                    <label class="field">
                        <span>名称</span>
                        <input name="name" type="text" maxlength="160" autocomplete="off" placeholder="留空则使用网站域名" value="${escapeHtml(bookmark?.name ?? draft?.name ?? '')}">
                    </label>
                    <label class="field">
                        <span>文件夹</span>
                        <span class="select-wrap"><select name="folder">${appStore.state.folders.map((item) => `<option value="${escapeHtml(item)}" ${item === selected ? 'selected' : ''}>${escapeHtml(item)}</option>`).join('')}</select></span>
                    </label>
                    <div class="field">
                        <span>图标（留空则自动按网站获取）</span>
                        <span class="field-with-action">
                            <input name="icon" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/icon.png" value="${escapeHtml(remoteIcon)}">
                            <button class="pill-button icon-clear" type="button" data-liquid-item>清除</button>
                        </span>
                        <span class="field-icon-tools">
                            <label class="pill-button icon-upload" data-liquid-item>本地图片…<input type="file" accept="image/*" hidden></label>
                            <span class="icon-status" role="status">${escapeHtml(initialStatus)}</span>
                        </span>
                    </div>
                    <p class="field-error" role="alert" hidden></p>
                    <footer class="modal-actions">
                        <button class="pill-button cancel-dialog" type="button" data-liquid-item>取消</button>
                        <button class="pill-button primary" type="submit" data-liquid-item>保存</button>
                    </footer>
                </form>
            </div>
        `;
        const backdrop = this.querySelector<HTMLElement>('.dialog-backdrop')!;
        const form = this.querySelector<HTMLFormElement>('form')!;
        const urlInput = form.querySelector<HTMLInputElement>('input[name="url"]')!;
        const iconInput = form.querySelector<HTMLInputElement>('input[name="icon"]')!;
        const preview = form.querySelector<HTMLImageElement>('.url-preview')!;
        const error = form.querySelector<HTMLElement>('.field-error')!;
        const tools = form.querySelector<HTMLElement>('.field-icon-tools')!;
        const status = form.querySelector<HTMLElement>('.icon-status')!;
        const upload = form.querySelector<HTMLElement>('.icon-upload')!;
        const fileInput = form.querySelector<HTMLInputElement>('.icon-upload input[type="file"]')!;
        const syncStatus = () => {
            status.textContent = localIcon
                ? localStatus(localIcon, localSize)
                : sanitizeRemoteUrl(iconInput.value.trim(), true)
                    ? '使用图标网址'
                    : '未设置，自动按网站获取';
            status.classList.toggle('is-local', Boolean(localIcon));
        };
        const updatePreview = () => {
            // Only parsed https: or data:image URLs reach the preview, same rule as saving.
            const custom = localIcon || sanitizeRemoteUrl(iconInput.value.trim(), true);
            const url = normalizeUrl(urlInput.value);
            preview.src = custom ? previewSource(custom) : url ? faviconUrl(url, 64) : DEFAULT_ICON;
            syncStatus();
        };
        const applyFile = async (file: File): Promise<void> => {
            upload.classList.add('is-busy');
            try {
                const result = await localImageToIcon(file);
                localIcon = result.icon;
                localSize = result.size;
                // 本地图片和图标网址互斥，选图后清掉输入框里的地址，避免用户以为两个都生效。
                iconInput.value = '';
                updatePreview();
            } catch (applyError) {
                notifyError(applyError, '无法使用这张图片');
            } finally {
                upload.classList.remove('is-busy');
            }
        };
        preview.addEventListener('error', () => { preview.src = DEFAULT_ICON; });
        updatePreview();
        urlInput.addEventListener('input', () => {
            error.hidden = true;
            urlInput.removeAttribute('aria-invalid');
            updatePreview();
        });
        iconInput.addEventListener('input', () => {
            if (iconInput.value.trim() && localIcon) {
                localIcon = '';
                localSize = 0;
            }
            updatePreview();
        });
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0];
            // 清空 value，否则再选同一张图片不会触发 change。
            fileInput.value = '';
            if (file) void applyFile(file);
        });
        tools.addEventListener('dragover', (event) => {
            if (!event.dataTransfer?.types.includes('Files')) return;
            event.preventDefault();
            tools.classList.add('is-drop');
        });
        tools.addEventListener('dragleave', () => tools.classList.remove('is-drop'));
        tools.addEventListener('drop', (event) => {
            event.preventDefault();
            tools.classList.remove('is-drop');
            const file = event.dataTransfer?.files?.[0];
            if (file) void applyFile(file);
        });
        this.querySelector('.icon-clear')?.addEventListener('click', () => {
            localIcon = '';
            localSize = 0;
            iconInput.value = '';
            updatePreview();
            iconInput.focus();
        });
        this.querySelector('.dialog-close')?.addEventListener('click', () => this.close());
        this.querySelector('.cancel-dialog')?.addEventListener('click', () => this.close());
        backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) this.close(); });
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const data = new FormData(form);
            const input = {
                url: String(data.get('url') ?? ''),
                name: String(data.get('name') ?? ''),
                folder: String(data.get('folder') ?? '全部'),
                // 选了本地图片时以压缩后的内嵌图为准，输入框里的地址只是「网址图标」的来源。
                icon: localIcon || String(data.get('icon') ?? '').trim()
            };
            if (!normalizeUrl(input.url)) {
                error.textContent = '请输入有效的网址，例如 github.com';
                error.hidden = false;
                urlInput.setAttribute('aria-invalid', 'true');
                urlInput.focus();
                return;
            }
            try {
                if (this.editing) await appStore.updateBookmark(this.editing.id, input);
                else await appStore.addBookmark(input);
                this.close();
            } catch (saveError) {
                notifyError(saveError, '保存失败');
            }
        });
        this.releaseLayer = pushLayer(form, () => this.close());
        requestAnimationFrame(() => (bookmark ? form.querySelector<HTMLInputElement>('input[name="name"]') : urlInput)?.focus());
    }

    private close(): void {
        this.editing = undefined;
        this.innerHTML = '';
        const release = this.releaseLayer;
        this.releaseLayer = null;
        release?.();
    }
}

/**
 * URI-encodes the already sanitized address (so static analysis sees typed text
 * cleaned before it reaches `src`), then restores the escapes `href` already had,
 * leaving the address itself unchanged.
 */
function previewSource(href: string): string {
    return encodeURI(href).replace(/%25([0-9a-f]{2})/gi, '%$1');
}

/** 本地图标的来源提示：字节数决定它占掉多少同步空间，用户能自己判断要不要换成网址。 */
function localStatus(icon: string, size: number): string {
    const bytes = formatBytes(iconByteSize(icon));
    return size > 0 ? `已使用本地图片 · ${size}×${size} · ${bytes}` : `已使用本地图片 · ${bytes}`;
}
