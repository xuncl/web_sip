/**
 * 应用状态管理
 *
 * 简单的观察者模式：state 变更时通知 UI 重新渲染
 */
const AppState = (function() {

    let state = {
        currentDate: null,
        tasks: [],
        totalScore: 0,
        fileSha: null,
        isDirty: false,
        lastUpdated: null,
        isLoading: false,
        errorMessage: null,
        showTokenDialog: false,
        showImportDialog: false
    };

    const listeners = [];

    function onChange(fn) {
        listeners.push(fn);
    }

    function notify() {
        // 浅拷贝一份传给监听者，避免外部直接修改内部状态
        const snapshot = { ...state, tasks: [...state.tasks] };
        listeners.forEach(fn => {
            try { fn(snapshot); } catch (e) { console.error('状态监听器错误:', e); }
        });
    }

    function update(updates) {
        Object.assign(state, updates);
        notify();
    }

    function get(key) {
        return state[key];
    }

    function getSnapshot() {
        return { ...state, tasks: [...state.tasks] };
    }

    return { onChange, update, get, getSnapshot };

})();
