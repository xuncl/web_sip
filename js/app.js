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
                AppState.update({
                    isLoading: false,
                    showTokenDialog: true,
                    errorMessage: 'Token 无效或已过期，请重新输入'
                });
                return;
            }

            let todayData = result.data;
            let freshStart = false;

            // 2. 当天没有数据，从历史推算
            if (!todayData) {
                const latestData = await GitHubAPI.findLatestData(todayStr);

                if (!latestData) {
                    // 无任何历史：第一天使用
                    const tasks = deriveTodayTasks(null, TASK_TEMPLATE);
                    const totalScore = 0;
                    todayData = { date: todayStr, tasks, totalScore, lastUpdated: null };
                } else {
                    // 有历史数据，计算跨度和模拟
                    const gapDays = dateDiffDays(latestData.date, todayStr);
                    const missedDays = gapDays - 1; // 中间缺失的天数

                    let simResult;
                    if (missedDays <= 0) {
                        // 昨天有数据，正常推导
                        const tasks = deriveTodayTasks(latestData, TASK_TEMPLATE);
                        simResult = { tasks, cumulativeTotal: latestData.totalScore || 0, freshStart: false };
                    } else {
                        // 有 N 天空白，模拟
                        simResult = simulateMissedDays(latestData, TASK_TEMPLATE, missedDays);
                    }

                    if (simResult.freshStart) {
                        todayData = {
                            date: todayStr,
                            tasks: simResult.tasks,
                            totalScore: 0,
                            lastUpdated: null
                        };
                        freshStart = true;
                    } else {
                        todayData = {
                            date: todayStr,
                            tasks: simResult.tasks,
                            totalScore: simResult.cumulativeTotal,
                            lastUpdated: null
                        };
                    }
                }
            } else {
                // 已有当天数据：totalScore 保持原值（是累计值）
                // 不需要重新计算，直接使用存储的值
            }

            // 3. 获取 SHA
            let sha = result.sha;
            if (!sha && Storage.getToken()) {
                sha = await GitHubAPI.getFileSha(todayStr);
            }

            // 4. 更新状态并渲染
            let notice = null;
            if (freshStart) {
                notice = '⚠️ 超过30天未记录，总分已归零重新开始';
            }

            AppState.update({
                tasks: todayData.tasks,
                totalScore: todayData.totalScore,
                fileSha: sha,
                lastUpdated: todayData.lastUpdated,
                isLoading: false,
                isDirty: false,
                errorMessage: notice
            });

            // 5. 缓存到本地
            Storage.setCache(todayStr, todayData);

            // 6. 检查是否需要 Token
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
                AppState.update({
                    tasks: cached.tasks,
                    totalScore: cached.totalScore || calculateTotal(cached.tasks, 0),
                    lastUpdated: cached.lastUpdated,
                    errorMessage: '⚠️ 网络加载失败，使用本地缓存数据'
                });
            }
        }
    }

    // ── 用户操作 ──────────────────────────────────────

    /**
     * 切换任务完成状态（累计总分增量模式）
     */
    function onToggleTask(index, completed) {
        const state = AppState.getSnapshot();
        const task = state.tasks[index];
        const wasCompleted = task.completed;

        // 无变化，跳过
        if (wasCompleted === completed) return;

        let newTotal = state.totalScore;

        if (completed) {
            // 勾选完成 → 加分
            newTotal += task.sipScore;
            if (task.isKeyTask) {
                // 关键任务额外加分（抵消之前的扣分）
                newTotal += task.sipScore;
            }
        } else {
            // 取消勾选 → 扣分
            newTotal -= task.sipScore;
            if (task.isKeyTask) {
                // 关键任务额外扣分（施加惩罚）
                newTotal -= task.sipScore;
            }
        }

        newTotal = Math.max(0, newTotal);

        const tasks = state.tasks.map((t, i) =>
            i === index ? { ...t, completed: completed } : t
        );

        AppState.update({
            tasks: tasks,
            totalScore: newTotal,
            isDirty: true
        });

        saveCache(state.currentDate, tasks, newTotal);
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

        // 构建要保存的数据（totalScore 是累计值）
        const saveData = {
            date: state.currentDate,
            tasks: state.tasks,
            totalScore: state.totalScore,
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

    /**
     * 计算两个日期字符串之间的天数差
     */
    function dateDiffDays(fromStr, toStr) {
        const from = new Date(fromStr + 'T00:00:00');
        const to = new Date(toStr + 'T00:00:00');
        return Math.round((to - from) / (1000 * 60 * 60 * 24));
    }

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
