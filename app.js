'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentUser = null;
let appConfig = { iliTomanRate: 1000, paymentCard: '5022291607098900' };

function getAuthToken() {
  try { return localStorage.getItem('ili-token') || ''; } catch (e) { return ''; }
}
function setAuthToken(token) {
  try {
    if (token) localStorage.setItem('ili-token', token);
    else localStorage.removeItem('ili-token');
  } catch (e) {}
}


// ---------- Theme ----------
function applyTheme(name) {
  document.body.classList.remove('theme-light', 'theme-blue', 'theme-purple', 'theme-emerald');
  if (name && name !== 'dark') {
    document.body.classList.add('theme-' + name);
  }
  localStorage.setItem('ili-theme', name || 'dark');
  $$('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === (name || 'dark'));
  });
}
function initTheme() {
  const saved = localStorage.getItem('ili-theme') || 'dark';
  applyTheme(saved);
  $$('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });
}

// ---------- Toast ----------
function toast(message, type = 'info') {
  const container = $('#toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ---------- API ----------
async function refreshIliPrice() {
  try {
    const price = await api('/api/price');
    const rate = price.iliTomanRate || price.rate || price.price;
    if (rate) {
      appConfig.iliTomanRate = rate;
      const pe = document.getElementById('stat-price');
      if (pe) pe.textContent = Number(rate).toLocaleString('fa-IR') + ' ت';
    }
    return rate;
  } catch (e) { return null; }
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getAuthToken();
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
    headers['X-Auth-Token'] = token;
  }
  if (options.headers) {
    for (const k in options.headers) headers[k] = options.headers[k];
  }
  const opts = {
    credentials: 'include',
    headers: headers,
    method: options.method || 'GET'
  };
  if (options.body && typeof options.body === 'object') {
    opts.body = JSON.stringify(options.body);
  } else if (options.body) {
    opts.body = options.body;
  }
  try {
    const res = await fetch(path, opts);
    let data = {};
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text }; }
    }
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.status) throw err;
    console.error('Network error:', err);
    throw new Error('Something went wrong. Please try again.');
  }
}

// ---------- Auth UI ----------
function showAuth() {
  $('#auth-page').style.display = 'flex';
  $('#app-shell').classList.remove('visible');
  currentUser = null;
}

function showApp() {
  $('#auth-page').style.display = 'none';
  $('#app-shell').classList.add('visible');
}

function setAuthMessage(type, msg) {
  const errEl = $('#auth-error');
  const okEl = $('#auth-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');
  if (!msg) return;
  if (type === 'error') {
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
  } else {
    okEl.textContent = msg;
    okEl.classList.remove('hidden');
  }
}

// Auth tabs
$$('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.auth-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    if (which === 'login') {
      $('#login-form').classList.remove('hidden');
      $('#register-form').classList.add('hidden');
    } else {
      $('#login-form').classList.add('hidden');
      $('#register-form').classList.remove('hidden');
    }
    setAuthMessage(null);
  });
});

async function doLogin() {
  const btn = document.getElementById('login-btn');
  const userEl = document.getElementById('login-username');
  const passEl = document.getElementById('login-password');
  if (!userEl || !passEl) return;
  if (btn) btn.disabled = true;
  setAuthMessage(null);
  try {
    const username = (userEl.value || '').trim();
    const password = passEl.value || '';
    if (!username || !password) {
      setAuthMessage('error', 'نام کاربری و رمز را وارد کنید');
      if (btn) btn.disabled = false;
      return;
    }
    const data = await api('/api/login', { method: 'POST', body: { username, password } });
    if (data && data.token) setAuthToken(data.token);
    // Prefer in-page navigation; fallback reload once
    try {
      await loadMe();
      showApp();
      navigate('overview');
      toast('ورود موفق', 'success');
    } catch (e2) {
      window.location.replace('/?logged=1');
    }
  } catch (err) {
    setAuthMessage('error', err.message || 'ورود ناموفق');
    if (btn) btn.disabled = false;
  }
}

const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', function (e) {
    e.preventDefault();
    doLogin();
  });
}
const loginBtn = document.getElementById('login-btn');
if (loginBtn) {
  loginBtn.addEventListener('click', function (e) {
    e.preventDefault();
    doLogin();
  });
}
// Enter on password field
const passInput = document.getElementById('login-password');
if (passInput) {
  passInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      doLogin();
    }
  });
}

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#register-btn');
  btn.disabled = true;
  setAuthMessage(null);
  try {
    const displayName = $('#reg-display').value.trim();
    const username = $('#reg-username').value.trim();
    const password = $('#reg-password').value;
    await api('/api/register', {
      method: 'POST',
      body: { displayName, username, password }
    });
    setAuthMessage('success', 'Account created successfully.');
    // Switch to login
    $$('.auth-tab').forEach((t) => t.classList.remove('active'));
    $$('.auth-tab')[0].classList.add('active');
    $('#login-form').classList.remove('hidden');
    $('#register-form').classList.add('hidden');
    $('#login-username').value = username;
    $('#login-password').value = '';
    $('#reg-display').value = '';
    $('#reg-username').value = '';
    $('#reg-password').value = '';
  } catch (err) {
    setAuthMessage('error', err.message || 'Registration failed');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Navigation ----------
function navigate(page) {
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  const navBtn = $(`.nav-item[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add('active');

  $$('.page').forEach((p) => {
    p.classList.remove('active');
    p.classList.add('hidden');
  });
  const pageEl = $(`#page-${page}`);
  if (pageEl) {
    pageEl.classList.add('active');
    pageEl.classList.remove('hidden');
  }

  const sb = $('#sidebar');
  if (sb) sb.classList.remove('open');

  if (page === 'overview') loadOverview();
  if (page === 'card') loadCard();
  if (page === 'settings') loadSettings();
  if (page === 'admin') loadAdmin();
}

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.page));
});

$('#menu-toggle').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
});

// ---------- Load Me ----------
async function loadMe() {
  const data = await api('/api/me');
  currentUser = data;

  $('#topbar-name').textContent = data.displayName;
  $('#welcome-name').textContent = data.displayName;

  const balEl = $('#stat-balance');
  if (data.isMasterAdmin) {
    balEl.textContent = '∞ ILI';
    balEl.classList.add('infinite');
  } else {
    balEl.textContent = data.balanceDisplay;
    balEl.classList.remove('infinite');
  }

  $('#stat-card-status').textContent = data.card ? data.card.status : 'NO CARD';
  $('#stat-role').textContent = data.isMasterAdmin ? 'MASTER ADMIN' : data.role;

  if (data.role === 'ADMIN') {
    $('#nav-admin').classList.remove('hidden');
  } else {
    $('#nav-admin').classList.add('hidden');
  }

  return data;
}

// ---------- Overview ----------
async function loadOverview() {
  try {
    await loadMe();
    // Dynamic price
    try {
      const price = await api('/api/price');
      appConfig.iliTomanRate = price.iliTomanRate;
      const pe = $('#stat-price');
      const ce = $('#stat-price-change');
      if (pe) pe.textContent = price.iliTomanRate.toLocaleString('fa-IR') + ' ت';
      if (ce) {
        const ch = price.changePercent || 0;
        ce.textContent = (ch >= 0 ? '▲ +' : '▼ ') + ch + '%';
        ce.style.color = ch >= 0 ? 'var(--success)' : 'var(--danger)';
        ce.style.fontSize = '0.8rem';
      }
    } catch {}
    const { transactions } = await api('/api/transactions');
    const list = $('#activity-list');
    if (!transactions || transactions.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No activity yet.</p></div>';
      return;
    }

    const inTypes = ['TRANSFER_IN', 'DEPOSIT', 'ADJUST'];
    list.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Note</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            ${transactions.map((t) => {
              const isPos = inTypes.includes(t.type) || (t.type === 'ADJUST' && t.note && t.note.includes('+'));
              const sign = isPos ? '+' : '−';
              const cls = isPos ? 'amount-pos' : 'amount-neg';
              const amt = Math.abs(t.amount).toLocaleString();
              return `
                <tr>
                  <td>${t.type}</td>
                  <td class="${cls}">${sign}${amt} ILI</td>
                  <td><span class="badge badge-${t.status.toLowerCase()}">${t.status}</span></td>
                  <td>${escapeHtml(t.note || '—')}</td>
                  <td>${formatDate(t.created_at)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (err) {
    toast(err.message || 'Failed to load activity', 'error');
  }
}

// ---------- Card ----------
async function loadCard() {
  try {
    const data = await loadMe();
    if (!data.card) {
      $('#card-none').classList.remove('hidden');
      $('#card-exists').classList.add('hidden');
    } else {
      $('#card-none').classList.add('hidden');
      $('#card-exists').classList.remove('hidden');
      const num = data.card.card_number;
      $('#vc-number').textContent = num.replace(/(.{4})/g, '$1 ').trim();
      $('#vc-design').textContent = data.card.design;
      $('#vc-status').textContent = data.card.status;
    }
  } catch (err) {
    toast(err.message || 'Failed to load card', 'error');
  }
}

$('#card-order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#card-order-btn');
  btn.disabled = true;
  try {
    const design = $('#card-design').value;
    const pin = $('#card-pin').value;
    await api('/api/card/order', { method: 'POST', body: { design, pin } });
    toast('Card order submitted.', 'success');
    $('#card-pin').value = '';
    await loadCard();
  } catch (err) {
    toast(err.message || 'Card order failed', 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Money ----------
// Transfer preview
$('#transfer-amount')?.addEventListener('input', () => {
  const amt = Number($('#transfer-amount').value) || 0;
  const fee = Math.floor(amt * 0.05);
  const recv = amt - fee;
  const box = $('#transfer-preview');
  if (amt >= 1) {
    box.classList.remove('hidden');
    box.innerHTML = `کارمزد ۵٪: <strong>${fee.toLocaleString()}</strong> ILI<br>گیرنده دریافت می‌کند: <strong>${recv.toLocaleString()}</strong> ILI`;
  } else {
    box.classList.add('hidden');
  }
});

$('#transfer-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#transfer-btn');
  btn.disabled = true;
  try {
    const recipientUsername = $('#transfer-to').value.trim();
    const amount = Number($('#transfer-amount').value);
    const data = await api('/api/transfer', {
      method: 'POST',
      body: { recipientUsername, amount }
    });
    toast(`Transfer completed. Fee: ${data.fee} ILI — Recipient got ${data.received} ILI`, 'success');
    $('#transfer-to').value = '';
    $('#transfer-amount').value = '';
    $('#transfer-preview').classList.add('hidden');
    await loadMe();
  } catch (err) {
    toast(err.message || 'Transfer failed', 'error');
  } finally {
    btn.disabled = false;
  }
});

// Buy ILI preview
function updateBuyPreview() {
  const amt = Number($('#deposit-amount').value) || 0;
  const toman = amt * appConfig.iliTomanRate;
  $('#buy-toman').textContent = toman > 0 ? toman.toLocaleString('fa-IR') : '—';
  const card = appConfig.paymentCard || '5022291607098900';
  $('#pay-card-display').textContent = card.replace(/(.{4})/g, '$1 ').trim();
}
$('#deposit-amount')?.addEventListener('input', updateBuyPreview);

$('#deposit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#deposit-btn');
  btn.disabled = true;
  try {
    const amount = Number($('#deposit-amount').value);
    const rBuy = await api('/api/demo-request', {
      method: 'POST',
      body: { type: 'DEPOSIT', amount }
    });
    if (rBuy.iliTomanRate) appConfig.iliTomanRate = rBuy.iliTomanRate;
    if ($('#stat-price')) $('#stat-price').textContent = (rBuy.iliTomanRate || appConfig.iliTomanRate).toLocaleString('fa-IR') + ' ت';
    const np = rBuy.iliTomanRate || rBuy.iliPriceToman || appConfig.iliTomanRate;
    appConfig.iliTomanRate = np;
    toast('خرید ثبت شد — قیمت جدید ILI: ' + np + ' تومان', 'success');
    if ($('#stat-price')) $('#stat-price').textContent = Number(np).toLocaleString('fa-IR') + ' تومان';
    await refreshIliPrice();
    $('#deposit-amount').value = '';
    updateBuyPreview();
  } catch (err) {
    toast(err.message || 'Request failed', 'error');
  } finally {
    btn.disabled = false;
  }
});

// Sell ILI preview
$('#withdraw-amount')?.addEventListener('input', () => {
  const amt = Number($('#withdraw-amount').value) || 0;
  const toman = amt * appConfig.iliTomanRate;
  const box = $('#sell-preview');
  if (amt >= 1) {
    box.classList.remove('hidden');
    box.innerHTML = `مبلغ تقریبی دریافتی: <strong>${toman.toLocaleString('fa-IR')}</strong> تومان`;
  } else {
    box.classList.add('hidden');
  }
});

$('#withdraw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#withdraw-btn');
  btn.disabled = true;
  try {
    const amount = Number($('#withdraw-amount').value);
    const bankCard = $('#withdraw-card').value.trim();
    const rSell = await api('/api/demo-request', {
      method: 'POST',
      body: { type: 'WITHDRAWAL', amount, bankCard }
    });
    const np2 = rSell.iliTomanRate || rSell.iliPriceToman || appConfig.iliTomanRate;
    appConfig.iliTomanRate = np2;
    toast('فروش ثبت شد — قیمت جدید ILI: ' + np2 + ' تومان', 'success');
    if ($('#stat-price')) $('#stat-price').textContent = Number(np2).toLocaleString('fa-IR') + ' تومان';
    await refreshIliPrice();
    $('#withdraw-amount').value = '';
    $('#withdraw-card').value = '';
    $('#sell-preview').classList.add('hidden');
  } catch (err) {
    toast(err.message || 'Request failed', 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- Settings ----------
function loadSettings() {
  if (!currentUser) return;
  $('#set-display').textContent = currentUser.displayName;
  $('#set-username').textContent = currentUser.username;
  $('#set-role').textContent = currentUser.isMasterAdmin ? 'MASTER ADMIN' : currentUser.role;
}

$('#logout-btn').addEventListener('click', async () => {
  try {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    setAuthToken('');
  } catch { /* ignore */ }
  showAuth();
  toast('Signed out', 'info');
});

// ---------- Admin ----------
async function loadAdmin() {
  await Promise.all([
    loadAdminUsers(),
    loadAdminCards(),
    loadAdminTx(),
    loadAdminAudit()
  ]);
}

async function loadAdminUsers() {
  try {
    const { users } = await api('/api/admin/users');
    const tbody = $('#admin-users-body');
    if (!users.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No users found.</td></tr>';
      return;
    }
    tbody.innerHTML = users.map((u) => {
      const isMaster = u.username === 'iliyadavan';
      const bal = isMaster ? '∞' : Number(u.balance).toLocaleString();
      const actions = isMaster
        ? '—'
        : `<div class="adjust-row">
            <input type="number" class="adj-input" data-uid="${u.id}" placeholder="amt" min="1" step="1" />
            <button type="button" class="btn btn-sm btn-success" data-adj="${u.id}" data-sign="1">+</button>
            <button type="button" class="btn btn-sm btn-danger" data-adj="${u.id}" data-sign="-1">−</button>
            <button type="button" class="btn btn-sm btn-secondary" data-imp="${u.id}">Login as</button>
            <button type="button" class="btn btn-sm btn-secondary" data-view="${u.id}">Info</button>
          </div>`;
      return `
        <tr>
          <td>${u.id}</td>
          <td>${escapeHtml(u.username)}</td>
          <td>${escapeHtml(u.display_name)}</td>
          <td><span class="badge badge-${u.role.toLowerCase()}">${u.role}</span></td>
          <td>${bal} ILI</td>
          <td>${formatDate(u.created_at)}</td>
          <td>${actions}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-adj]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.adj;
        const input = tbody.querySelector(`.adj-input[data-uid="${uid}"]`);
        const val = Number(input?.value);
        if (!val || val < 1) {
          toast('مقدار را وارد کنید', 'error');
          return;
        }
        const delta = val * Number(btn.dataset.sign);
        btn.disabled = true;
        try {
          await api('/api/admin/adjust', {
            method: 'POST',
            body: { userId: Number(uid), delta }
          });
          toast('Balance updated.', 'success');
          await loadAdminUsers();
        } catch (err) {
          toast(err.message || 'Adjust failed', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
    tbody.querySelectorAll('[data-imp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('ورود به حساب این کاربر؟')) return;
        try {
          const r = await api('/api/admin/impersonate', { method: 'POST', body: { userId: Number(btn.dataset.imp) } });
          toast(r.message || 'Switched', 'success');
          setTimeout(() => location.reload(), 400);
        } catch (e) { toast(e.message || 'Impersonate failed', 'error'); }
      });
    });
    tbody.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          const data = await api('/api/admin/user/' + btn.dataset.view);
          const u = data.user || {};
          const c = data.card;
          const lines = [
            'نام: ' + (u.displayName || '-'),
            'یوزرنیم: @' + (u.username || '-'),
            'نقش: ' + (u.role || '-'),
            'موجودی: ' + (u.balance != null ? u.balance : '-') + ' ILI',
            'کد ملی: ' + (u.nationalId || '-'),
            'بیو: ' + (u.bio || '-'),
            'کارت: ' + (c ? (c.card_number + ' [' + c.status + ']') : 'ندارد'),
            'PIN: ' + (u.hasPin ? 'تنظیم شده (قابل مشاهده نیست)' : 'ندارد'),
            'تاریخ عضویت: ' + (u.createdAt || '-')
          ];
          alert(lines.join('\n'));
        } catch (e) {
          console.error(e);
          toast(e.message || 'خطا در دریافت اطلاعات', 'error');
        }
      });
    });
  } catch (err) {
    toast(err.message || 'Failed to load users', 'error');
  }
}

async function loadAdminCards() {
  try {
    const { cards } = await api('/api/admin/cards');
    const tbody = $('#admin-cards-body');
    if (!cards.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No cards found.</td></tr>';
      return;
    }
    tbody.innerHTML = cards.map((c) => {
      const statuses = ['APPROVED', 'ACTIVE', 'BLOCKED', 'CANCELLED'];
      const btns = statuses
        .filter((s) => s !== c.status)
        .map((s) => `<button type="button" class="btn btn-sm btn-secondary" data-card="${c.id}" data-status="${s}">${s}</button>`)
        .join('');
      return `
        <tr>
          <td>${escapeHtml(c.display_name)} (@${escapeHtml(c.username)})</td>
          <td style="font-family:monospace;">${c.card_number}</td>
          <td>${escapeHtml(c.design)}</td>
          <td><span class="badge badge-${c.status.toLowerCase()}">${c.status}</span></td>
          <td>${formatDate(c.created_at)}</td>
          <td><div class="action-btns">${btns || '—'}</div></td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-card]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/admin/card-status', {
            method: 'POST',
            body: { cardId: Number(btn.dataset.card), status: btn.dataset.status }
          });
          toast('Card status updated.', 'success');
          await loadAdminCards();
        } catch (err) {
          toast(err.message || 'Update failed', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    toast(err.message || 'Failed to load cards', 'error');
  }
}

async function loadAdminTx() {
  try {
    const { transactions } = await api('/api/admin/transactions');
    const tbody = $('#admin-tx-body');
    if (!transactions.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No transactions found.</td></tr>';
      return;
    }
    tbody.innerHTML = transactions.map((t) => {
      let actions = '—';
      if (t.status === 'PENDING' && (t.type === 'DEPOSIT' || t.type === 'WITHDRAWAL')) {
        actions = `<div class="action-btns">
          <button type="button" class="btn btn-sm btn-success" data-txid="${t.id}" data-st="APPROVED">Approve</button>
          <button type="button" class="btn btn-sm btn-danger" data-txid="${t.id}" data-st="REJECTED">Reject</button>
        </div>`;
      }
      let extra = '';
      if (t.meta && t.meta.sellerCard) {
        extra = `<br><span style="color:var(--accent);font-family:monospace;font-size:0.8rem;">کارت فروشنده: ${t.meta.sellerCard}</span>`;
      }
      if (t.meta && t.meta.toman) {
        extra += `<br><span style="color:var(--text-dim);font-size:0.8rem;">${Number(t.meta.toman).toLocaleString()} تومان</span>`;
      }
      return `
        <tr>
          <td>${escapeHtml(t.display_name)} (@${escapeHtml(t.username)})</td>
          <td>${t.type}</td>
          <td>${Number(t.amount).toLocaleString()} ILI</td>
          <td><span class="badge badge-${t.status.toLowerCase()}">${t.status}</span></td>
          <td>${escapeHtml(t.note || '—')}${extra}</td>
          <td>${formatDate(t.created_at)}</td>
          <td>${actions}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('[data-txid]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api('/api/admin/transaction-status', {
            method: 'POST',
            body: { transactionId: Number(btn.dataset.txid), status: btn.dataset.st }
          });
          toast('Transaction status updated.', 'success');
          await loadAdminTx();
        } catch (err) {
          toast(err.message || 'Update failed', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    toast(err.message || 'Failed to load transactions', 'error');
  }
}

async function loadAdminAudit() {
  try {
    const { logs } = await api('/api/admin/audit');
    const tbody = $('#admin-audit-body');
    if (!logs.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No audit logs.</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map((l) => `
      <tr>
        <td>${escapeHtml(l.actor_display_name || l.actor_username || '—')}</td>
        <td>${escapeHtml(l.action)}</td>
        <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(l.details || '')}">${escapeHtml(l.details || '—')}</td>
        <td>${formatDate(l.created_at)}</td>
      </tr>
    `).join('');
  } catch (err) {
    toast(err.message || 'Failed to load audit logs', 'error');
  }
}

// ---------- Helpers ----------
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso + (iso.includes('Z') || iso.includes('+') ? '' : 'Z'));
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

// ---------- Mode Switch (Bank / Messenger) ----------
function setMode(mode) {
  const modes = {
    bank: document.getElementById('bank-mode'),
    messenger: document.getElementById('messenger-mode'),
    programs: document.getElementById('programs-mode'),
    news: document.getElementById('news-mode'),
    economy: document.getElementById('economy-mode'),
    gold: document.getElementById('gold-mode')
  };
  const btns = {
    bank: document.getElementById('mode-bank'),
    messenger: document.getElementById('mode-msg'),
    programs: document.getElementById('mode-programs'),
    news: document.getElementById('mode-news'),
    economy: document.getElementById('mode-economy'),
    gold: document.getElementById('mode-gold')
  };
  const section = document.getElementById('topbar-section');
  if (typeof Economy !== 'undefined' && Economy.stop) Economy.stop();
  if (typeof AnalysisPage !== 'undefined' && AnalysisPage.stop) AnalysisPage.stop();
  if (typeof Msg !== 'undefined' && Msg.stopPoll) Msg.stopPoll();
  if (typeof Programs !== 'undefined' && Programs.stopAll) Programs.stopAll();

  Object.keys(modes).forEach(function (k) {
    var el = modes[k];
    if (!el) return;
    el.classList.add('hidden');
    el.style.display = 'none';
  });
  Object.keys(btns).forEach(function (k) {
    if (btns[k]) btns[k].classList.remove('active');
  });

  if (!modes[mode]) mode = 'bank';
  var panel = modes[mode];
  if (panel) {
    panel.classList.remove('hidden');
    panel.style.display = (mode === 'bank') ? '' : 'block';
    if (mode === 'bank') panel.style.display = '';
  }
  if (btns[mode]) btns[mode].classList.add('active');

  if (section) {
    section.textContent = ({
      bank: 'بانک', messenger: 'چت', programs: 'تلویزیون',
      news: 'اخبار', economy: 'اقتصاد', gold: 'طلا'
    })[mode] || mode;
  }

  if (mode === 'messenger' && typeof Msg !== 'undefined') Msg.loadChats();
  if (mode === 'programs' && typeof Programs !== 'undefined') Programs.init();
  if (mode === 'news' && typeof News !== 'undefined') News.init();
  if (mode === 'economy' && typeof Economy !== 'undefined') Economy.init();
  if (mode === 'gold') {
    if (typeof AnalysisPage !== 'undefined') AnalysisPage.start();
    else if (typeof window.loadGoldAnalysis === 'function') window.loadGoldAnalysis();
    if (typeof GoldPage !== 'undefined') GoldPage.load();
  }
  if (mode === 'programs') document.body.classList.add('tv-mode');
  else document.body.classList.remove('tv-mode');
}

document.getElementById('mode-bank')?.addEventListener('click', () => setMode('bank'));
document.getElementById('mode-msg')?.addEventListener('click', () => setMode('messenger'));
document.getElementById('mode-programs')?.addEventListener('click', () => setMode('programs'));
document.getElementById('mode-news')?.addEventListener('click', () => setMode('news'));
document.getElementById('mode-economy')?.addEventListener('click', () => setMode('economy'));
document.getElementById('mode-gold')?.addEventListener('click', () => setMode('gold'));
// delegated mode buttons
document.querySelector('.mode-switch')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  const m = btn.getAttribute('data-mode');
  if (m) setMode(m);
});


// Messenger buttons
document.getElementById('msg-new-chat')?.addEventListener('click', () => Msg?.createPrivate());
document.getElementById('msg-new-group')?.addEventListener('click', () => Msg?.createGroup());
document.getElementById('msg-new-channel')?.addEventListener('click', () => Msg?.createChannel());
document.getElementById('msg-send')?.addEventListener('click', () => Msg?.send());
document.getElementById('msg-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') Msg?.send();
});

// ---------- Profile ----------
function loadProfile() {
  if (!currentUser) return;
  const d = document.getElementById('prof-display');
  const n = document.getElementById('prof-national');
  const b = document.getElementById('prof-bio');
  if (d) d.value = currentUser.displayName || '';
  if (n) n.value = currentUser.nationalId || '';
  if (b) b.value = currentUser.bio || '';
}

document.getElementById('prof-save')?.addEventListener('click', async () => {
  try {
    await api('/api/profile', {
      method: 'POST',
      body: {
        displayName: document.getElementById('prof-display')?.value,
        nationalId: document.getElementById('prof-national')?.value,
        bio: document.getElementById('prof-bio')?.value
      }
    });
    toast('Profile updated.', 'success');
    await loadMe();
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('pw-save')?.addEventListener('click', async () => {
  try {
    await api('/api/change-password', {
      method: 'POST',
      body: {
        currentPassword: document.getElementById('pw-current')?.value,
        newPassword: document.getElementById('pw-new')?.value
      }
    });
    toast('Password changed.', 'success');
    document.getElementById('pw-current').value = '';
    document.getElementById('pw-new').value = '';
  } catch (e) { toast(e.message, 'error'); }
});

document.getElementById('pin-save')?.addEventListener('click', async () => {
  try {
    await api('/api/change-pin', {
      method: 'POST',
      body: {
        currentPin: document.getElementById('pin-current')?.value,
        newPin: document.getElementById('pin-new')?.value
      }
    });
    toast('PIN changed.', 'success');
    document.getElementById('pin-current').value = '';
    document.getElementById('pin-new').value = '';
  } catch (e) { toast(e.message, 'error'); }
});

// ---------- Gifts ----------
async function loadGifts() {
  try {
    const data = await api('/api/gifts');
    const grid = document.getElementById('gifts-grid');
    if (!grid) return;
    grid.innerHTML = (data.gifts || []).map(g => `
      <div class="product-card">
        <div style="font-size:2.5rem;margin-bottom:8px;">${g.emoji}</div>
        <h4>${escapeHtml(g.name)}</h4>
        <p style="color:var(--text-muted);font-size:0.85rem;">${g.price} ILI</p>
        <button type="button" class="btn btn-sm btn-primary" style="margin-top:12px;" data-gift="${g.code}">Send Gift</button>
      </div>
    `).join('');
    grid.querySelectorAll('[data-gift]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const to = prompt('Send to username:');
        if (!to) return;
        try {
          await api('/api/gifts/send', {
            method: 'POST',
            body: { giftCode: btn.dataset.gift, toUsername: to.trim() }
          });
          toast('Gift sent!', 'success');
          await loadMe();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}

// Navigate
function navigate(page) {
  $$('.nav-item').forEach((n) => n.classList.remove('active'));
  const navBtn = $(`.nav-item[data-page="${page}"]`);
  if (navBtn) navBtn.classList.add('active');
  $$('.page').forEach((p) => p.classList.remove('active'));
  const pageEl = $(`#page-${page}`);
  if (pageEl) pageEl.classList.add('active');
  $('#sidebar')?.classList.remove('open');
  if (page === 'overview') loadOverview();
  if (page === 'card') loadCard();
  if (page === 'settings') loadSettings();
  if (page === 'admin') loadAdmin();
  if (page === 'profile') loadProfile();
  if (page === 'scanner') resetScanner();
  if (page === 'exchange') { /* transfer forms already bound */ }
  if (page === 'help' && typeof loadHelpPage === 'function') loadHelpPage();
  if (page === 'portfolio' && typeof Portfolio !== 'undefined') Portfolio.load();

  if (page === 'gold' && typeof GoldPage !== 'undefined') GoldPage.load();
  if (page === 'analysis' && typeof AnalysisPage !== 'undefined') {
    AnalysisPage.start();
  } else if (typeof AnalysisPage !== 'undefined') {
    AnalysisPage.stop();
  }

  if (page === 'notifications') {
    api('/api/notifications').then(d => {
      if (typeof Notifications !== 'undefined') {
        Notifications.list = (d.notifications || []).map(n => ({ title: n.title, body: n.body, at: n.at }));
        Notifications.render();
      }
    }).catch(()=>{});
  }
  if (typeof Loyalty !== 'undefined') Loyalty.sync();
}

// Card + barcode
function renderBarcode(el, code) {
  if (!el || !code) return;
  // Simple visual barcode from digits
  let html = '';
  for (const ch of String(code)) {
    const h = 20 + (parseInt(ch, 10) * 3);
    html += `<span style="display:inline-block;width:3px;height:${h}px;background:currentColor;margin:0 1px;vertical-align:middle;"></span>`;
  }
  el.innerHTML = html + `<div style="font-size:0.7rem;margin-top:6px;letter-spacing:0.15em;opacity:0.8;">${code}</div>`;
}

async function loadCard() {
  try {
    const data = await loadMe();
    if (!data.card) {
      $('#card-none')?.classList.remove('hidden');
      $('#card-exists')?.classList.add('hidden');
    } else {
      $('#card-none')?.classList.add('hidden');
      $('#card-exists')?.classList.remove('hidden');
      const num = data.card.card_number;
      const el = $('#vc-number');
      if (el) {
        el.textContent = num.replace(/(.{4})/g, '$1 ').trim();
        el.onclick = () => navigator.clipboard.writeText(num).then(() => toast('Card number copied', 'success'));
      }
      if ($('#vc-design')) $('#vc-design').textContent = data.card.design;
      if ($('#vc-status')) $('#vc-status').textContent = data.card.status;
      renderBarcode($('#vc-barcode'), num);
      const vc = $('#virtual-card');
      if (vc) {
        vc.className = 'virtual-card card-3d design-' + (data.card.design || 'Random');
      }
    }
  } catch (err) {
    toast(err.message || 'Failed to load card', 'error');
  }
}

// Scanner
let scanTargetCard = null;
function resetScanner() {
  scanTargetCard = null;
  $('#scanner-input-panel')?.classList.remove('hidden');
  $('#scanner-send-panel')?.classList.add('hidden');
  if ($('#scan-card-number')) $('#scan-card-number').value = '';
  if ($('#scan-amount')) $('#scan-amount').value = '';
  if ($('#scan-pin')) $('#scan-pin').value = '';
}
async function doScanLookup() {
  const card = ($('#scan-card-number')?.value || '').replace(/[\s-]/g, '');
  if (!card || card.length < 12) {
    toast('شماره کارت ۱۲ رقمی را کامل وارد کنید', 'error');
    return;
  }
  try {
    const data = await api('/api/scanner/lookup', { method: 'POST', body: { card } });
    scanTargetCard = data.cardNumber;
    $('#scan-recipient-name').textContent = (data.user.displayName || '') + ' (@' + data.user.username + ')';
    $('#scan-recipient-card').textContent = data.cardNumber;
    $('#scanner-input-panel')?.classList.add('hidden');
    $('#scanner-send-panel')?.classList.remove('hidden');
    toast('کارت پیدا شد ✓', 'success');
  } catch (e) {
    toast(e.message || 'کارت پیدا نشد', 'error');
  }
}
$('#scan-lookup-btn')?.addEventListener('click', doScanLookup);
$('#scan-card-number')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doScanLookup(); }
});
$('#scan-cancel-btn')?.addEventListener('click', resetScanner);
$('#scan-send-btn')?.addEventListener('click', async () => {
  if (!scanTargetCard) { toast('ابتدا کارت را جستجو کنید', 'error'); return; }
  const amount = Number($('#scan-amount')?.value);
  const pin = $('#scan-pin')?.value;
  if (!amount || amount < 1) { toast('مبلغ را وارد کنید', 'error'); return; }
  try {
    const data = await api('/api/scanner/pay', {
      method: 'POST',
      body: { cardNumber: scanTargetCard, amount, pin }
    });
    toast(`✅ ارسال شد | کارمزد ${data.fee} | گیرنده ${data.received} ILI`, 'success');
    resetScanner();
    await loadMe();
  } catch (e) {
    toast(e.message || 'انتقال ناموفق', 'error');
  }
});

// Quick Trade
$('#quick-buy-amount')?.addEventListener('input', () => {
  const amt = Number($('#quick-buy-amount')?.value) || 0;
  const t = amt * (appConfig.iliTomanRate || 1000);
  if ($('#quick-buy-toman')) $('#quick-buy-toman').textContent = t > 0 ? t.toLocaleString('fa-IR') : '—';
});
$('#quick-buy-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/demo-request', {
      method: 'POST',
      body: { type: 'DEPOSIT', amount: Number($('#quick-buy-amount').value) }
    });
    if (r.iliTomanRate) appConfig.iliTomanRate = r.iliTomanRate;
    toast('خرید ثبت شد — قیمت ILI: ' + (r.iliTomanRate || appConfig.iliTomanRate) + ' تومان', 'success');
    $('#quick-buy-amount').value = '';
    await refreshIliPrice();
    if (typeof loadOverview === 'function') loadOverview();
    try { loadOverview(); } catch {}
  } catch (err) { toast(err.message, 'error'); }
});
$('#quick-sell-amount')?.addEventListener('input', () => {
  const amt = Number($('#quick-sell-amount')?.value) || 0;
  const t = amt * (appConfig.iliTomanRate || 1000);
  const box = $('#quick-sell-preview');
  if (amt >= 1) {
    box?.classList.remove('hidden');
    if (box) box.innerHTML = `مبلغ تقریبی: <strong>${t.toLocaleString('fa-IR')}</strong> تومان`;
  } else box?.classList.add('hidden');
});
$('#quick-sell-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/api/demo-request', {
      method: 'POST',
      body: {
        type: 'WITHDRAWAL',
        amount: Number($('#quick-sell-amount').value),
        bankCard: $('#quick-sell-card').value
      }
    });
    if (r.iliTomanRate) appConfig.iliTomanRate = r.iliTomanRate;
    toast('فروش ثبت شد — قیمت ILI: ' + (r.iliTomanRate || appConfig.iliTomanRate) + ' تومان', 'success');
    await refreshIliPrice();
    if (typeof loadOverview === 'function') loadOverview();
    $('#quick-sell-amount').value = '';
    $('#quick-sell-card').value = '';
    try { loadOverview(); } catch {}
  } catch (err) { toast(err.message, 'error'); }
});

// Fullscreen
$('#btn-fullscreen')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

// Gifts in Messenger
let selectedGiftCode = '1';

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (!(t instanceof HTMLElement)) return;

  // gift pick buttons
  if (t.classList.contains('gift-pick-btn') || t.closest('.gift-pick-btn')) {
    const btn = t.classList.contains('gift-pick-btn') ? t : t.closest('.gift-pick-btn');
    document.querySelectorAll('.gift-pick-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedGiftCode = btn.getAttribute('data-code') || '1';
    return;
  }

  // open gift modal
  if (t.id === 'msg-gift-btn' || t.closest('#msg-gift-btn')) {
    try {
      const users = await api('/api/messenger/users');
      const dl = document.getElementById('gift-user-list');
      if (dl) dl.innerHTML = (users.users || []).map(u => `<option value="${u.username}">`).join('');
    } catch (e) {}
    document.querySelectorAll('.gift-pick-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-code') === selectedGiftCode);
    });
    const modal = document.getElementById('gift-modal');
    if (modal) modal.classList.remove('hidden');
    return;
  }

  if (t.id === 'gift-modal-close' || t.closest('#gift-modal-close')) {
    document.getElementById('gift-modal')?.classList.add('hidden');
    return;
  }

  if (t.id === 'gift-send-confirm' || t.closest('#gift-send-confirm')) {
    const to = (document.getElementById('gift-to-user')?.value || '').trim();
    if (!to) { toast('یوزرنیم گیرنده را وارد کنید', 'error'); return; }
    try {
      const res = await api('/api/gifts/send', {
        method: 'POST',
        body: { giftCode: selectedGiftCode, toUsername: to }
      });
      toast((res.message || 'گیفت ارسال شد') + ' ' + (res.gift?.emoji || ''), 'success');
      document.getElementById('gift-modal')?.classList.add('hidden');
      await loadMe();
      if (typeof Msg !== 'undefined') {
        await Msg.loadChats();
        if (res.conversationId) Msg.openChat(res.conversationId);
      }
    } catch (e) {
      toast(e.message || 'خطا در ارسال گیفت', 'error');
    }
  }
});

// ---------- i18n FA / EN ----------
const I18N = {
  en: {
    nav_overview: 'Overview', nav_card: 'Card', nav_exchange: 'Exchange', nav_scanner: 'Scanner',
    nav_profile: 'Profile', nav_settings: 'Settings', nav_admin: 'Admin',
    nav_portfolio: 'Portfolio', nav_notifications: 'Notifications', nav_help: 'Help', nav_gold: 'Gold', nav_analysis: 'Analysis',
    auth_subtitle: 'Home Banking & Platform', auth_login_tab: 'Sign In', auth_register_tab: 'Register',
    auth_username: 'Username', auth_password: 'Password', auth_display: 'Display name',
    auth_username_ph: 'Username', auth_password_ph: 'Password', auth_display_ph: 'Your name',
    auth_login_btn: 'Sign In', auth_register_btn: 'Create account',
    top_section: 'Platform', page_help: 'Help', page_portfolio: 'Portfolio', page_notifications: 'Notifications',
    loyalty_points: 'Loyalty points', loading: 'Loading…',
    mode_bank: 'Bank', mode_chat: 'Chat', mode_tv: 'TV', mode_news: 'News', mode_economy: 'Economy'
  },
  fa: {
    nav_overview: 'نمای کلی', nav_card: 'کارت', nav_exchange: 'صرافی', nav_scanner: 'اسکنر',
    nav_profile: 'پروفایل', nav_settings: 'تنظیمات', nav_admin: 'مدیریت',
    nav_portfolio: 'پورتفوی', nav_notifications: 'اعلان‌ها', nav_help: 'راهنما', nav_gold: 'طلا', nav_analysis: 'تحلیل',
    auth_subtitle: 'خانه بانکی و پلتفرم', auth_login_tab: 'ورود', auth_register_tab: 'ثبت‌نام',
    auth_username: 'نام کاربری', auth_password: 'رمز عبور', auth_display: 'نام نمایشی',
    auth_username_ph: 'نام کاربری', auth_password_ph: 'رمز عبور', auth_display_ph: 'نام شما',
    auth_login_btn: 'ورود', auth_register_btn: 'ساخت حساب',
    top_section: 'پلتفرم', page_help: 'راهنما', page_portfolio: 'پورتفوی', page_notifications: 'اعلان‌ها',
    loyalty_points: 'امتیاز وفاداری', loading: 'در حال بارگذاری…',
    mode_bank: 'بانک', mode_chat: 'چت', mode_tv: 'تلویزیون', mode_news: 'اخبار', mode_economy: 'اقتصاد'
  }
};
let currentLang = localStorage.getItem('ili-lang') || 'en';

function toFaDigits(str) {
  return String(str).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
}
function applyLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'fa';
  localStorage.setItem('ili-lang', currentLang);
  document.documentElement.lang = currentLang === 'fa' ? 'fa' : 'en';
  document.documentElement.dir = currentLang === 'fa' ? 'rtl' : 'ltr';
  document.body.classList.toggle('lang-fa', currentLang === 'fa');
  document.body.classList.toggle('lang-en', currentLang === 'en');
  const dict = I18N[currentLang] || I18N.fa;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (dict[k]) el.textContent = dict[k];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (dict[k]) el.setAttribute('placeholder', dict[k]);
  });
  const btn = document.getElementById('lang-switch');
  if (btn) btn.textContent = currentLang === 'fa' ? 'EN' : 'FA';
  const setModeLabel = (id, fa, en) => {
    const el = document.getElementById(id);
    if (!el) return;
    const txt = el.querySelector('.mode-txt');
    if (txt) txt.textContent = currentLang === 'fa' ? fa : en;
    else el.textContent = currentLang === 'fa' ? fa : en;
  };
  setModeLabel('mode-bank', 'بانک', 'Bank');
  setModeLabel('mode-msg', 'چت', 'Chat');
  setModeLabel('mode-programs', 'تلویزیون', 'TV');
  setModeLabel('mode-news', 'اخبار', 'News');
  setModeLabel('mode-economy', 'اقتصاد', 'Economy');
  setModeLabel('mode-gold', 'طلا', 'Gold');
  const sec = document.getElementById('topbar-section');
  if (sec) sec.textContent = dict.top_section || sec.textContent;
  if (currentLang === 'fa') {
    ['stat-balance','stat-price','stat-card-status','stat-role'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.textContent) el.textContent = toFaDigits(el.textContent);
    });
  }
  if (typeof loadHelpPage === 'function' && document.getElementById('page-help') && !document.getElementById('page-help').classList.contains('hidden')) {
    loadHelpPage();
  }
}
document.getElementById('lang-switch')?.addEventListener('click', () => {
  applyLang(currentLang === 'fa' ? 'en' : 'fa');
});
document.getElementById('set-lang-fa')?.addEventListener('click', () => applyLang('fa'));
document.getElementById('set-lang-en')?.addEventListener('click', () => applyLang('en'));

// 3D card flip
document.getElementById('card-3d-wrap')?.addEventListener('click', () => {
  document.getElementById('card-3d-wrap')?.classList.toggle('flipped');
});

// ---------- Boot ----------
async function boot() {
  try { initTheme(); applyIliTheme(localStorage.getItem('ili-theme') || 'midnight'); } catch (e) { try { initTheme(); } catch (e2) {} }
  if (typeof applyLang === 'function') applyLang(currentLang || 'fa');
  try {
    const cfg = await fetch('/api/config').then(function(r) { return r.json(); }).catch(function() { return null; });
    if (cfg) {
      appConfig = cfg;
      if (typeof updateBuyPreview === 'function') updateBuyPreview();
    }
  } catch (e) {}
  try {
    await loadMe();
    showApp();
    setMode('bank');
    navigate('overview');
  } catch (e) {
    showAuth();
  }
}

boot();


// ===== GOLD + ANALYSIS (embedded) =====
window.loadGoldAnalysis = async function loadGoldAnalysis() {
  var g = document.getElementById('analysis-gold');
  var u = document.getElementById('analysis-usd');
  if (g) g.innerHTML = 'در حال بارگذاری تحلیل…';
  if (u) u.innerHTML = 'در حال بارگذاری تحلیل…';
  try {
    var data = await api('/api/analysis/markets');
        function block(x) {
      if (!x) return 'داده‌ای نیست';
      var color = (x.signal === 'BUY' || x.signal === 'WEAK_BUY') ? '#22c55e' :
        (x.signal === 'SELL' || x.signal === 'WEAK_SELL') ? '#ef4444' : '#94a3b8';
      var ind = x.indicators || {};
      var plan = x.profitPlan || {};
      var ch = x.changePct != null ? x.changePct : 0;
      var chColor = ch >= 0 ? '#22c55e' : '#ef4444';
      var reasons = (x.reasons || []).map(function(r){ return '<li>' + r + '</li>'; }).join('');
      return '<div style="font-size:1.4rem;font-weight:800;color:' + color + '">' +
        (x.signalFa || x.signal) + ' · اطمینان ' + (x.confidence || 0) + '٪</div>' +
        '<div>قیمت: <b>' + (x.price != null ? Number(x.price).toLocaleString('fa-IR') : '—') + ' تومان</b> ' +
        '<span style="color:' + chColor + '">(' + ch + '٪)</span></div>' +
        '<div class="hint">امتیاز تکنیکال: ' + (x.score != null ? x.score : '—') + ' · نمونه: ' + (x.samples || '—') + '</div>' +
        '<div class="hint">RSI ' + (ind.rsi14 != null ? ind.rsi14 : '—') + ' | Stoch ' + (ind.stochastic != null ? ind.stochastic : '—') + ' | ATR ' + (ind.atr != null ? Number(ind.atr).toLocaleString('fa-IR') : '—') + '</div>' +
        '<div class="hint">SMA 7/14/21/50: ' + [ind.sma7,ind.sma14,ind.sma21,ind.sma50].map(function(v){return v!=null?Number(v).toLocaleString('fa-IR'):'—';}).join(' / ') + '</div>' +
        '<div class="hint">EMA9/21: ' + (ind.ema9!=null?Number(ind.ema9).toLocaleString('fa-IR'):'—') + ' / ' + (ind.ema21!=null?Number(ind.ema21).toLocaleString('fa-IR'):'—') + ' | MACD ' + (ind.macd!=null?ind.macd:'—') + '</div>' +
        '<div class="hint">بولینگر: ' + [ind.bbLower,ind.bbMid,ind.bbUpper].map(function(v){return v!=null?Number(v).toLocaleString('fa-IR'):'—';}).join(' / ') + '</div>' +
        '<hr style="border-color:rgba(255,255,255,0.08);margin:10px 0">' +
        '<div><b>برنامه:</b> ' + (plan.action || '') + '</div>' +
        '<div>ورود: ' + (plan.entry != null ? Number(plan.entry).toLocaleString('fa-IR') : '—') + ' ت</div>' +
        '<div>حد سود / مقاومت: ' + (plan.takeProfit != null ? Number(plan.takeProfit).toLocaleString('fa-IR') : '—') + ' ت</div>' +
        '<div>حد ضرر / حمایت: ' + (plan.stopLoss != null ? Number(plan.stopLoss).toLocaleString('fa-IR') : '—') + ' ت</div>' +
        '<div>سود مورد انتظار: <b>' + (plan.expectedProfitPercent != null ? plan.expectedProfitPercent : 0) + '٪</b>' +
        (plan.riskReward ? ' · R/R ' + plan.riskReward : '') + '</div>' +
        '<p class="hint">' + (plan.note || '') + '</p>' +
        (reasons ? '<ul style="margin:6px 0 0 16px;color:#94a3b8;font-size:0.85rem">' + reasons + '</ul>' : '');
    }
    if (g) g.innerHTML = block(data.gold);
    if (u) u.innerHTML = block(data.usd);
    var up = document.getElementById('analysis-updated');
    if (up) up.textContent = 'بروزرسانی: ' + new Date().toLocaleString('fa-IR') + (data.engine ? ' · ' + data.engine : '') + (data.live ? ' · طلا ' + Number(data.live.goldToman).toLocaleString('fa-IR') : '');
    if (data.iliPriceToman && typeof appConfig !== 'undefined') {
      appConfig.iliTomanRate = data.iliPriceToman;
      var pe = document.getElementById('stat-price');
      if (pe) pe.textContent = Number(data.iliPriceToman).toLocaleString('fa-IR') + ' تومان';
    }
  } catch (e) {
    if (g) g.innerHTML = '<span style="color:#f87171">' + (e.message || 'خطا') + '</span>';
    if (u) u.innerHTML = '<span style="color:#f87171">' + (e.message || 'خطا') + '</span>';
  }
};

window.AnalysisPage = {
  timer: null,
  load: function () { return window.loadGoldAnalysis(); },
  start: function () {
    this.load();
    clearInterval(this.timer);
    var self = this;
    this.timer = setInterval(function () { self.load(); }, 20000);
  },
  stop: function () { clearInterval(this.timer); }
};

window.GoldPage = {
  quote: null,
  load: async function () {
    try {
      this.quote = await api('/api/gold/quote');
      var q = this.quote;
      function set(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
      set('gold-price', q.goldPriceToman != null ? Number(q.goldPriceToman).toLocaleString('fa-IR') + ' ت' : '—');
      set('gold-ili-price', q.iliPriceToman != null ? Number(q.iliPriceToman).toLocaleString('fa-IR') + ' ت' : '—');
      set('gold-ili-per-gram', q.iliPerGram != null ? Number(q.iliPerGram).toLocaleString('fa-IR') : '—');
      set('gold-balance', q.goldBalanceGrams != null ? Number(q.goldBalanceGrams).toFixed(6) + ' g' : '0');
    } catch (e) { if (typeof toast === 'function') toast(e.message || 'خطا', 'error'); }
  },
  buy: async function () {
    var el = document.getElementById('gold-buy-ili');
    var iliAmount = Math.floor(Number(el && el.value) || 0);
    if (iliAmount < 10) return toast('حداقل ۱۰ ILI', 'error');
    try {
      var r = await api('/api/gold/buy', { method: 'POST', body: { iliAmount: iliAmount } });
      toast((r.message || 'OK') + ' ' + Number(r.grams).toFixed(6) + 'g', 'success');
      await this.load();
      if (typeof refreshIliPrice === 'function') refreshIliPrice();
    } catch (e) { toast(e.message || 'خطا', 'error'); }
  },
  sell: async function () {
    var el = document.getElementById('gold-sell-grams');
    var grams = Number(el && el.value);
    if (!grams) return toast('گرم را وارد کنید', 'error');
    try {
      var r = await api('/api/gold/sell', { method: 'POST', body: { grams: grams } });
      toast((r.message || 'OK') + ' +' + r.iliReceived + ' ILI', 'success');
      await this.load();
      if (typeof refreshIliPrice === 'function') refreshIliPrice();
    } catch (e) { toast(e.message || 'خطا', 'error'); }
  }
};

document.addEventListener('click', function (e) {
  var t = e.target;
  if (!t || !t.id) {
    if (t && t.closest) {
      var b = t.closest('#mode-gold');
      if (b) { setMode('gold'); return; }
    }
    return;
  }
  if (t.id === 'gtab-analysis') {
    var a = document.getElementById('gold-tab-analysis');
    var tr = document.getElementById('gold-tab-trade');
    if (a) a.style.display = '';
    if (tr) tr.style.display = 'none';
    window.loadGoldAnalysis();
  }
  if (t.id === 'gtab-trade') {
    var a2 = document.getElementById('gold-tab-analysis');
    var tr2 = document.getElementById('gold-tab-trade');
    if (a2) a2.style.display = 'none';
    if (tr2) tr2.style.display = '';
    window.GoldPage.load();
  }
  if (t.id === 'analysis-refresh') window.loadGoldAnalysis();
  if (t.id === 'gold-buy-btn') window.GoldPage.buy();
  if (t.id === 'gold-sell-btn') window.GoldPage.sell();
  if (t.id === 'mode-gold') setMode('gold');
});


// ===== Themes & rich settings options =====
function applyIliTheme(name) {
  const themes = ['midnight', 'emerald', 'rose', 'sand', 'ocean'];
  if (themes.indexOf(name) < 0) name = 'midnight';
  document.body.classList.remove(...themes.map(t => 'theme-' + t));
  document.body.classList.add('theme-' + name);
  localStorage.setItem('ili-theme', name);
  document.querySelectorAll('#theme-options button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-theme') === name);
  });
}

function applyUiOption(key, on) {
  document.body.classList.toggle('ui-' + key, !!on);
  localStorage.setItem('ili-ui-' + key, on ? '1' : '0');
}

document.addEventListener('click', function (e) {
  const t = e.target;
  if (!t) return;
  if (t.closest && t.closest('#theme-options')) {
    const btn = t.closest('button[data-theme]');
    if (btn) applyIliTheme(btn.getAttribute('data-theme'));
  }
  if (t.id === 'opt-refresh-price' && typeof refreshIliPrice === 'function') refreshIliPrice();
  if (t.id === 'opt-open-gold') setMode('gold');
  if (t.id === 'opt-open-analysis') { setMode('gold'); setTimeout(function(){ var b=document.getElementById('gtab-analysis'); if(b)b.click(); }, 50); }
  if (t.id === 'opt-open-news') setMode('news');
  if (t.id === 'opt-open-economy') setMode('economy');
  if (t.id === 'opt-lang-fa') applyLang('fa');
  if (t.id === 'opt-lang-en') applyLang('en');
  if (t.id === 'opt-fullscreen') {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }
  if (t.id === 'opt-compact') applyUiOption('compact', !(localStorage.getItem('ili-ui-compact') === '1'));
  if (t.id === 'opt-large-text') applyUiOption('large-text', !(localStorage.getItem('ili-ui-large-text') === '1'));
  if (t.id === 'opt-reduce-motion') applyUiOption('reduce-motion', !(localStorage.getItem('ili-ui-reduce-motion') === '1'));
  if (t.id === 'opt-sound') {
    const on = !(localStorage.getItem('ili-ui-sound') === '1');
    localStorage.setItem('ili-ui-sound', on ? '1' : '0');
    toast(on ? 'صدای اعلان روشن' : 'صدای اعلان خاموش', 'success');
  }
  if (t.id === 'opt-copy-card') {
    const el = document.getElementById('card-number') || document.querySelector('[data-card-number]');
    const num = el ? el.textContent.replace(/\s/g, '') : (appConfig && appConfig.paymentCard) || '';
    if (num) { navigator.clipboard?.writeText(num); toast('کپی شد', 'success'); }
    else toast('کارتی نیست', 'error');
  }
  if (t.id === 'opt-export') {
    api('/api/transactions').then(function (d) {
      const rows = d.transactions || d || [];
      const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ili-transactions.json';
      a.click();
    }).catch(function (err) { toast(err.message || 'خطا', 'error'); });
  }
});

// restore UI options
['compact','large-text','reduce-motion'].forEach(function (k) {
  if (localStorage.getItem('ili-ui-' + k) === '1') document.body.classList.add('ui-' + k);
});
