/**
 * GitHub API 封装
 *
 * 通过 GitHub Contents API 读写仓库中的 JSON 数据文件。
 * 读取走 raw.githubusercontent.com（无需认证，速度快），
 * 写入走 api.github.com（需要 Token 认证）。
 */

const GitHubAPI = (function() {

    // ── 工具函数 ──────────────────────────────────────

    /**
     * 获取今天的日期字符串（本地时区）
     */
    function getTodayStr() {
        const now = new Date();
        return formatDate(now);
    }

    /**
     * 格式化 Date 对象为 YYYY-MM-DD
     */
    function formatDate(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * 获取 N 天前的日期字符串
     */
    function getDateStrBefore(dateStr, days) {
        const date = new Date(dateStr + 'T00:00:00');
        date.setDate(date.getDate() - days);
        return formatDate(date);
    }

    /**
     * UTF-8 字符串 → Base64
     */
    function utf8ToBase64(str) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Base64 → UTF-8 字符串
     */
    function base64ToUtf8(base64) {
        // GitHub API 返回的 base64 可能含换行，需清理
        const cleaned = base64.replace(/\s/g, '');
        try {
            const binary = atob(cleaned);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new TextDecoder().decode(bytes);
        } catch (e) {
            console.error('Base64 解码失败:', e);
            return null;
        }
    }

    // ── 读取 ──────────────────────────────────────────

    /**
     * 带超时的 fetch 封装
     */
    function fetchWithTimeout(url, options, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        return fetch(url, { ...options, signal: controller.signal }).finally(() => {
            clearTimeout(timer);
        });
    }

    /**
     * 判断是否为网络层错误（连接失败、DNS 失败等，非 HTTP 错误）
     */
    function isNetworkError(err) {
        return err.name === 'TypeError' || err.name === 'AbortError' ||
               err.message === 'Failed to fetch' ||
               err.message.includes('NetworkError') ||
               err.message.includes('network');
    }

    /**
     * 通过 raw.githubusercontent.com 获取某天数据
     * raw 不稳定的环境下可能失败
     */
    function fetchRaw(dateStr) {
        const url = `${CONFIG.rawBase}/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${CONFIG.dataPath}/${dateStr}.json`;
        return fetchWithTimeout(url, {}, 8000).then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        });
    }

    /**
     * 通过 GitHub API 获取文件内容和 SHA（需要 Token）
     */
    function fetchWithAuth(dateStr) {
        const token = Storage.getToken();
        if (!token) return Promise.reject(new Error('NO_TOKEN'));

        const url = `${CONFIG.apiBase}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataPath}/${dateStr}.json`;
        return fetchWithTimeout(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        }, 10000).then(res => {
            if (res.status === 401) {
                Storage.clearToken();
                throw new Error('TOKEN_INVALID');
            }
            if (res.status === 404) {
                throw new Error('NOT_FOUND');
            }
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            return res.json();
        }).then(apiData => {
            const content = base64ToUtf8(apiData.content);
            if (!content) throw new Error('无法解码文件内容');
            try {
                const data = JSON.parse(content);
                return { data: data, sha: apiData.sha };
            } catch (e) {
                throw new Error('JSON 解析失败');
            }
        });
    }

    /**
     * 加载某天的数据
     * 有 Token 时优先走鉴权 API（更稳定），无 Token 时走 raw
     * 返回 { data, sha } — sha 为 null 代表需要新建文件
     */
    async function loadDayData(dateStr) {
        const token = Storage.getToken();

        // 有 Token：优先 API（更稳定可靠）
        if (token) {
            try {
                return await fetchWithAuth(dateStr);
            } catch (e) {
                if (e.message === 'TOKEN_INVALID') {
                    return { data: null, sha: null, error: 'TOKEN_INVALID' };
                }
                if (e.message === 'NOT_FOUND') {
                    // 文件不存在，fallback 继续
                } else {
                    // API 调用本身失败（网络问题），尝试 raw
                    console.warn('API 读取失败，尝试 raw:', e.message);
                    try {
                        const data = await fetchRaw(dateStr);
                        return { data: data, sha: null };
                    } catch (e2) {
                        // raw 也失败
                    }
                }
            }
        } else {
            // 无 Token：只能走 raw
            try {
                const data = await fetchRaw(dateStr);
                return { data: data, sha: null };
            } catch (e) {
                if (e.message.startsWith('HTTP 404')) {
                    // 文件不存在
                }
            }
        }

        // 当天文件不存在
        return { data: null, sha: null, error: 'NOT_FOUND' };
    }

    /**
     * 回溯查找最近的已有数据（最多 30 天）
     * 有 Token 走鉴权 API，无 Token 走 raw
     * 网络层错误立即停止回溯
     */
    async function findLatestData(dateStr) {
        const token = Storage.getToken();

        // 选择读取策略
        async function tryFetch(prevDate) {
            if (token) {
                try {
                    const result = await fetchWithAuth(prevDate);
                    return result.data;
                } catch (e) {
                    if (e.message === 'TOKEN_INVALID') throw e;
                    if (e.message === 'NOT_FOUND') return null;
                    // 网络错误：快速短路
                    if (isNetworkError(e)) throw new Error('NETWORK_ERROR');
                    return null;
                }
            } else {
                try {
                    return await fetchRaw(prevDate);
                } catch (e) {
                    const msg = e.message || '';
                    if (msg.startsWith('HTTP 404') || msg.startsWith('HTTP 403')) {
                        return null; // 文件不存在，继续
                    }
                    // 网络错误：快速短路
                    if (isNetworkError(e)) throw new Error('NETWORK_ERROR');
                    return null;
                }
            }
        }

        let networkErrors = 0;
        for (let i = 1; i <= CONFIG.maxBacktrackDays; i++) {
            const prevDate = getDateStrBefore(dateStr, i);
            try {
                const data = await tryFetch(prevDate);
                if (data) return data;
            } catch (e) {
                if (e.message === 'TOKEN_INVALID') throw e;
                if (e.message === 'NETWORK_ERROR') {
                    networkErrors++;
                    // 连续 2 次网络错误则停止回溯
                    if (networkErrors >= 2) {
                        console.warn('连续网络错误，停止回溯');
                        return null;
                    }
                }
            }
        }
        return null;
    }

    /**
     * 获取文件 SHA（更新时需要）
     */
    async function getFileSha(dateStr) {
        const token = Storage.getToken();
        if (!token) return null;

        const url = `${CONFIG.apiBase}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataPath}/${dateStr}.json`;
        try {
            const res = await fetchWithTimeout(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            }, 10000);
            if (res.status === 404) return null;  // 文件不存在，无需 sha
            if (!res.ok) return null;
            const data = await res.json();
            return data.sha;
        } catch (e) {
            return null;
        }
    }

    // ── 写入 ──────────────────────────────────────────

    /**
     * 保存当天数据到 GitHub
     */
    async function saveDayData(dateStr, data, sha) {
        const token = Storage.getToken();
        if (!token) return { success: false, error: 'NO_TOKEN' };

        const content = JSON.stringify(data, null, 2);
        const body = {
            message: `📝 Update ${dateStr}`,
            content: utf8ToBase64(content),
            branch: CONFIG.branch
        };

        // 更新已有文件需要 sha
        if (sha) {
            body.sha = sha;
        }

        const url = `${CONFIG.apiBase}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataPath}/${dateStr}.json`;
        try {
            const res = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (res.status === 401) {
                Storage.clearToken();
                return { success: false, error: 'TOKEN_INVALID' };
            }

            if (res.status === 409) {
                // SHA 冲突：文件已被修改，需要重新获取 sha 后重试
                return { success: false, error: 'CONFLICT' };
            }

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                return { success: false, error: errData.message || `HTTP ${res.status}` };
            }

            const result = await res.json();
            return { success: true, sha: result.content.sha };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    // ── 公开 API ──────────────────────────────────────

    return {
        getTodayStr,
        getDateStrBefore,
        loadDayData,
        findLatestData,
        getFileSha,
        saveDayData,
        formatDate
    };

})();
