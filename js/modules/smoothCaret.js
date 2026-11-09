// 平滑光标：用可动画的覆盖层替代编辑器原生插入符。
let smoothCaretActive = false;
let caretElement = null;
let frameId = null;
let layerObserver = null;

const findTextNode = (node, fromEnd = false) => {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ? node : null;

    const children = node.childNodes;
    for (let index = fromEnd ? children.length - 1 : 0;
        fromEnd ? index >= 0 : index < children.length;
        index += fromEnd ? -1 : 1) {
        const textNode = findTextNode(children[index], fromEnd);
        if (textNode) return textNode;
    }
    return null;
};

const getAdjacentTextPosition = (range, after) => {
    const container = range.startContainer;
    const offset = range.startOffset;

    if (container.nodeType === Node.TEXT_NODE) {
        const length = container.nodeValue?.length || 0;
        if (after && offset < length) return { node: container, offset };
        if (!after && offset > 0) return { node: container, offset: offset - 1 };
        return null;
    }

    if (container.nodeType !== Node.ELEMENT_NODE) return null;
    const child = container.childNodes[after ? offset : offset - 1];
    const textNode = findTextNode(child, !after);
    if (!textNode) return null;
    return {
        node: textNode,
        offset: after ? 0 : textNode.nodeValue.length - 1
    };
};

const getTextCaretRect = (range) => {
    // 优先采用后一个字符，换行边界处它所在的行才是光标实际所在行。
    for (const after of [true, false]) {
        const position = getAdjacentTextPosition(range, after);
        if (!position) continue;

        const probe = document.createRange();
        try {
            probe.setStart(position.node, position.offset);
            probe.setEnd(position.node, position.offset + 1);
            const rect = Array.from(probe.getClientRects()).find(item => item.height > 0);
            if (rect) {
                return {
                    left: after ? rect.left : rect.right,
                    top: rect.top,
                    width: 0,
                    height: rect.height
                };
            }
        } finally {
            probe.detach?.();
        }
    }
    return null;
};

const getEmptyInlineCaretRect = (element) => {
    const inline = element.closest('span[data-type~="code"], code:not(.hljs)');
    if (!inline || inline.textContent) return null;

    const rect = inline.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const style = getComputedStyle(inline);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const height = Number.isFinite(lineHeight) ? Math.min(lineHeight, rect.height) : rect.height;
    return {
        left: rect.left
            + (Number.parseFloat(style.borderLeftWidth) || 0)
            + (Number.parseFloat(style.paddingLeft) || 0),
        top: rect.top + Math.max(0, (rect.height - height) / 2),
        width: 0,
        height
    };
};

// 折叠 Range 落在块边界时会返回覆盖整个块的矩形（代码块顶部、空容器等），
// 直接采用会把插入符拉成一条贯穿整块的长竖线。以所在行的行高为基准做尺寸校验。
const isCaretSizedRect = (rect, element) => {
    if (!rect || !(rect.height > 0)) return false;
    const style = getComputedStyle(element);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const line = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fontSize * 1.5;
    return rect.width <= Math.max(4, line * 0.6) && rect.height <= line * 1.8 + 2;
};

const getCaretInfo = () => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element?.closest?.('.protyle-wysiwyg[contenteditable="true"]')) return null;

    // 代码块顶部工具栏、块标、块属性等 contenteditable="false" 区域并非可输入位置，
    // 但点击它们时浏览器仍会把选区落在其中的文本节点上，不能据此绘制插入符。
    const editableHost = element.closest('[contenteditable]');
    if (editableHost && editableHost.getAttribute('contenteditable') !== 'true') return null;

    // 分割线节点的 Range 会覆盖整个块，不能直接作为插入符矩形使用。
    const thematicBreak = element.closest('[data-type="NodeThematicBreak"]');
    if (thematicBreak) {
        const breakRect = thematicBreak.getBoundingClientRect();
        const style = getComputedStyle(thematicBreak);
        const fontSize = Number.parseFloat(style.fontSize) || 16;
        const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.5;
        return {
            rect: {
                left: breakRect.right - 1,
                top: breakRect.top + Math.max(0, (breakRect.height - lineHeight) / 2),
                height: lineHeight
            },
            color: style.color
        };
    }

    // 折叠 Range 在行内元素边界可能返回整行行首的伪矩形。相邻字符的边缘
    // 更接近浏览器原生插入符，并且能覆盖 Alt+G 改写出的 code/span 容器边界。
    // 所有候选矩形统一做单行尺寸校验，块级矩形一律交给下方的空块兜底处理。
    const candidates = [
        getTextCaretRect(range),
        getEmptyInlineCaretRect(element),
        range.getBoundingClientRect(),
        ...Array.from(range.getClientRects())
    ];
    const caretRect = candidates.find(item => isCaretSizedRect(item, element));
    if (caretRect) return { rect: caretRect, color: getComputedStyle(element).color };

    // 空块或异常矩形：优先使用内部 spellcheck 行，避免外层块的边距影响位置。
    // 表格空单元格：spellcheck 可能命中单元格外的表格容器，需以 td/th 为界，否则光标会落到表格左上角。
    const cell = element.closest('td, th');
    let line = element.closest('[spellcheck]');
    if (!line || (cell && !cell.contains(line))) {
        line = cell
            || element.closest('[contenteditable="true"]')
            || element.closest('[data-node-id]');
    }
    if (!line) return null;
    const lineRect = line.getBoundingClientRect();
    if (lineRect.height <= 0) return null;
    const style = getComputedStyle(line);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const height = Number.isFinite(lineHeight) && lineHeight > 0
        ? lineHeight
        : (Number.parseFloat(style.fontSize) || 16) * 1.5;
    // 兜底命中了整个编辑器或多行容器时，左上角并非真实插入符位置，直接隐藏。
    if (lineRect.height > height * 2.5) return null;
    return {
        rect: {
            left: lineRect.left + Number.parseFloat(style.paddingLeft || 0),
            top: lineRect.top + Number.parseFloat(style.paddingTop || 0),
            height
        },
        color: style.color
    };
};

// 菜单、联想框、浮动工具条等打开时不应继续绘制插入符，否则高层级覆盖层会
// 盖在菜单选项文字上。浮层隐藏方式不统一（fn__none / display:none / 直接移除），
// 因此以实际渲染矩形为准判断可见性。
const FLOATING_SELECTOR = [
    '#commonMenu',
    '.b3-menu',
    '.hint--menu',
    '.protyle-hint',
    '.protyle-toolbar',
    '.protyle-util',
    '.b3-dialog--open'
].join(',');

const hasFloatingLayer = () => {
    for (const layer of document.querySelectorAll(FLOATING_SELECTOR)) {
        if (layer.classList.contains('fn__none')) continue;
        const style = getComputedStyle(layer);
        if (style.display === 'none' || style.visibility === 'hidden'
            || Number.parseFloat(style.opacity) === 0) continue;
        if (layer.getClientRects().length) return true;
    }
    return false;
};

const hideCaret = () => caretElement?.classList.remove('savor-smooth-caret--visible');

const updateCaret = () => {
    frameId = null;
    if (!smoothCaretActive || document.hidden || !document.hasFocus() || hasFloatingLayer()) return hideCaret();
    const caret = getCaretInfo();
    if (!caret) return hideCaret();
    caretElement.style.height = `${Math.max(1, caret.rect.height)}px`;
    caretElement.style.backgroundColor = caret.color;
    caretElement.style.transform = `translate3d(${Math.round(caret.rect.left)}px, ${Math.round(caret.rect.top)}px, 0)`;
    caretElement.classList.add('savor-smooth-caret--visible');
};

const scheduleUpdate = () => {
    if (!smoothCaretActive || frameId !== null) return;
    frameId = requestAnimationFrame(updateCaret);
};

export const enableSmoothCaret = () => {
    if (smoothCaretActive) return;
    smoothCaretActive = true;
    caretElement = document.createElement('div');
    caretElement.className = 'savor-smooth-caret';
    caretElement.setAttribute('aria-hidden', 'true');
    document.body.append(caretElement);
    document.documentElement.setAttribute('savor-smooth-caret', 'true');
    document.addEventListener('selectionchange', scheduleUpdate);
    document.addEventListener('input', scheduleUpdate, true);
    document.addEventListener('focusin', scheduleUpdate);
    document.addEventListener('focusout', hideCaret);
    document.addEventListener('visibilitychange', scheduleUpdate);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    document.addEventListener('pointerdown', scheduleUpdate, true);
    document.addEventListener('keydown', scheduleUpdate, true);
    // 菜单、对话框等浮层由思源动态挂载到 body，监听直接子节点增删即可及时收起插入符，
    // 不开启 subtree 以免编辑器内的高频 DOM 变化触发回调。
    if (typeof MutationObserver === 'function') {
        layerObserver = new MutationObserver(scheduleUpdate);
        layerObserver.observe(document.body, { childList: true });
    }
    scheduleUpdate();
};

export const disableSmoothCaret = () => {
    if (!smoothCaretActive) return;
    smoothCaretActive = false;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    document.removeEventListener('selectionchange', scheduleUpdate);
    document.removeEventListener('input', scheduleUpdate, true);
    document.removeEventListener('focusin', scheduleUpdate);
    document.removeEventListener('focusout', hideCaret);
    document.removeEventListener('visibilitychange', scheduleUpdate);
    window.removeEventListener('resize', scheduleUpdate);
    window.removeEventListener('scroll', scheduleUpdate, true);
    document.removeEventListener('pointerdown', scheduleUpdate, true);
    document.removeEventListener('keydown', scheduleUpdate, true);
    layerObserver?.disconnect();
    layerObserver = null;
    document.documentElement.removeAttribute('savor-smooth-caret');
    caretElement?.remove();
    caretElement = null;
};

export const initSmoothCaretModule = () => {
    window.enableSmoothCaret = enableSmoothCaret;
    window.disableSmoothCaret = disableSmoothCaret;
    window.cleanupSmoothCaret = cleanupSmoothCaret;
};

export const cleanupSmoothCaret = () => {
    disableSmoothCaret();
    window.enableSmoothCaret = null;
    window.disableSmoothCaret = null;
    window.cleanupSmoothCaret = null;
};
