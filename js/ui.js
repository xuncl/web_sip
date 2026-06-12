/**
 * UI 渲染与事件绑定
 *
 * 所有 DOM 操作集中在这里，根据 AppState 渲染整个页面。
 */
const UI = (function() {

    // ── DOM 引用缓存 ──────────────────────────────────

    let rootEl = null;

    function init() {
        rootEl = document.getElementById('app-root');
        if (!rootEl) {
            console.error('找不到 #app-root 元素');
        }
    }

    // ── 主渲染 ────────────────────────────────────────

    function render(state) {
        if (!rootEl) init();
        if (!rootEl) return;

        if (state.isLoading) {
            rootEl.innerHTML = renderLoading();
            return;
        }

        const headerHtml = renderHeader(state);
        const tasksHtml = renderTaskList(state.tasks);
        const footerHtml = renderFooter(state);
        const dialogHtml = state.showTokenDialog ? renderTokenDialog(state.errorMessage) : '';

        rootEl.innerHTML = `
            <div class="app-container">
                ${headerHtml}
                <main class="main-content">
                    ${state.errorMessage && !state.showTokenDialog ? renderErrorBanner(state.errorMessage) : ''}
                    ${tasksHtml}
                </main>
                ${footerHtml}
            </div>
            ${dialogHtml}
        `;

        bindEvents(state);
    }

    // ── 各部分渲染 ────────────────────────────────────

    function renderLoading() {
        return `
            <div class="loading-container">
                <div class="spinner"></div>
                <p>加载中...</p>
            </div>
        `;
    }

    function renderHeader(state) {
        const dateObj = new Date(state.currentDate + 'T00:00:00');
        const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
        const weekDay = weekDays[dateObj.getDay()];
        const dateDisplay = `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日 星期${weekDay}`;

        const completedCount = state.tasks.filter(t => t.completed).length;
        const totalCount = state.tasks.length;

        return `
            <header class="app-header">
                <div class="header-top">
                    <h1 class="app-title">🏠 Web SIP</h1>
                    <span class="header-date">${dateDisplay}</span>
                </div>
                <div class="header-score">
                    <span class="score-label">今日总分</span>
                    <span class="score-value">${state.totalScore} 分</span>
                    <span class="score-progress">完成 ${completedCount}/${totalCount}</span>
                </div>
                <div class="header-actions">
                    <button class="btn btn-primary btn-update" id="btn-update">
                        🔄 更新到 GitHub
                    </button>
                    <button class="btn btn-secondary btn-token" id="btn-token">
                        🔑 设置 Token
                    </button>
                </div>
                ${state.isDirty ? '<div class="dirty-hint">⚠️ 有未保存的更改</div>' : ''}
                ${state.lastUpdated ? `<div class="update-time">最后更新: ${formatTime(state.lastUpdated)}</div>` : ''}
            </header>
        `;
    }

    function renderTaskList(tasks) {
        if (!tasks || tasks.length === 0) {
            return '<div class="empty-state">暂无任务</div>';
        }

        const cards = tasks.map((task, index) => renderTaskCard(task, index)).join('');
        return `<div class="task-list">${cards}</div>`;
    }

    function renderTaskCard(task, index) {
        // 确定视觉状态
        let cardClass = 'task-card';
        let starHtml = '';
        let sipHtml = '';
        let statusHtml = '';
        let streakLabel = '';

        if (task.isKeyTask) {
            cardClass += ' key-task';
            starHtml = '<span class="task-star" title="关键任务（必须完成）">⭐</span>';
        }

        if (task.completed) {
            cardClass += ' completed';
            sipHtml = `<span class="task-sip positive">SIP +${task.sipScore}</span>`;
            statusHtml = `
                <label class="checkbox-label checked">
                    <input type="checkbox" class="task-checkbox" data-index="${index}" checked>
                    <span class="checkmark"></span>
                    已完成
                </label>
            `;
            streakLabel = `连击: ${getStreakDays(task)} 天`;
        } else if (task.isKeyTask) {
            cardClass += ' penalty';
            sipHtml = `<span class="task-sip negative">SIP -${task.sipScore}</span>`;
            statusHtml = `
                <label class="checkbox-label">
                    <input type="checkbox" class="task-checkbox" data-index="${index}">
                    <span class="checkmark"></span>
                    未完成 <span class="penalty-warn">⚠️ 将扣分</span>
                </label>
            `;
            streakLabel = `中断 → 重置为 ${task.baseScore}`;
        } else {
            cardClass += ' exempted';
            sipHtml = `<span class="task-sip neutral">SIP 不变</span>`;
            statusHtml = `
                <label class="checkbox-label">
                    <input type="checkbox" class="task-checkbox" data-index="${index}">
                    <span class="checkmark"></span>
                    未完成 <span class="exempt-badge">🛡️豁免</span>
                </label>
            `;
            streakLabel = `保持: ${task.sipScore} 分`;
        }

        const progressPercent = Math.min(100, Math.round((task.sipScore / task.maxScore) * 100));

        return `
            <div class="${cardClass}">
                <div class="task-main">
                    <div class="task-info">
                        <div class="task-name-row">
                            ${starHtml}
                            <span class="task-name">${escapeHtml(task.name)}</span>
                        </div>
                        <div class="task-stats">
                            ${sipHtml}
                            <span class="task-streak">${streakLabel}</span>
                            <span class="task-cap">封顶: ${task.maxScore}</span>
                        </div>
                    </div>
                    <div class="task-status">
                        ${statusHtml}
                    </div>
                </div>
                <div class="task-progress-bar">
                    <div class="progress-fill ${task.completed ? 'fill-green' : (task.isKeyTask && !task.completed ? 'fill-red' : 'fill-gray')}" style="width: ${progressPercent}%"></div>
                </div>
                <div class="task-note-row">
                    <input type="text" class="task-note-input" data-index="${index}" placeholder="备注（可选）" value="${escapeHtml(task.note || '')}">
                </div>
            </div>
        `;
    }

    function renderFooter(state) {
        const doneCount = state.tasks.filter(t => t.completed).length;
        const total = state.tasks.length;
        const keyDone = state.tasks.filter(t => t.isKeyTask && t.completed).length;
        const keyTotal = state.tasks.filter(t => t.isKeyTask).length;

        return `
            <footer class="app-footer">
                <span>完成 ${doneCount}/${total} 项</span>
                <span class="footer-divider">|</span>
                <span>关键任务 ${keyDone}/${keyTotal}</span>
                <span class="footer-divider">|</span>
                <span>Powered by GitHub Pages</span>
            </footer>
        `;
    }

    function renderErrorBanner(message) {
        return `<div class="error-banner">⚠️ ${escapeHtml(message)}</div>`;
    }

    function renderTokenDialog(errorMsg) {
        return `
            <div class="dialog-overlay" id="token-dialog">
                <div class="dialog-card">
                    <h2>🔑 请输入 GitHub Token</h2>
                    <p class="dialog-desc">
                        Token 需要 <code>repo</code> 权限，用于读写任务数据。<br>
                        仅在浏览器本地存储，不会上传到任何服务器。
                    </p>
                    ${errorMsg ? `<div class="error-banner">${escapeHtml(errorMsg)}</div>` : ''}
                    <input type="password" class="dialog-input" id="token-input"
                           placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                           autocomplete="off">
                    <div class="dialog-actions">
                        <a href="https://github.com/settings/tokens?type=beta"
                           target="_blank" class="btn btn-link">
                            📋 创建 Token →
                        </a>
                        <div class="dialog-buttons">
                            <button class="btn btn-secondary" id="btn-cancel-token">取消</button>
                            <button class="btn btn-primary" id="btn-save-token">保存</button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    // ── 事件绑定 ──────────────────────────────────────

    function bindEvents(state) {
        // 更新按钮
        const btnUpdate = document.getElementById('btn-update');
        if (btnUpdate) {
            btnUpdate.addEventListener('click', () => {
                App.onUpdate();
            });
        }

        // Token 设置按钮
        const btnToken = document.getElementById('btn-token');
        if (btnToken) {
            btnToken.addEventListener('click', () => {
                AppState.update({ showTokenDialog: true, errorMessage: null });
            });
        }

        // 任务复选框
        document.querySelectorAll('.task-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                const index = parseInt(e.target.dataset.index);
                App.onToggleTask(index, e.target.checked);
            });
        });

        // 备注输入
        document.querySelectorAll('.task-note-input').forEach(input => {
            input.addEventListener('change', (e) => {
                const index = parseInt(e.target.dataset.index);
                App.onUpdateNote(index, e.target.value);
            });
            // 实时更新 state（不重新渲染，只标记脏）
            input.addEventListener('input', (e) => {
                const index = parseInt(e.target.dataset.index);
                const tasks = AppState.get('tasks');
                if (tasks[index]) {
                    tasks[index].note = e.target.value;
                }
            });
        });

        // Token 对话框
        const btnSaveToken = document.getElementById('btn-save-token');
        const btnCancelToken = document.getElementById('btn-cancel-token');
        const dialogOverlay = document.getElementById('token-dialog');

        if (btnSaveToken) {
            btnSaveToken.addEventListener('click', () => {
                const input = document.getElementById('token-input');
                const token = input ? input.value.trim() : '';
                App.onSaveToken(token);
            });
        }

        if (btnCancelToken) {
            btnCancelToken.addEventListener('click', () => {
                AppState.update({ showTokenDialog: false, errorMessage: null });
            });
        }

        // 点击遮罩关闭
        if (dialogOverlay) {
            dialogOverlay.addEventListener('click', (e) => {
                if (e.target === dialogOverlay) {
                    AppState.update({ showTokenDialog: false, errorMessage: null });
                }
            });
        }

        // Token 输入框回车保存
        const tokenInput = document.getElementById('token-input');
        if (tokenInput) {
            tokenInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    App.onSaveToken(tokenInput.value.trim());
                }
            });
        }
    }

    // ── 工具函数 ──────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch (e) {
            return '';
        }
    }

    return { init, render };

})();
