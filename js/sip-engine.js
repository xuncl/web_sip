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
 * 根据当天任务的完成状态计算总分
 *
 * @param {Array} tasks - 任务列表（含 completed 和 sipScore 字段）
 * @returns {number} 总分（下限为 0）
 */
function calculateTotal(tasks) {
    let total = 0;
    tasks.forEach(task => {
        if (task.completed) {
            // 完成：加分
            total += task.sipScore;
        } else if (task.isKeyTask) {
            // 关键任务未完成：扣分
            total -= task.sipScore;
        }
        // 非关键任务未完成：不扣不加（豁免）
    });
    return Math.max(0, total);
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
