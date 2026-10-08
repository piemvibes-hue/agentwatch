'use strict';
// Tiny i18n: notification strings. Language = AGENTWATCH_LANG env, else OS locale.
// 'zh' for zh-*, 'en' default. Add languages by extending M.

const M = {
  en: {
    detected: (rule, id) => `agentwatch: detected ${rule} on thread ${id}`,
    scheduled: (time, n, max) => `resume scheduled ${time} (attempt ${n}/${max})`,
    gaveup: (id) => `agentwatch: GAVE UP on ${id}`,
    gaveupDetail: (rule, n) => `${rule}: ${n} resume attempts produced no activity. Manual check needed.`,
    recovered: (id) => `agentwatch: ${id} recovered`,
    recoveredDetail: () => 'thread is producing events again',
    alert: (rule, id) => `agentwatch: ${rule} on ${id}`,
  },
  zh: {
    detected: (rule, id) => `agentwatch：线程 ${id} 检测到 ${rule}`,
    scheduled: (time, n, max) => `已排定 ${time} 自动续跑（第 ${n}/${max} 次）`,
    gaveup: (id) => `agentwatch：线程 ${id} 抢救无效`,
    gaveupDetail: (rule, n) => `${rule}：${n} 次续跑都没有恢复产出，需要人工查看。`,
    recovered: (id) => `agentwatch：线程 ${id} 已救活`,
    recoveredDetail: () => '线程已恢复产出',
    alert: (rule, id) => `agentwatch：${rule}（线程 ${id}）`,
  },
};

function lang() {
  const l = (process.env.AGENTWATCH_LANG
    || Intl.DateTimeFormat().resolvedOptions().locale || 'en').toLowerCase();
  return l.startsWith('zh') ? 'zh' : 'en';
}

function t(key, ...args) {
  const f = (M[lang()] || M.en)[key] || M.en[key];
  return typeof f === 'function' ? f(...args) : String(f);
}

module.exports = { t, lang };
