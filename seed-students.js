import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { MONGO_URI } from './server/config.js';
import Student from './server/models/Student.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function parseCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i], next = text[i+1];
    if (quoted) {
      if (ch === '"' && next === '"') { row.push(value + '"'); value = ''; i += 2; }
      else if (ch === '"') { quoted = false; i++; }
      else { value += ch; i++; }
    } else if (ch === '"') { quoted = true; i++; }
    else if (ch === ',') { row.push(value.trim()); value = ''; i++; }
    else if (ch === '\n') { row.push(value.trim()); rows.push([...row]); row.length = 0; value = ''; i++; }
    else if (ch !== '\r') { value += ch; i++; }
    else i++;
  }
  if (value) { row.push(value.trim()); rows.push([...row]); }
  return rows;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return null;
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  return new Date(Number(m[3]), months[m[2].slice(0, 3).toLowerCase()], Number(m[1]), 9, 0, 0);
}

async function run() {
  await mongoose.connect(MONGO_URI);
  const csv25Path = path.join(dataDir, 'students-start-on-or-before-2026-05-25.csv');
  const csv22Path = path.join(dataDir, 'students-start-on-or-before-2026-05-22.csv');
  const excusedPath = path.join(dataDir, 'excused-emails.txt');
  const excusedSet = new Set(fs.readFileSync(excusedPath, 'utf8').trim().split('\n').filter(Boolean).map(normalizeEmail));
  const rows25 = parseCsv(fs.readFileSync(csv25Path, 'utf8').replace(/^\uFEFF/, ''));
  const activeStudents = rows25.slice(1).filter(r => normalizeEmail(r[1])).map(r => ({
    name: String(r[0] || '').trim() || normalizeEmail(r[1]),
    email: normalizeEmail(r[1]),
    alternateEmail: normalizeEmail(r[2]) || '',
    internshipStartDate: parseDate(r[3]) || new Date('2026-05-15T09:00:00'),
    internshipEndDate: parseDate(r[4]) || null,
    status: 'active',
    totalSp: 100
  }));
  const rows22 = parseCsv(fs.readFileSync(csv22Path, 'utf8').replace(/^\uFEFF/, ''));
  const excusedStudents = rows22.slice(1).filter(r => excusedSet.has(normalizeEmail(r[1]))).map(r => ({
    name: String(r[0] || '').trim() || normalizeEmail(r[1]),
    email: normalizeEmail(r[1]),
    alternateEmail: normalizeEmail(r[2]) || '',
    internshipStartDate: parseDate(r[3]) || new Date('2026-05-15T09:00:00'),
    internshipEndDate: parseDate(r[4]) || null,
    status: 'excused',
    totalSp: 100
  }));
  console.log('Active:', activeStudents.length, 'Excused:', excusedStudents.length);
  await Student.deleteMany({});
  await Student.insertMany([...activeStudents, ...excusedStudents]);
  const total = await Student.countDocuments();
  const active = await Student.countDocuments({ status: 'active' });
  const exc = await Student.countDocuments({ status: 'excused' });
  console.log('DB Total:', total, 'Active:', active, 'Excused:', exc);
  await mongoose.disconnect();
}
run().catch(async err => { console.error(err); await mongoose.disconnect(); process.exit(1); });
