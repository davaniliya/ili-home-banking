
'use strict';

function gaEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

window.GoldPage = window.GoldPage || {};
const GoldPage = window.GoldPage = {
  quote: null,
  async load() {
    try {
      this.quote = await api('/api/gold/quote');
      const q = this.quote;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('gold-price', q.goldPriceToman != null ? Number(q.goldPriceToman).toLocaleString('fa-IR') + ' تومان' : '—');
      set('gold-ili-price', q.iliPriceToman != null ? Number(q.iliPriceToman).toLocaleString('fa-IR') + ' تومان' : '—');
      set('gold-ili-per-gram', q.iliPerGram != null ? Number(q.iliPerGram).toLocaleString('fa-IR') + ' ILI' : '—');
      set('gold-balance', q.goldBalanceGrams != null ? Number(q.goldBalanceGrams).toFixed(6) + ' g' : '0');
      this.preview();
      await this.history();
    } catch (e) {
      console.error(e);
      if (typeof toast === 'function') toast(e.message || 'خطا در طلا', 'error');
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('gold-price', 'خطا');
      set('gold-ili-price', '—');
    }
  },
  preview() {
    const el = document.getElementById('gold-buy-preview');
    if (!el || !this.quote) return;
    const ili = Math.floor(Number(document.getElementById('gold-buy-ili')?.value) || 0);
    if (ili < 10 || !this.quote.iliPerGram) {
      el.textContent = 'حداقل ۱۰ ILI وارد کنید';
      return;
    }
    const grams = ili / this.quote.iliPerGram;
    el.textContent = '≈ ' + grams.toFixed(6) + ' گرم طلا (هر گرم ' + Number(this.quote.iliPerGram).toLocaleString('fa-IR') + ' ILI)';
  },
  async buy() {
    const iliAmount = Math.floor(Number(document.getElementById('gold-buy-ili')?.value) || 0);
    if (iliAmount < 10) return toast('حداقل خرید ۱۰ ILI است', 'error');
    try {
      const r = await api('/api/gold/buy', { method: 'POST', body: { iliAmount } });
      toast((r.message || 'خرید شد') + ' · ' + Number(r.grams).toFixed(6) + ' g', 'success');
      document.getElementById('gold-buy-ili').value = '';
      await this.load();
      if (typeof refreshIliPrice === 'function') await refreshIliPrice();
    } catch (e) {
      toast(e.message || 'خرید ناموفق', 'error');
    }
  },
  async sell() {
    const grams = Number(document.getElementById('gold-sell-grams')?.value);
    if (!grams || grams <= 0) return toast('مقدار گرم را وارد کنید', 'error');
    try {
      const r = await api('/api/gold/sell', { method: 'POST', body: { grams } });
      toast((r.message || 'فروش شد') + ' · +' + r.iliReceived + ' ILI', 'success');
      document.getElementById('gold-sell-grams').value = '';
      await this.load();
      if (typeof refreshIliPrice === 'function') await refreshIliPrice();
    } catch (e) {
      toast(e.message || 'فروش ناموفق', 'error');
    }
  },
  async history() {
    const box = document.getElementById('gold-history');
    if (!box) return;
    try {
      const d = await api('/api/gold/history');
      const rows = d.trades || [];
      if (!rows.length) {
        box.innerHTML = '<div class="empty-state">معامله‌ای ثبت نشده</div>';
        return;
      }
      box.innerHTML = rows.map(t =>
        '<div class="tx-item"><div><strong>' + (t.side === 'BUY' ? 'خرید' : 'فروش') +
        '</strong> · ' + Number(t.grams).toFixed(6) + ' g</div><div>' +
        Number(t.ili_amount).toLocaleString('fa-IR') + ' ILI</div><small>' +
        gaEscape(t.created_at || '') + '</small></div>'
      ).join('');
    } catch (e) {
      box.innerHTML = '<div class="empty-state">—</div>';
    }
  }
};

window.AnalysisPage = window.AnalysisPage || {};
const AnalysisPage = window.AnalysisPage = {
  timer: null,
  async load() {
    const g = document.getElementById('analysis-gold');
    const u = document.getElementById('analysis-usd');
    if (g) g.innerHTML = '<span class="hint">در حال دریافت داده از tgju…</span>';
    if (u) u.innerHTML = '<span class="hint">در حال دریافت داده از tgju…</span>';
    try {
      const data = await api('/api/analysis/markets');
      if (g) g.innerHTML = this.renderBlock(data.gold);
      if (u) u.innerHTML = this.renderBlock(data.usd);
      const up = document.getElementById('analysis-updated');
      if (up) up.textContent = 'آخرین بروزرسانی: ' + new Date().toLocaleString('fa-IR');
      // show current ILI price impact line if present
      if (data.iliPriceToman != null && typeof appConfig !== 'undefined') {
        appConfig.iliTomanRate = data.iliPriceToman;
        const pe = document.getElementById('stat-price');
        if (pe) pe.textContent = Number(data.iliPriceToman).toLocaleString('fa-IR') + ' تومان';
      }
    } catch (e) {
      console.error(e);
      const msg = gaEscape(e.message || 'خطا در دریافت تحلیل');
      if (g) g.innerHTML = '<div style="color:#f87171">' + msg + '</div><p class="hint">اینترنت سیستم میزبان و لاگین بودن را بررسی کنید.</p>';
      if (u) u.innerHTML = '<div style="color:#f87171">' + msg + '</div>';
    }
  },
  renderBlock(a) {
    if (!a) return '—';
    const color = a.signal === 'BUY' ? '#22c55e' : a.signal === 'SELL' ? '#ef4444' : '#94a3b8';
    const ind = a.indicators || {};
    const plan = a.profitPlan || {};
    const reasons = (a.reasons || []).map(r => '<li>' + gaEscape(r) + '</li>').join('');
    return (
      '<div style="font-size:1.45rem;font-weight:800;color:' + color + ';margin:8px 0;">' +
      gaEscape(a.signalFa || a.signal) + ' · اطمینان ' + (a.confidence || 0) + '٪</div>' +
      '<div>قیمت: <strong>' + (a.price != null ? Number(a.price).toLocaleString('fa-IR') : '—') +
      ' تومان</strong> <span style="color:' + ((a.changePct||0)>=0?'#22c55e':'#ef4444') + '">(' +
      (a.changePct || 0) + '٪)</span></div>' +
      '<div class="hint" style="margin-top:8px;">RSI: ' + (ind.rsi14 ?? '—') +
      ' · SMA۷: ' + (ind.sma7 ?? '—') + ' · SMA۲۱: ' + (ind.sma21 ?? '—') + '</div>' +
      '<div class="hint">EMA۹: ' + (ind.ema9 ?? '—') + ' · EMA۲۱: ' + (ind.ema21 ?? '—') +
      ' · MACD: ' + (ind.macd ?? '—') + '</div>' +
      '<div class="hint">بولینگر: ' + (ind.bbLower ?? '—') + ' / ' + (ind.bbMid ?? '—') + ' / ' + (ind.bbUpper ?? '—') + '</div>' +
      '<hr style="border-color:rgba(255,255,255,0.08);margin:12px 0;">' +
      '<div><strong>برنامه معاملاتی</strong></div>' +
      '<div>ورود: ' + (plan.entry != null ? Number(plan.entry).toLocaleString('fa-IR') : '—') + ' ت</div>' +
      '<div>حد سود: ' + (plan.takeProfit != null ? Number(plan.takeProfit).toLocaleString('fa-IR') : '—') + ' ت</div>' +
      '<div>حد ضرر: ' + (plan.stopLoss != null ? Number(plan.stopLoss).toLocaleString('fa-IR') : '—') + ' ت</div>' +
      '<div>سود مورد انتظار: <strong>' + (plan.expectedProfitPercent ?? 0) + '٪</strong></div>' +
      '<div class="hint">سود تقریبی روی ۱۰۰ میلیون تومان: ' +
      (plan.expectedProfitOn100MToman != null ? Number(plan.expectedProfitOn100MToman).toLocaleString('fa-IR') : '—') +
      ' تومان</div>' +
      '<p class="hint">' + gaEscape(plan.note || '') + '</p>' +
      '<ul style="margin:8px 0 0 18px;color:#94a3b8;font-size:0.85rem;">' + reasons + '</ul>'
    );
  },
  start() {
    this.load();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.load(), 30000);
  },
  stop() {
    clearInterval(this.timer);
  }
};

// Tabs inside Gold mode
document.querySelectorAll('.gold-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.gold-tab').forEach(b => {
      b.classList.remove('active');
      b.classList.remove('btn-primary');
      b.classList.add('btn-secondary');
    });
    btn.classList.add('active');
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-secondary');
    const tab = btn.getAttribute('data-gtab');
    const a = document.getElementById('gold-tab-analysis');
    const t = document.getElementById('gold-tab-trade');
    if (tab === 'trade') {
      if (a) a.classList.add('hidden');
      if (t) t.classList.remove('hidden');
      GoldPage.load();
    } else {
      if (t) t.classList.add('hidden');
      if (a) a.classList.remove('hidden');
      AnalysisPage.load();
    }
  });
});

document.getElementById('gold-buy-ili')?.addEventListener('input', () => GoldPage.preview());
document.getElementById('gold-buy-btn')?.addEventListener('click', () => GoldPage.buy());
document.getElementById('gold-sell-btn')?.addEventListener('click', () => GoldPage.sell());
document.getElementById('analysis-refresh')?.addEventListener('click', () => AnalysisPage.load());
