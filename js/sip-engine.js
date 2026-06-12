/**
 * SIP 得分计算引擎
 *
 * 两个核心纯函数，不依赖 DOM 或任何外部状态。
 * 可以独立在控制台中测试验证。
 */

/**
 * 从昨天的数据推算出今天的任务列表
 *
 * @param {Object|null} yesterdayData - 昨天的完整数据对象（含 tasks 数组），null 表示无历史
 * @param {Array} template - 任务模板数组
 * @returns {Array} 今天的任务列表，含正确的 sipScore 和 completed=false
 */
function deriveTodayTasks(yesterdayData, template) {
    // 第一天，无历史数据：直接用模板初始值
    if (!yesterdayData || !yesterdayData.tasks) {
        return template.map(tpl => ({
            id: tpl.id,
            name: tpl.name,
            baseScore: tpl.baseScore,
            increment: tpl.increment,
            maxScore: tpl.maxScore,
            isKeyTask: tpl.isKeyTask,
            sipScore: tpl.baseScore,
            completed: false,
            note: ''
        }));
    }

    // 构建昨日任务索引
    const yesterdayMap = {};
    yesterdayData.tasks.forEach(t => { yesterdayMap[t.id] = t; });

    // 根据昨天结果推算今天
    return template.map(tpl => {
        const yesterdayTask = yesterdayMap[tpl.id];
        let sipScore;

        if (!yesterdayTask) {
            // 模板中新增的任务（版本升级），使用初始分值
            sipScore = tpl.baseScore;
        } else if (yesterdayTask.completed) {
            // 完成：连击递增，但不超过封顶值
            sipScore = Math.min(
                yesterdayTask.sipScore + yesterdayTask.increment,
                yesterdayTask.maxScore
            );
        } else if (yesterdayTask.isKeyTask) {
            // 关键任务未完成：重置到初始分值
            sipScore = tpl.baseScore;
        } else {
            // 非关键任务未完成（豁免）：分值保持不变
            sipScore = yesterdayTask.sipScore;
        }

        return {
            id: tpl.id,
            name: tpl.name,
            baseScore: tpl.baseScore,
            increment: tpl.increment,
            maxScore: tpl.maxScore,
            isKeyTask: tpl.isKeyTask,
            sipScore: sipScore,
            completed: false,
            note: ''
        };
    });
}

/**
 * 根据当天任务的完成状态，在累计总分基础上计算新总分
 *
 * @param {Array} tasks - 任务列表
 * @param {number} [baseTotal=0] - 累计总分基数（来自历史数据）
 * @returns {number} 新总分（下限为 0）
 */
function calculateTotal(tasks, baseTotal = 0) {
    let total = baseTotal;
    tasks.forEach(task => {
        if (task.completed) {
            total += task.sipScore;
        } else if (task.isKeyTask) {
            total -= task.sipScore;
        }
        // 非关键未完成：不变（豁免）
    });
    return Math.max(0, total);
}

/**
 * 计算某天任务的"当天贡献值"（不计历史基数，用于增量更新）
 *
 * @param {Object} task - 单个任务
 * @returns {number} 该任务对总分的贡献
 */
function taskContribution(task) {
    if (task.completed) return task.sipScore;
    if (task.isKeyTask) return -task.sipScore;
    return 0;
}

/**
 * 模拟若干天未使用应用的后果（严格模式）
 *
 * 每一天所有任务视为未完成，关键任务扣分+重置，非关键豁免。
 * 累计总分逐日递减，下限为 0。
 *
 * @param {Object} lastData - 最近一天的完整数据（含 tasks 和 totalScore）
 * @param {Array} template - 任务模板
 * @param {number} missedDays - 跨越的天数
 * @returns {Object} { tasks, cumulativeTotal, freshStart }
 */
function simulateMissedDays(lastData, template, missedDays) {
    // 无缺失：直接推导今天
    if (missedDays <= 0) {
        const tasks = deriveTodayTasks(lastData, template);
        return {
            tasks: tasks,
            cumulativeTotal: lastData.totalScore || 0,
            freshStart: false
        };
    }

    // 超过 30 天：全部归零，重新开始
    if (missedDays > 30) {
        const tasks = template.map(tpl => ({
            id: tpl.id,
            name: tpl.name,
            baseScore: tpl.baseScore,
            increment: tpl.increment,
            maxScore: tpl.maxScore,
            isKeyTask: tpl.isKeyTask,
            sipScore: tpl.baseScore,
            completed: false,
            note: ''
        }));
        return { tasks, cumulativeTotal: 0, freshStart: true };
    }

    // 1~30 天：逐日模拟"全部未完成"
    let prevData = lastData;
    let cumulativeTotal = lastData.totalScore || 0;

    for (let d = 0; d < missedDays; d++) {
        // 推导缺失日的任务
        const dayTasks = deriveTodayTasks(prevData, template);

        // 关键任务未完成：扣分
        let dayPenalty = 0;
        dayTasks.forEach(task => {
            if (task.isKeyTask) {
                dayPenalty += task.sipScore;
            }
        });

        cumulativeTotal = Math.max(0, cumulativeTotal - dayPenalty);

        // 准备下一天的数据（全部未完成）
        prevData = {
            tasks: dayTasks.map(t => ({ ...t, completed: false }))
        };
    }

    // 最后一轮模拟后的任务即今天的状态
    return {
        tasks: prevData.tasks,
        cumulativeTotal: cumulativeTotal,
        freshStart: false
    };
}

/**
 * 获取某任务的连击天数（基于历史数据推算）
 * 通过 (sipScore - baseScore) / increment 估算连击天数
 *
 * @param {Object} task - 任务对象
 * @returns {number} 估算的连击天数
 */
function getStreakDays(task) {
    if (!task || task.increment <= 0) return 0;
    return Math.max(0, Math.floor((task.sipScore - task.baseScore) / task.increment));
}
