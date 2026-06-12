/**
 * 任务模板定义
 * 每天的新任务都从这个模板生成
 */
const TASK_TEMPLATE = [
    { id: 'work',        name: '工作',     baseScore: 2, increment: 1, maxScore: 15, isKeyTask: true  },
    { id: 'career',      name: '事业',     baseScore: 2, increment: 1, maxScore: 15, isKeyTask: true  },
    { id: 'self-improve',name: '自我提升', baseScore: 2, increment: 1, maxScore: 15, isKeyTask: true  },
    { id: 'family',      name: '家庭生活', baseScore: 2, increment: 1, maxScore: 10, isKeyTask: false },
    { id: 'initiative',  name: '主动性',   baseScore: 2, increment: 1, maxScore: 10, isKeyTask: false },
    { id: 'exercise',    name: '锻炼节食', baseScore: 2, increment: 1, maxScore: 10, isKeyTask: false },
    { id: 'early-rise',  name: '早起',     baseScore: 2, increment: 1, maxScore: 5,  isKeyTask: false },
    { id: 'daily-note',  name: '日摘',     baseScore: 2, increment: 1, maxScore: 5,  isKeyTask: false },
    { id: 'meditation',  name: '思考冥想', baseScore: 2, increment: 1, maxScore: 5,  isKeyTask: false }
];
