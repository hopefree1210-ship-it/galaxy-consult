import { DatabaseSync } from 'node:sqlite'; // Node 내장 SQLite (별도 설치·컴파일 불필요)
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CFG } from './logic.js';

const file = process.env.DB_FILE || './data/galaxy.db';
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
create table if not exists cases(id text primary key, secret_hash text not null, created_at integer not null, last_at integer not null,
  status text not null default 'new', unread_staff integer not null default 0, unread_patient integer not null default 0, data text not null);
create index if not exists cases_last on cases(last_at desc);
create table if not exists messages(id integer primary key autoincrement, case_id text not null, at integer not null, data text not null);
create index if not exists msg_case on messages(case_id, at);
create table if not exists config(key text primary key, value text not null);
create table if not exists ig_contacts(igsid text primary key, first_at integer not null, last_reply_at integer not null, last_notify_at integer not null default 0);
`);

const q = {
  getCase: db.prepare('select * from cases where id=?'),
  insCase: db.prepare('insert into cases(id,secret_hash,created_at,last_at,status,unread_staff,unread_patient,data) values(?,?,?,?,?,?,?,?)'),
  updCase: db.prepare('update cases set last_at=?,status=?,unread_staff=?,unread_patient=?,data=? where id=?'),
  list: db.prepare('select * from cases order by last_at desc limit 500'),
  insMsg: db.prepare('insert into messages(case_id,at,data) values(?,?,?)'),
  msgs: db.prepare('select id,data from messages where case_id=? order by at,id'),
};
const toCase = (r, withPhotos = true) => {
  const d = JSON.parse(r.data);
  if (!withPhotos) { d.photoCount = (d.photos || []).length; delete d.photos; }
  return { id: r.id, createdAt: r.created_at, lastAt: r.last_at, status: r.status, unreadStaff: !!r.unread_staff, unreadPatient: !!r.unread_patient, ...d };
};
const split = c => {
  const { id, createdAt, lastAt, status, unreadStaff, unreadPatient, ...data } = c;
  return { data: JSON.stringify(data) };
};
export const cases = {
  raw: id => q.getCase.get(id),
  get: (id, withPhotos = true) => { const r = q.getCase.get(id); return r ? toCase(r, withPhotos) : null; },
  list: () => q.list.all().map(r => toCase(r, false)),
  insert(c, secretHash) { q.insCase.run(c.id, secretHash, c.createdAt, c.lastAt, c.status, c.unreadStaff ? 1 : 0, c.unreadPatient ? 1 : 0, split(c).data); },
  save(c) { q.updCase.run(c.lastAt, c.status, c.unreadStaff ? 1 : 0, c.unreadPatient ? 1 : 0, split(c).data, c.id); },
};
export const messages = {
  add(caseId, m) { q.insMsg.run(caseId, m.at, JSON.stringify(m)); },
  list: caseId => q.msgs.all(caseId).map(r => ({ id: r.id, ...JSON.parse(r.data) })),
};
export const getCfg = () => {
  const r = db.prepare("select value from config where key='main'").get();
  return r ? JSON.parse(r.value) : DEFAULT_CFG;
};
export const setCfg = c => db.prepare("insert into config(key,value) values('main',?) on conflict(key) do update set value=excluded.value").run(JSON.stringify(c));
