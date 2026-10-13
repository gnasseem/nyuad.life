import { useState } from 'react';
import { IconCalendar, IconChevronRight, IconBack } from '../icons';

const WEEK = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const pad = (n: number) => String(n).padStart(2, '0');
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** A small calendar and clock, with the same value shape as datetime-local. */
export function DateTimePicker({ id, value, onChange, min, zone }: { id: string; value: string; onChange(value: string): void; min?: string; zone?: string }) {
  const today = () => zone === 'Abu Dhabi' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : dayKey(new Date());
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const date = new Date(`${value ? value.slice(0, 10) : today()}T12:00`);
    return new Date(date.getFullYear(), date.getMonth(), 1);
  });
  const selected = value.slice(0, 10);
  const hour = value.slice(11, 13) || '18';
  const minute = value.slice(14, 16) || '00';
  const first = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const days = Array.from({ length: first + count }, (_, i) => i < first ? null : i - first + 1);
  const choose = (day: string, nextHour = hour, nextMinute = minute) => onChange(`${day}T${nextHour}:${nextMinute}`);
  const step = (unit: 'hour' | 'minute', amount: number) => {
    const next = new Date(`${selected || today()}T${hour}:${minute}:00`);
    if (unit === 'hour') next.setHours(next.getHours() + amount);
    else next.setMinutes(next.getMinutes() + amount * 5);
    choose(dayKey(next), pad(next.getHours()), pad(next.getMinutes()));
    setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
  };
  const label = value ? new Date(`${value}:00`).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Choose date and time';
  return <div className="date-time-picker">
    <button id={id} type="button" className="input date-time-trigger" onClick={() => setOpen((current) => !current)} aria-expanded={open} aria-controls={`${id}-panel`}>
      <IconCalendar /><span>{label}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div id={`${id}-panel`} className="date-time-panel">
      <div className="date-time-heading">
        <button type="button" className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month"><IconBack /></button>
        <b>{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</b>
        <button type="button" className="icon-btn" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month"><IconChevronRight /></button>
      </div>
      <div className="date-time-calendar" role="group" aria-label="Choose a day">
        {WEEK.map((name) => <span key={name} className="date-time-weekday">{name}</span>)}
        {days.map((day, i) => day === null ? <span key={`blank-${i}`} /> : (() => {
          const key = dayKey(new Date(month.getFullYear(), month.getMonth(), day));
          return <button key={key} type="button" className={key === selected ? 'selected' : ''} disabled={Boolean(min && key < min.slice(0, 10))} onClick={() => choose(key)} aria-pressed={key === selected} aria-label={new Date(`${key}T12:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}>{day}</button>;
        })())}
      </div>
      <div className="date-time-clock">
        <span>Time{zone ? ` · ${zone}` : ''}</span>
        <div className="date-time-clock-controls">
          <div className="date-time-step"><button type="button" onClick={() => step('hour', -1)} aria-label="Previous hour">−</button><b aria-label={`${hour} hours`}>{hour}</b><button type="button" onClick={() => step('hour', 1)} aria-label="Next hour">+</button></div>
          <b>:</b>
          <div className="date-time-step"><button type="button" onClick={() => step('minute', -1)} aria-label="Five minutes earlier">−</button><b aria-label={`${minute} minutes`}>{minute}</b><button type="button" onClick={() => step('minute', 1)} aria-label="Five minutes later">+</button></div>
        </div>
      </div>
      <div className="date-time-actions"><button type="button" className="btn sm" onClick={() => { const day = today(); const date = new Date(`${day}T12:00`); setMonth(new Date(date.getFullYear(), date.getMonth(), 1)); choose(day); }}>Today</button><button type="button" className="btn sm primary" onClick={() => setOpen(false)} disabled={!value || Boolean(min && value < min)}>Done</button></div>
      {min && value && value < min && <p className="date-time-error">Choose a future time.</p>}
    </div>}
  </div>;
}
