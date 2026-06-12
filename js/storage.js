/**
 * localStorage 操作封装
 */

const Storage = (function() {

    /**
     * 获取 GitHub Token
     * @returns {string|null}
     */
    function getToken() {
        return localStorage.getItem(CONFIG.storageKeys.token);
    }

    /**
     * 保存 GitHub Token
     * @param {string} token
     */
    function setToken(token) {
        localStorage.setItem(CONFIG.storageKeys.token, token);
    }

    /**
     * 清除 GitHub Token
     */
    function clearToken() {
        localStorage.removeItem(CONFIG.storageKeys.token);
    }

    /**
     * 获取本地缓存数据
     * @param {string} dateStr - 日期字符串 "YYYY-MM-DD"
     * @returns {Object|null} 缓存的数据，日期不匹配返回 null
     */
    function getCache(dateStr) {
        const cachedDate = localStorage.getItem(CONFIG.storageKeys.cacheDate);
        if (cachedDate !== dateStr) return null;

        const cachedData = localStorage.getItem(CONFIG.storageKeys.cacheData);
        if (!cachedData) return null;

        try {
            return JSON.parse(cachedData);
        } catch (e) {
            return null;
        }
    }

    /**
     * 保存数据到本地缓存
     * @param {string} dateStr - 日期字符串
     * @param {Object} data - 要缓存的数据
     */
    function setCache(dateStr, data) {
        localStorage.setItem(CONFIG.storageKeys.cacheDate, dateStr);
        localStorage.setItem(CONFIG.storageKeys.cacheData, JSON.stringify(data));
    }

    return { getToken, setToken, clearToken, getCache, setCache };

})();
