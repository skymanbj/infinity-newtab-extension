import type { LayoutSettings } from '../core/types';

/** 启动台栅格里可调的三个尺寸，设置面板和启动台共用同一份计算。 */
export type LaunchpadGridMetrics = Pick<LayoutSettings, 'launchpadColumns' | 'launchpadRows' | 'launchpadTile'>;

/** 行高下限：行数开得再多，也得给图标留出位置。 */
const MIN_ROW_HEIGHT = 72;

/** 当前元素要按几行均分，供尺寸变化时重算。 */
const rowCounts = new WeakMap<HTMLElement, number>();
let resizeObserver: ResizeObserver | null = null;

function shareObserver(): ResizeObserver | null {
    if (typeof ResizeObserver === 'undefined') return null;
    resizeObserver ??= new ResizeObserver((entries) => {
        for (const entry of entries) {
            const grid = entry.target as HTMLElement;
            const rows = rowCounts.get(grid) ?? 0;
            if (rows > 0) applyRowHeight(grid, rows);
        }
    });
    return resizeObserver;
}

/**
 * 把可见高度均分给 N 行。
 *
 * 只扣顶部留白：`padding-bottom` 是滚动内容末尾的空白，一起扣掉的话最后一行会被挤出可视区。
 */
function applyRowHeight(grid: HTMLElement, rows: number): void {
    // 隐藏时 clientHeight 是 0，算出来的行高会把内容压扁，等尺寸变化时再算。
    const height = grid.clientHeight;
    if (height <= 0) return;
    const style = getComputedStyle(grid);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const gap = parseFloat(style.rowGap) || 0;
    const available = height - paddingTop - gap * (rows - 1);
    const rowHeight = Math.max(Math.floor(available / rows), MIN_ROW_HEIGHT);
    grid.style.setProperty('--launchpad-row-height', `${rowHeight}px`);
}

/**
 * 把「每行几个、一屏几行、图标多大」落到栅格的 CSS 变量上。
 *
 * 列数用固定轨道（`is-fixed`）取代 auto-fill；行数不是写死高度，而是把可见高度
 * 均分给 N 行，书签超出就照常滚动。两者都为 0 时保持原来的自动布局。
 */
export function applyLaunchpadGrid(grid: HTMLElement, metrics: LaunchpadGridMetrics): void {
    grid.style.setProperty('--launchpad-tile', `${metrics.launchpadTile}px`);

    const columns = metrics.launchpadColumns;
    grid.classList.toggle('is-fixed', columns > 0);
    if (columns > 0) grid.style.setProperty('--launchpad-columns', String(columns));
    else grid.style.removeProperty('--launchpad-columns');

    const rows = metrics.launchpadRows;
    grid.classList.toggle('has-row-count', rows > 0);
    if (rows <= 0) {
        rowCounts.delete(grid);
        resizeObserver?.unobserve(grid);
        grid.style.removeProperty('--launchpad-row-height');
        return;
    }
    rowCounts.set(grid, rows);
    // 打开动画、标签条重新渲染都会改变栅格高度，量一次不够准，尺寸一变就重算。
    shareObserver()?.observe(grid);
    applyRowHeight(grid, rows);
}

/** 元素销毁时断开观察，避免观察器一直持有已移除的节点。 */
export function releaseLaunchpadGrid(grid: HTMLElement): void {
    rowCounts.delete(grid);
    resizeObserver?.unobserve(grid);
}
