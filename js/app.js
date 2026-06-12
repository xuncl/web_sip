/**
 * 应用主入口
 *
 * 协调所有模块：初始化 → 加载数据 → 渲染 UI → 响应用户操作
 */
const App = (function() {

    // ── 初始化 ────────────────────────────────────────

    async function init() {
        const todayStr = GitHubAPI.getTodayStr();

        AppState.update({
            currentDate: todayStr,
            isLoading: true,
            errorMessage: null
        });

        try {
            // 1. 尝试加载当天数据
            let result = await GitHubAPI.loadDayData(todayStr);

            if (result.error === 'TOKEN_INVALID') {
                // Token 失效，提示重新输入
                AppState.update({
                    isLoading: false,
                    showTokenDialog: true,
                    errorMessage: 'Token 无效或已过期，请重新输入'
                });
                return;
            }

            let todayData = result.data;

            // 2. 当天没有数据，从历史推算
            if (!todayData) {
                const yesterdayData = await GitHubAPI.findLatestData(todayStr);
                const tasks = deriveTodayTasks(yesterdayData, TASK_TEMPLATE);
                const totalScore = calculateTotal(tasks);

                todayData = {
                    date: todayStr,
                    tasks: tasks,
                    totalScore: totalScore,
                    lastUpdated: null
                };
            } else {
                // 已有数据，重新计算总分（以防手动修改过 JSON）
                todayData.totalScore = calculateTotal(todayData.tasks);
            }

            // 3. 获取 SHA（如果通过 raw 读取的可能没有 sha）
            let sha = result.sha;
            if (!sha && Storage.getToken()) {
                sha = await GitHubAPI.getFileSha(todayStr);
            }

            // 4. 更新状态并渲染
            AppState.update({
                tasks: todayData.tasks,
                totalScore: todayData.totalScore,
                fileSha: sha,
                lastUpdated: todayData.lastUpdated,
                isLoading: false,
                isDirty: false,
                errorMessage: null
            });

            // 5. 缓存到本地
            Storage.setCache(todayStr, todayData);

            // 6. 检查是否需要 Token（第一次使用）
            if (!Storage.getToken()) {
                AppState.update({ showTokenDialog: true });
            }

        } catch (e) {
            console.error('初始化失败:', e);
            AppState.update({
                isLoading: false,
                errorMessage: `加载失败: ${e.message}`
            });

            // 尝试从缓存恢复
            const cached = Storage.getCache(todayStr);
            if (cached) {
                cached.totalScore = calculateTotal(cached.tasks);
                AppState.update({
                    tasks: cached.tasks,
                    totalScore: cached.totalScore,
                    lastUpdated: cached.lastUpdated,
                    errorMessage: '⚠️ 网络加载失败，使用本地缓存数据'
                });
            }
        }
    }

    // ── 用户操作 ──────────────────────────────────────

    /**
     * 切换任务完成状态
     */
    function onToggleTask(index, completed) {
        const state = AppState.getSnapshot();
        const tasks = state.tasks.map((t, i) => {
            if (i === index) {
                return { ...t, completed: completed };
            }
            return t;
        });

        const totalScore = calculateTotal(tasks);

        AppState.update({
            tasks: tasks,
            totalScore: totalScore,
            isDirty: true
        });

        // 同步更新本地缓存
        saveCache(state.currentDate, tasks, totalScore);
    }

    /**
     * 更新备注
     */
    function onUpdateNote(index, note) {
        const state = AppState.getSnapshot();
        const tasks = state.tasks.map((t, i) => {
            if (i === index) {
                return { ...t, note: note };
            }
            return t;
        });

        AppState.update({
            tasks: tasks,
            isDirty: true
        });

        saveCache(state.currentDate, tasks, state.totalScore);
    }

    /**
     * 保存 Token
     */
    async function onSaveToken(token) {
        if (!token) {
            AppState.update({
                errorMessage: '请输入 Token',
                showTokenDialog: true
            });
            return;
        }

        Storage.setToken(token);
        AppState.update({
            showTokenDialog: false,
            errorMessage: null,
            isLoading: true
        });

        // 重新初始化（用新 Token 加载数据）
        await init();
    }

    /**
     * 更新到 GitHub
     */
    async function onUpdate() {
        const state = AppState.getSnapshot();

        if (!Storage.getToken()) {
            AppState.update({ showTokenDialog: true });
            return;
        }

        // 构建要保存的数据
        const saveData = {
            date: state.currentDate,
            tasks: state.tasks,
            totalScore: calculateTotal(state.tasks),
            lastUpdated: new Date().toISOString()
        };

        AppState.update({ isLoading: true, errorMessage: null });

        let sha = state.fileSha;

        // 如果还没有 sha（raw 读取的情况），先获取
        if (!sha) {
            sha = await GitHubAPI.getFileSha(state.currentDate);
        }

        // 保存
        const result = await GitHubAPI.saveDayData(state.currentDate, saveData, sha);

        if (result.success) {
            Storage.setCache(state.currentDate, saveData);
            AppState.update({
                fileSha: result.sha,
                lastUpdated: saveData.lastUpdated,
                totalScore: saveData.totalScore,
                isLoading: false,
                isDirty: false,
                errorMessage: null
            });
        } else if (result.error === 'TOKEN_INVALID') {
            AppState.update({
                isLoading: false,
                showTokenDialog: true,
                errorMessage: 'Token 无效或已过期，请重新输入'
            });
        } else if (result.error === 'CONFLICT') {
            // SHA 冲突：重新获取 sha 后自动重试一次
            const newSha = await GitHubAPI.getFileSha(state.currentDate);
            if (newSha) {
                const retryResult = await GitHubAPI.saveDayData(state.currentDate, saveData, newSha);
                if (retryResult.success) {
                    Storage.setCache(state.currentDate, saveData);
                    AppState.update({
                        fileSha: retryResult.sha,
                        lastUpdated: saveData.lastUpdated,
                        totalScore: saveData.totalScore,
                        isLoading: false,
                        isDirty: false,
                        errorMessage: null
                    });
                    return;
                }
            }
            AppState.update({
                isLoading: false,
                errorMessage: '保存失败：文件冲突，请刷新页面后重试'
            });
        } else {
            AppState.update({
                isLoading: false,
                errorMessage: `保存失败: ${result.error}`
            });
        }
    }

    // ── 内部工具 ──────────────────────────────────────

    function saveCache(dateStr, tasks, totalScore) {
        Storage.setCache(dateStr, {
            date: dateStr,
            tasks: tasks,
            totalScore: totalScore,
            lastUpdated: new Date().toISOString()
        });
    }

    // ── 注册状态变更监听 ──────────────────────────────

    AppState.onChange((state) => {
        UI.render(state);
    });

    return { init, onToggleTask, onUpdateNote, onSaveToken, onUpdate };

})();

// ── 页面加载时启动 ────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    UI.init();
    App.init();
});
