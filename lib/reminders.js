// Email reminders to contractors about their outstanding snags.
//
// Each contractor on a job has a setting (jobs/{id}.contractors[].reminders = {freq, day}):
//   off | daily | 2days (every other day) | weekly (on `day`, 0 = Sunday … 6 = Saturday, default Monday)
// Vercel runs GET /api/cron/reminders once a morning (vercel.json → crons). Each run works out who is
// due that day, so nothing needs remembering between runs. Nobody is emailed if nothing is outstanding.
//
// Settings (Vercel → Environment Variables):
//   RESEND_API_KEY   from resend.com (the email service)
//   REMINDER_FROM    e.g. PML Snagging <snagging@pml-snagging.com> — the domain must be verified in Resend
//   CRON_SECRET      any long random text; Vercel sends it with each scheduled run so others can't trigger it
//   REMINDER_REPLY_TO  (optional) where replies go, e.g. austin@planningmanager.co.uk
//   APP_URL          (optional) default https://www.pml-snagging.com/

export const FREQS = { daily: 'Daily', '2days': 'Every 2 days', weekly: 'Weekly' };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const low = s => String(s || '').trim().toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const emailsOf = c => [...new Set([c?.email, ...(c?.people || []).map(p => p.email)].map(low).filter(Boolean))];

// Today's date in the UK (the run happens early morning UTC).
export function ukToday(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long' })
    .formatToParts(now).map(x => [x.type, x.value]));
  const iso = `${p.year}-${p.month}-${p.day}`;
  return { iso, dayNo: Math.round(Date.parse(iso + 'T00:00:00Z') / 864e5), weekday: DAYS.indexOf(p.weekday) };
}
export function isDue(r, today) {
  if (r?.freq === 'daily') return true;
  if (r?.freq === '2days') return today.dayNo % 2 === 0;
  if (r?.freq === 'weekly') return today.weekday === (Number.isInteger(r.day) ? r.day : 1);
  return false;
}

// Their snags that still need work (open or in progress; awaiting sign-off is with PML).
function outstanding(snags, c) {
  return snags.filter(s => s.contractorId === c.id && (s.status === 'open' || s.status === 'progress')).sort((a, b) => (a.no || 0) - (b.no || 0));
}
const sentBack = s => s.status === 'open' && (s.history || []).at(-1)?.action === 'Sent back by PML';
const fmt = iso => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

function emailFor(job, c, list, drawings, today, appUrl) {
  const lvl = Object.fromEntries(drawings.map(d => [d.id, d.level || '']));
  const overdue = list.filter(s => s.due && s.due < today.iso).length, back = list.filter(sentBack).length;
  const link = `${appUrl}#/job/${encodeURIComponent(job.id)}`;
  const n = list.length, snags = `${n} snag${n === 1 ? '' : 's'}`;
  const subject = `${snags} outstanding – ${job.name || 'PML job'}${overdue ? ` (${overdue} overdue)` : ''}`;
  const td = 'padding:7px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top';
  const rows = list.map(s => {
    const late = s.due && s.due < today.iso;
    return `<tr><td style="${td};font-weight:700;white-space:nowrap">S-${String(s.no || 0).padStart(3, '0')}</td>
      <td style="${td}">${esc(s.type || 'Snag')}${sentBack(s) ? '<br><span style="color:#c92a2a;font-weight:700;font-size:12px">↩ Sent back by PML</span>' : ''}${s.desc ? `<br><span style="color:#666;font-size:12px">${esc(s.desc)}</span>` : ''}</td>
      <td style="${td}">${esc([lvl[s.drawingId], s.location].filter(Boolean).join(' – ') || '—')}</td>
      <td style="${td};white-space:nowrap;${late ? 'color:#c92a2a;font-weight:700' : ''}">${fmt(s.due)}${late ? '<br>OVERDUE' : ''}</td>
      <td style="${td};white-space:nowrap">${s.status === 'progress' ? 'In progress' : 'Open'}</td></tr>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div style="font-family:Arial,Helvetica,sans-serif;max-width:680px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0E0602;padding:16px 20px;border-bottom:4px solid #FCBF2A"><span style="color:#fff;font-size:22px;font-weight:800">PML<span style="color:#FCBF2A">.</span></span>
    <span style="color:#FCBF2A;font-size:12px;font-weight:700;letter-spacing:2px;margin-left:8px">SNAGGING</span></div>
  <div style="padding:20px">
    <p style="margin:0 0 6px;font-size:15px">Hello ${esc(c.company || '')},</p>
    <p style="margin:0 0 14px;font-size:15px">You have <b>${snags}</b> outstanding on <b>${esc(job.name || '')}</b>${job.address ? ` (${esc(job.address)})` : ''}.${overdue ? ` <b style="color:#c92a2a">${overdue} ${overdue === 1 ? 'is' : 'are'} overdue.</b>` : ''}${back ? ` ${back} ${back === 1 ? 'has' : 'have'} been sent back by PML.` : ''}</p>
    <p style="margin:0 0 18px"><a href="${esc(link)}" style="background:#FCBF2A;color:#0E0602;font-weight:700;text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block">Open PML Snagging</a></p>
    <table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f1ede5;text-align:left">
      <th style="${td}">No.</th><th style="${td}">Snag</th><th style="${td}">Where</th><th style="${td}">Due</th><th style="${td}">Status</th></tr></thead><tbody>${rows}</tbody></table>
    <p style="margin:18px 0 0;font-size:13px;color:#555">When a snag is put right, open it in the app, add a photo of the fix and tap <b>Mark completed</b> so PML can sign it off.</p>
  </div>
  <div style="padding:12px 20px;font-size:11px;color:#888;border-top:1px solid #eee">PML Fire Protection · Building Confidence. You're getting this because you're listed as a contractor on this job${job.ref ? ` (${esc(job.ref)})` : ''}. To change how often, contact PML.</div></div></body></html>`;
  const text = `You have ${snags} outstanding on ${job.name || ''}.\n\n` + list.map(s =>
    `S-${String(s.no || 0).padStart(3, '0')}  ${s.type || 'Snag'}  –  ${[lvl[s.drawingId], s.location].filter(Boolean).join(' – ') || '—'}  –  due ${fmt(s.due)}${s.due && s.due < today.iso ? ' (OVERDUE)' : ''}${sentBack(s) ? '  [sent back by PML]' : ''}`).join('\n') + `\n\nOpen PML Snagging: ${link}\n`;
  return { subject, html, text };
}

async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY || !env.REMINDER_FROM) throw Object.assign(new Error('Email isn\'t set up yet (RESEND_API_KEY and REMINDER_FROM in Vercel).'), { status: 503, code: 'no-email' });
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.REMINDER_FROM, to, subject, html, text, ...(env.REMINDER_REPLY_TO ? { reply_to: env.REMINDER_REPLY_TO } : {}) })
  });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error('Email service: ' + (j.message || r.status)), { status: 502, code: 'email-failed' }); }
}

// Sends one contractor their reminder now. → {status:'sent', to, count} | {status:'nothing-outstanding'|'no-email-address'}
export async function remind(env, store, job, c, today = ukToday()) {
  const to = emailsOf(c);
  if (!to.length) return { status: 'no-email-address' };
  const list = outstanding(await store.jobRows('snags', job.id), c);
  if (!list.length) return { status: 'nothing-outstanding' };
  const appUrl = (env.APP_URL || 'https://www.pml-snagging.com/').replace(/\/?$/, '/');
  await sendEmail(env, { to, ...emailFor(job, c, list, await store.jobRows('drawings', job.id), today, appUrl) });
  return { status: 'sent', to, count: list.length };
}

// The morning run: everyone whose reminder is due today, on jobs that aren't completed.
export async function runReminders(env, store, now = new Date()) {
  const today = ukToday(now), out = { date: today.iso, sent: [], skipped: [], failed: [] };
  for (const job of await store.allJobs()) {
    if (job.status === 'completed') continue;
    for (const c of job.contractors || []) {
      if (!isDue(c.reminders, today)) continue;
      const who = `${job.name} / ${c.company}`;
      try { const r = await remind(env, store, job, c, today); (r.status === 'sent' ? out.sent : out.skipped).push({ who, ...r }); }
      catch (e) { out.failed.push({ who, error: e.message }); }
    }
  }
  console.log('reminders', JSON.stringify(out));
  return out;
}
