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

    // ── 日期导航 ──────────────────────────────────────

    /**
     * 跳转到指定日期，加载并渲染该日数据
     */
    async function navigateToDate(dateStr) {
        const todayStr = GitHubAPI.getTodayStr();

        AppState.update({ isLoading: true, errorMessage: null });

        try {
            // 1. 尝试加载该日期已有数据
            const result = await GitHubAPI.loadDayData(dateStr);

            if (result.error === 'TOKEN_INVALID') {
                AppState.update({
                    isLoading: false,
                    showTokenDialog: true,
                    errorMessage: 'Token 无效或已过期，请重新输入'
                });
                return;
            }

            let pageData;

            if (result.data) {
                // 已有 JSON，直接使用
                pageData = result.data;
            } else {
                // 没有数据，尝试从更早的历史推导
                const earlierData = await GitHubAPI.findLatestData(dateStr);

                if (earlierData) {
                    const gapDays = dateDiffDays(earlierData.date, dateStr);
                    const missedDays = gapDays - 1;

                    if (missedDays > 30) {
                        pageData = {
                            date: dateStr,
                            tasks: null, // 标记无数据
                            totalScore: 0,
                            lastUpdated: null
                        };
                    } else if (missedDays <= 0) {
                        const tasks = deriveTodayTasks(earlierData, TASK_TEMPLATE);
                        pageData = {
                            date: dateStr,
                            tasks: tasks,
                            totalScore: earlierData.totalScore || 0,
                            lastUpdated: null
                        };
                    } else {
                        const simResult = simulateMissedDays(earlierData, TASK_TEMPLATE, missedDays);
                        if (simResult.freshStart) {
                            pageData = {
                                date: dateStr,
                                tasks: null,
                                totalScore: 0,
                                lastUpdated: null
                            };
                        } else {
                            pageData = {
                                date: dateStr,
                                tasks: simResult.tasks,
                                totalScore: simResult.cumulativeTotal,
                                lastUpdated: null
                            };
                        }
                    }
                } else {
                    // 无任何历史
                    pageData = {
                        date: dateStr,
                        tasks: dateStr >= todayStr ? deriveTodayTasks(null, TASK_TEMPLATE) : null,
                        totalScore: 0,
                        lastUpdated: null
                    };
                }
            }

            // 获取 SHA（用于后续更新）
            let sha = result.sha;
            if (!sha && Storage.getToken()) {
                sha = await GitHubAPI.getFileSha(dateStr);
            }

            // 如果是今天且无数据，需要检查是否需要补录
            let notice = null;
            if (!result.data && dateStr === todayStr && pageData.tasks) {
                // 检查是不是中断了多天
                const latestData = await GitHubAPI.findLatestData(todayStr);
                if (latestData) {
                    const gapDays = dateDiffDays(latestData.date, todayStr);
                    const missedDays = gapDays - 1;
                    if (missedDays > 0 && missedDays <= 30) {
                        // 触发了模拟，提示但没有补录（导航模式不自动补录）
                        notice = `⚠️ 距上次记录 ${gapDays} 天，数据为模拟生成`;
                    }
                }
            }

            AppState.update({
                currentDate: dateStr,
                tasks: pageData.tasks || [],
                totalScore: pageData.totalScore,
                fileSha: sha,
                lastUpdated: pageData.lastUpdated,
                isLoading: false,
                isDirty: false,
                errorMessage: (pageData.tasks === null && dateStr < todayStr)
                    ? `📅 ${dateStr} 无记录（可能超过30天未记录）`
                    : notice
            });

            Storage.setCache(dateStr, pageData);

        } catch (e) {
            console.error('导航失败:', e);
            AppState.update({
                isLoading: false,
                errorMessage: `加载失败: ${e.message}`
            });
        }
    }

    // ── 级联更新 ──────────────────────────────────────

    /**
     * 保存历史数据后，向前级联更新到今天
     * 每一中间日重新推导并保存
     */
    async function cascadeRegenerate(fromDateStr) {
        const todayStr = GitHubAPI.getTodayStr();
        const token = Storage.getToken();
        if (!token) return;

        // 如果是今天，无需级联
        if (fromDateStr === todayStr) return;

        // 加载刚保存的起始日数据
        let fromResult = await GitHubAPI.loadDayData(fromDateStr);
        if (!fromResult.data) return;

        let prevData = fromResult.data;
        let prevDate = fromDateStr;

        // 逐日向前更新
        while (prevDate < todayStr) {
            const nextDate = dateOffset(prevDate, 1);

            // 推导下一天
            const nextTasks = deriveTodayTasks(prevData, TASK_TEMPLATE);
            const dayDelta = calculateTotal(nextTasks, 0); // 仅当天的贡献
            const nextTotal = Math.max(0, (prevData.totalScore || 0) + dayDelta);

            const nextData = {
                date: nextDate,
                tasks: nextTasks,
                totalScore: nextTotal,
                lastUpdated: new Date().toISOString()
            };

            // 获取 SHA（已有文件需要）
            const sha = await GitHubAPI.getFileSha(nextDate);

            // 保存
            const saveResult = await GitHubAPI.saveDayData(nextDate, nextData, sha);
            if (saveResult.error === 'TOKEN_INVALID') {
                Storage.clearToken();
                throw new Error('TOKEN_INVALID');
            }
            if (!saveResult.success) {
                console.warn(`级联更新 ${nextDate} 保存失败:`, saveResult.error);
            }

            prevData = nextData;
            prevDate = nextDate;
        }

        // 返回今天的数据
        return prevData;
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

            const todayStr = GitHubAPI.getTodayStr();

            // 保存的是历史数据？级联更新到今天
            if (state.currentDate < todayStr) {
                try {
                    const todayData = await cascadeRegenerate(state.currentDate);
                    if (todayData) {
                        // 获取今天的 SHA 并跳转
                        const todaySha = await GitHubAPI.getFileSha(todayStr);
                        AppState.update({
                            currentDate: todayStr,
                            tasks: todayData.tasks,
                            totalScore: todayData.totalScore,
                            fileSha: todaySha,
                            lastUpdated: todayData.lastUpdated,
                            isLoading: false,
                            isDirty: false,
                            errorMessage: null
                        });
                        Storage.setCache(todayStr, todayData);
                        return;
                    }
                } catch (e) {
                    if (e.message === 'TOKEN_INVALID') {
                        AppState.update({
                            isLoading: false,
                            showTokenDialog: true,
                            errorMessage: 'Token 无效，级联更新中断。请重新输入 Token'
                        });
                        return;
                    }
                    AppState.update({
                        isLoading: false,
                        errorMessage: `级联更新失败: ${e.message}`
                    });
                    return;
                }
            }

            // 正常保存（今天）
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

    /**
     * 导入笔记：解析 Markdown 文本，匹配任务名，填写备注
     */
    function parseAndImport(text, markCompleted) {
        const state = AppState.getSnapshot();
        const lines = text.split('\n').filter(l => l.trim());
        let tasks = state.tasks.map(t => ({ ...t }));
        let totalScore = state.totalScore;
        let matched = 0;
        const unmatched = [];

        lines.forEach(line => {
            // 清理前缀：- [ ]、- [x]、-、*、数字序号
            let cleaned = line.trim()
                .replace(/^-\s*\[[ x]\]\s*/i, '')
                .replace(/^[-*•]\s+/, '')
                .replace(/^\d+[.)、]\s*/, '');

            // 用 ：或 : 分割任务名和内容
            const sep = cleaned.match(/[：:]/);
            if (!sep) {
                if (cleaned) unmatched.push(cleaned);
                return;
            }

            const taskName = cleaned.substring(0, sep.index).trim();
            const note = cleaned.substring(sep.index + 1).trim();

            if (!taskName || !note) {
                if (cleaned) unmatched.push(cleaned);
                return;
            }

            // 匹配任务：精确 > 包含（取第一个匹配）
            let taskIndex = tasks.findIndex(t => t.name === taskName);
            if (taskIndex < 0) {
                taskIndex = tasks.findIndex(t =>
                    t.name.includes(taskName) || taskName.includes(t.name)
                );
            }

            if (taskIndex >= 0) {
                const task = tasks[taskIndex];
                // 填写备注（追加模式，如果已有内容则用分号隔开）
                const newNote = task.note ? `${task.note}；${note}` : note;
                tasks[taskIndex] = { ...task, note: newNote };

                // 标记完成
                if (markCompleted && !task.completed) {
                    tasks[taskIndex].completed = true;
                    // 增量更新总分
                    totalScore += task.sipScore;
                    if (task.isKeyTask) {
                        totalScore += task.sipScore; // 抵消惩罚
                    }
                    totalScore = Math.max(0, totalScore);
                }
                matched++;
            } else {
                unmatched.push(taskName);
            }
        });

        // 更新状态
        AppState.update({
            tasks: tasks,
            totalScore: totalScore,
            isDirty: true,
            showImportDialog: false
        });

        Storage.setCache(state.currentDate, {
            date: state.currentDate,
            tasks: tasks,
            totalScore: totalScore,
            lastUpdated: new Date().toISOString()
        });

        // 显示结果提示
        let msg = `✅ 已填写 ${matched} 条任务`;
        if (unmatched.length > 0) {
            msg += `，⚠️ ${unmatched.length} 条未匹配: ${unmatched.join('、')}`;
        }
        AppState.update({ errorMessage: msg });

        // 3 秒后清除提示
        setTimeout(() => {
            if (AppState.get('errorMessage') === msg) {
                AppState.update({ errorMessage: null });
            }
        }, 4000);
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

    return { init, navigateToDate, onToggleTask, onUpdateNote, onSaveToken, onUpdate, parseAndImport };

})();

// ── 页面加载时启动 ────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    UI.init();
    App.init();
});
