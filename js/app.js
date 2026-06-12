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

                    if (missedDays <= 0) {
                        // 昨天有数据，正常推导
                        const tasks = deriveTodayTasks(latestData, TASK_TEMPLATE);
                        todayData = {
                            date: todayStr,
                            tasks: tasks,
                            totalScore: latestData.totalScore || 0,
                            lastUpdated: null
                        };
                    } else if (missedDays > 30) {
                        // 超过 30 天：全部归零
                        freshStart = true;
                        const tasks = TASK_TEMPLATE.map(tpl => ({
                            id: tpl.id, name: tpl.name,
                            baseScore: tpl.baseScore, increment: tpl.increment,
                            maxScore: tpl.maxScore, isKeyTask: tpl.isKeyTask,
                            sipScore: tpl.baseScore, completed: false, note: ''
                        }));
                        todayData = {
                            date: todayStr,
                            tasks: tasks,
                            totalScore: 0,
                            lastUpdated: null
                        };
                    } else {
                        // 1~30 天缺失：逐日模拟并补录 JSON 到 GitHub
                        try {
                            const result = await backfillMissedDays(latestData, missedDays, todayStr);
                            todayData = {
                                date: todayStr,
                                tasks: result.tasks,
                                totalScore: result.totalScore,
                                lastUpdated: null
                            };
                        } catch (e) {
                            if (e.message === 'TOKEN_INVALID') {
                                AppState.update({
                                    isLoading: false,
                                    showTokenDialog: true,
                                    errorMessage: 'Token 无效，补录中断。请重新输入 Token'
                                });
                                return;
                            }
                            throw e;
                        }
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

    /**
     * 获取 N 天后的日期字符串
     */
    function dateOffset(fromStr, days) {
        const d = new Date(fromStr + 'T00:00:00');
        d.setDate(d.getDate() + days);
        return GitHubAPI.formatDate(d);
    }

    /**
     * 补录缺失日期的 JSON 文件（中断后逐日生成并保存）
     * @returns {Object} { tasks, totalScore } — 今天的数据
     */
    async function backfillMissedDays(latestData, missedDays, todayStr) {
        const token = Storage.getToken();
        let prevData = latestData;
        let cumulativeTotal = latestData.totalScore || 0;

        for (let d = 0; d < missedDays; d++) {
            const missedDate = dateOffset(latestData.date, d + 1);

            // 检查该日期文件是否已存在（幂等性保证）
            let dayData = null;
            let daySha = null;

            if (token) {
                const existing = await GitHubAPI.loadDayData(missedDate);
                if (existing.data) {
                    // 文件已存在，直接复用
                    dayData = existing.data;
                    daySha = existing.sha;
                }
            }

            if (!dayData) {
                // 生成该日数据（全部未完成）
                const dayTasks = deriveTodayTasks(prevData, TASK_TEMPLATE);

                let dayPenalty = 0;
                dayTasks.forEach(t => {
                    if (t.isKeyTask) dayPenalty += t.sipScore;
                });

                cumulativeTotal = Math.max(0, cumulativeTotal - dayPenalty);

                dayData = {
                    date: missedDate,
                    tasks: dayTasks.map(t => ({ ...t, completed: false })),
                    totalScore: cumulativeTotal,
                    lastUpdated: new Date().toISOString()
                };

                // 有 Token 则保存到 GitHub
                if (token) {
                    const saveResult = await GitHubAPI.saveDayData(missedDate, dayData, null);
                    if (saveResult.error === 'TOKEN_INVALID') {
                        Storage.clearToken();
                        throw new Error('TOKEN_INVALID');
                    }
                    if (!saveResult.success) {
                        console.warn(`补录 ${missedDate} 保存失败:`, saveResult.error);
                    }
                }
            } else {
                // 使用已有文件的累计总分
                cumulativeTotal = dayData.totalScore || cumulativeTotal;
            }

            prevData = dayData;

            // 显示进度
            AppState.update({
                isLoading: true,
                errorMessage: `📝 正在补录缺失数据 (${d + 1}/${missedDays}) — ${missedDate}`
            });
        }

        // 补录完成后，推导今天
        const todayTasks = deriveTodayTasks(prevData, TASK_TEMPLATE);
        return { tasks: todayTasks, totalScore: cumulativeTotal };
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
