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
     * 通过 raw.githubusercontent.com 获取某天数据（公开访问，无需 Token）
     */
    function fetchRaw(dateStr) {
        const url = `${CONFIG.rawBase}/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${CONFIG.dataPath}/${dateStr}.json`;
        return fetch(url).then(res => {
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
        return fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        }).then(res => {
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
     * 优先用 raw 读取（快），失败时 fallback 到 API 读取
     * 返回 { data, sha } — sha 为 null 代表需要新建文件
     */
    async function loadDayData(dateStr) {
        // 1. 先尝试 raw 直读（速度快，不走认证额度）
        try {
            const data = await fetchRaw(dateStr);
            // raw 读取成功，但不知道 sha，后续写入需要用 API 获取
            // 这里先返回 sha=null 表示"未知"，写入前再获取
            return { data: data, sha: null };
        } catch (e) {
            // raw 404，尝试 API 读取
        }

        // 2. 检查 Token，有则走 API
        const token = Storage.getToken();
        if (token) {
            try {
                return await fetchWithAuth(dateStr);
            } catch (e) {
                if (e.message === 'TOKEN_INVALID') {
                    return { data: null, sha: null, error: 'TOKEN_INVALID' };
                }
                if (e.message !== 'NOT_FOUND') {
                    console.error('API 读取失败:', e);
                }
            }
        }

        // 3. 当天文件不存在
        return { data: null, sha: null, error: 'NOT_FOUND' };
    }

    /**
     * 回溯查找最近的已有数据（最多 30 天）
     * 用于当天 JSON 不存在时推算今天的 sipScore
     */
    async function findLatestData(dateStr) {
        for (let i = 1; i <= CONFIG.maxBacktrackDays; i++) {
            const prevDate = getDateStrBefore(dateStr, i);
            try {
                const data = await fetchRaw(prevDate);
                return data;
            } catch (e) {
                // 404，继续往前找
                continue;
            }
        }
        return null;
    }

    /**
     * 获取文件 SHA（更新时需要）
     * 只在 raw 读取成功但需要 SHA 时调用
     */
    async function getFileSha(dateStr) {
        const token = Storage.getToken();
        if (!token) return null;

        const url = `${CONFIG.apiBase}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${CONFIG.dataPath}/${dateStr}.json`;
        try {
            const res = await fetch(url, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json'
                }
            });
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
