/**
 * Orchestra.js — include in HTML reports to enable "Execute" buttons.
 * Usage: <script src="http://localhost:3000/orchestra.js"></script>
 */
(function() {
  const API = 'http://localhost:3000/api/execute';

  // Execute a single action
  window.orchestraExecute = function(content) {
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    }).then(r => r.json()).then(() => {
      showToast('✓ Sent to Orchestra');
    }).catch(() => showToast('✗ Failed — is Orchestra running?'));
  };

  // Execute selected items (works with the email-check report format)
  window.orchestraExecuteSelected = function() {
    const decisions = [];
    document.querySelectorAll('.card').forEach(card => {
      const mainCb = card.querySelector('.main-cb');
      if (!mainCb || !mainCb.checked) return;
      const subject = mainCb.dataset.subject || '';
      const actCbs = card.querySelectorAll('.act-cb:checked');
      const actions = Array.from(actCbs).map(a => a.dataset.action);
      const notes = card.querySelector('.notes-input');
      if (actions.length) {
        const item = { id: card.dataset.id, subject, action: actions.join('+'), notes: notes?.value || '' };
        // Collect extra data from card
        const draft = card.querySelector('.draft')?.textContent?.trim();
        if (draft) item.draft = draft;
        // Collect all data-* attributes from the card
        for (const [k, v] of Object.entries(card.dataset)) { if (k !== 'id') item[k] = v; }
        decisions.push(item);
      }
    });
    if (!decisions.length) { showToast('No items selected'); return; }
    // Include report metadata
    const reportName = document.querySelector('meta[name="orchestra-report"]')?.content || document.title || 'Unknown Report';
    const taskId = document.querySelector('meta[name="orchestra-task"]')?.content || '';
    const filePath = window.location.pathname || '';
    const header = `[REPORT_EXEC] ${reportName}${taskId ? ` [task:${taskId}]` : ''}${filePath ? ` [file:${filePath}]` : ''}`;
    const lines = decisions.map(d => {
      let line = `#${d.id} ${d.subject} → ${d.action}`;
      if (d.notes) line += ` (${d.notes})`;
      if (d.draft) line += `\n  [draft]: ${d.draft.slice(0, 500)}`;
      return line;
    });
    const footer = document.querySelector('meta[name="orchestra-after-done"]')?.content || '';
    const content = header + '\n' + lines.join('\n') + (footer ? `\n[AFTER_DONE] ${footer}` : '');
    window.orchestraExecute(content);
  };

  // Execute a single card (per-item button)
  window.orchestraExecuteOne = function(btn) {
    const card = btn.closest('.card');
    const actCbs = card.querySelectorAll('.act-cb:checked');
    const actions = Array.from(actCbs).map(a => a.dataset.action);
    if (!actions.length) { alert('請先勾選一個動作再按執行'); return; }
    const mainCb = card.querySelector('.main-cb');
    const subject = mainCb?.dataset.subject || '';
    const notes = card.querySelector('.notes-input');
    const item = { id: card.dataset.id, subject, action: actions.join('+'), notes: notes?.value || '' };
    const draft = card.querySelector('.draft')?.textContent?.trim();
    if (draft) item.draft = draft;
    for (const [k, v] of Object.entries(card.dataset)) { if (k !== 'id') item[k] = v; }
    const reportName = document.querySelector('meta[name="orchestra-report"]')?.content || document.title || '';
    const taskId = document.querySelector('meta[name="orchestra-task"]')?.content || '';
    const filePath = window.location.pathname || '';
    const header = `[REPORT_EXEC] ${reportName}${taskId ? ` [task:${taskId}]` : ''}${filePath ? ` [file:${filePath}]` : ''}`;
    let line = `#${item.id} ${item.subject} → ${item.action}`;
    if (item.notes) line += ` (${item.notes})`;
    if (item.draft) line += `\n  [draft]: ${item.draft.slice(0, 500)}`;
    window.orchestraExecute(header + '\n' + line);
    btn.textContent = '✅ 已送出'; btn.disabled = true;
    if (mainCb) { mainCb.checked = true; document.getElementById('cnt').textContent = document.querySelectorAll('.main-cb:checked').length; }
  };

  function showToast(msg) {
    let t = document.getElementById('orchestra-toast');
    if (!t) { t = document.createElement('div'); t.id = 'orchestra-toast'; t.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#333;color:#fff;padding:12px 20px;border-radius:6px;z-index:9999;display:none;'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 2500);
  }
})();
